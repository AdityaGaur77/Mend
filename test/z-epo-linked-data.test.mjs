import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEpoIpActivityQuery, createEpoLinkedDataRetriever, normalizeEpoBindings } from '../src/axes/z/epo-linked-data.mjs';
import { runZAxis } from '../src/axes/z-ip-activity.mjs';

const response = {
  results: { bindings: [{
    publication: { value: 'http://data.epo.org/linked-data/id/publication/EP/1234567/A1/-' },
    title: { value: 'SERPINA1 MODULATORS' },
    abstract: { value: 'A publication mentioning alpha-1 antitrypsin.' },
    date: { value: '2025-01-02' },
    applicant: { value: 'Example Applicant' },
  }] },
};

test('EPO query is bounded and includes configured SERPINA1/AATD terms', () => {
  const query = buildEpoIpActivityQuery({ target: 'SERPINA1', disease: 'Alpha-1 Antitrypsin Deficiency', limit: 10 });
  assert.match(query, /serpina1/i);
  assert.match(query, /alpha-1 antitrypsin deficiency/i);
  assert.match(query, /LIMIT 10/);
  assert.throws(() => buildEpoIpActivityQuery({ limit: 51 }), /between 1 and 50/);
});

test('EPO bindings normalize to the source-agnostic Z adapter contract', () => {
  const [record] = normalizeEpoBindings(response, { target: 'SERPINA1', disease: 'AATD' });
  assert.equal(record.publication_identifier, 'EP1234567A1');
  assert.equal(record.source_url, 'https://data.epo.org/linked-data/id/publication/EP/1234567/A1/-');
  assert.equal(record.assignee, 'Example Applicant');
  assert.match(record.evidence, /SERPINA1/);
});

test('injected EPO retrieval runs through defensive IP Activity validation', async () => {
  let request;
  const retrieve = createEpoLinkedDataRetriever({ fetchImpl: async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => response };
  } });
  const result = await runZAxis({ retrieve, clock: () => new Date('2026-08-22T00:00:00.000Z') });
  assert.equal(result.validation.status, 'PASS');
  assert.equal(result.summary.legal_conclusion, null);
  assert.equal(result.records[0].source_name, 'European Patent Office Linked Open EP Data');
  assert.equal(request.options.method, 'POST');
  assert.match(String(request.options.body), /SERPINA1/i);
});
