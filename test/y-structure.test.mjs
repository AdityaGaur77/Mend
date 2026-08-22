import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  normalizeRcsbStructures,
  retrieveRcsbStructures,
  runYAxis,
  summarizeStructureRecords,
  validateStructureRecords,
} from '../src/axes/y/structure.mjs';

const fixtureUrl = new URL('../fixtures/xyz/y-structure-rcsb.json', import.meta.url);
const loadedFixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const retrievedAt = '2026-08-22T18:00:00.000Z';

test('Y axis normalizes RCSB entries to canonical evidence without inferring disease relevance', () => {
  const records = normalizeRcsbStructures(loadedFixture, { retrievedAt });
  assert.equal(records.length, 3);
  assert.deepEqual(records[0], {
    axis: 'Y',
    subject: 'SERPINA1 / Alpha-1 antitrypsin',
    value: '1QLP',
    source_url: 'https://www.rcsb.org/structure/1QLP',
    retrieved_at: retrievedAt,
    evidence: 'RCSB PDB entry 1QLP, reports experimental method X-RAY DIFFRACTION, at 2 Å resolution, titled “Structure of alpha-1-antitrypsin”.',
    structure_id: '1QLP',
    target: 'SERPINA1 / Alpha-1 antitrypsin',
    experimental_method: 'X-RAY DIFFRACTION',
    resolution_angstrom: 2,
    organisms: ['Homo sapiens'],
    ligands: [],
    sample_state_description: 'Structure of alpha-1-antitrypsin',
    disease_relevance: null,
  });
  assert.equal(records[1].ligands[0].id, 'GOL');
  assert.ok(records.every((record) => record.disease_relevance === null));
});

test('Y axis summary reports count, method mix, and best available resolution', () => {
  const records = normalizeRcsbStructures(loadedFixture, { retrievedAt });
  assert.deepEqual(summarizeStructureRecords(records), {
    experimental_structures: 3,
    methods: { 'X-RAY DIFFRACTION': 3 },
    cryo_em_structures: 0,
    best_resolution_angstrom: 1.83,
    disease_relevance: null,
    disease_relevance_note: 'Not inferred from target identity or structure availability.',
  });
});

test('Y axis validator reports invalid identifiers, methods, resolutions, and sources', () => {
  const [validRecord] = normalizeRcsbStructures(loadedFixture, { retrievedAt });
  assert.equal(validateStructureRecords([validRecord]).valid, true);

  const validation = validateStructureRecords([{ ...validRecord,
    structure_id: 'bad-id',
    experimental_method: null,
    resolution_angstrom: -1,
    source_url: 'https://example.com/not-rcsb',
    evidence: '',
  }]);
  assert.equal(validation.valid, false);
  assert.deepEqual(validation.errors.map((error) => error.field), [
    'structure_id', 'experimental_method', 'resolution_angstrom', 'source_url', 'evidence',
  ]);
  assert.equal(validateStructureRecords([]).valid, false);
});

test('Y axis runner exposes the shared orchestration contract for fixture execution', async () => {
  const result = await runYAxis({ fixture: loadedFixture, retrievedAt });
  assert.equal(result.axis, 'Y');
  assert.equal(result.records.length, 3);
  assert.equal(result.summary.best_resolution_angstrom, 1.83);
  assert.deepEqual(result.validation, { valid: true, record_count: 3, errors: [] });
});

test('RCSB retrieval is bounded and supports an injected fetch implementation', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (calls.length === 1) return { ok: true, status: 200, json: async () => ({
      result_set: [{ identifier: '1qlp' }, { identifier: '1QLP' }, { identifier: '7API' }],
    }) };
    return { ok: true, status: 200, json: async () => loadedFixture };
  };

  const result = await retrieveRcsbStructures({ fetchImpl, maxEntries: 2 });
  assert.equal(result, loadedFixture);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.request_options.paginate.rows, 2);
  assert.deepEqual(calls[1].body.variables.ids, ['1QLP', '7API']);
  await assert.rejects(() => retrieveRcsbStructures({ fetchImpl, maxEntries: 101 }), /between 1 and 100/);
});
