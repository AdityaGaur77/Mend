import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  assertNoUnsupportedFtoClaim,
  normalizeIpActivityRecords,
  runZAxis,
  summarizeIpActivity,
  validateIpActivityRecords,
} from '../src/axes/z-ip-activity.mjs';

const fixtureUrl = new URL('../fixtures/xyz/z-ip-serpina1.json', import.meta.url);
const fixedNow = new Date('2026-08-22T12:00:00.000Z');

async function fixtureRetrieve(query) {
  assert.deepEqual(query, { disease: 'Alpha-1 Antitrypsin Deficiency', target: 'SERPINA1' });
  return JSON.parse(await readFile(fixtureUrl, 'utf8'));
}

test('runZAxis retrieves, normalizes, validates, and summarizes fixture publications', async () => {
  const result = await runZAxis({
    retrieve: fixtureRetrieve,
    sourceName: 'fixture-patent-source',
    clock: () => fixedNow,
  });

  assert.equal(result.axis, 'Z');
  assert.equal(result.validation.status, 'PASS');
  assert.equal(result.records.length, 3);
  assert.equal(result.summary.relevant_records, 3);
  assert.equal(result.summary.known_assignees, 2);
  assert.equal(result.summary.recent_activity, 2);
  assert.equal(result.summary.evidence_record_ids.length, 3);
  assert.equal(result.records[2].assignee, null, 'missing assignee remains unknown rather than inferred');
  assert.equal(result.records[0].axis, 'Z');
  assert.equal(result.records[0].subject, 'SERPINA1 / Alpha-1 Antitrypsin Deficiency');
  assert.equal(result.records[0].retrieved_at, fixedNow.toISOString());
});
test('normalizer accepts common source field aliases behind the adapter boundary', () => {
  const [record] = normalizeIpActivityRecords([{
    publicationNumber: 'WO2025123456A1',
    applicant: 'Example Applicant',
    date: '2025-06-26',
    terms: 'SERPINA1',
    url: 'https://patents.example.invalid/WO2025123456A1',
    snippet: 'The source mentions SERPINA1.',
  }], { retrievedAt: fixedNow.toISOString() });

  assert.equal(record.publication_identifier, 'WO2025123456A1');
  assert.equal(record.assignee, 'Example Applicant');
  assert.deepEqual(record.target_terms, ['SERPINA1']);
});

test('validation requires publication identity, source, and evidence but not assignee', () => {
  const base = {
    axis: 'Z',
    publication_identifier: 'EP3000000A1',
    source_url: 'https://patents.example.invalid/EP3000000A1',
    source_name: 'test-source',
    evidence: 'SERPINA1 appears in the publication metadata.',
    assignee: null,
  };

  assert.equal(validateIpActivityRecords([base]).status, 'PASS');
  assert.throws(() => validateIpActivityRecords([{ ...base, publication_identifier: null }]), /publication identifier/);
  assert.throws(() => validateIpActivityRecords([{ ...base, source_url: null }]), /source URL/);
  assert.throws(() => validateIpActivityRecords([{ ...base, assignee: '   ' }]), /assignee/);
});

test('summary is an evidence-linked activity signal and never an unsupported FTO claim', () => {
  const records = normalizeIpActivityRecords([{
    id: 'US20240000001A1',
    url: 'https://patents.example.invalid/US20240000001A1',
    publication_date: '2024-01-04',
    evidence: 'The source mentions SERPINA1.',
  }], { retrievedAt: fixedNow.toISOString() });
  const summary = summarizeIpActivity(records, { now: fixedNow });

  assert.equal(summary.label, 'Z — IP ACTIVITY');
  assert.equal(summary.legal_conclusion, null);
  assert.match(summary.disclaimer, /not legal advice/i);
  assert.doesNotMatch(JSON.stringify(summary), /freedom\s+to\s+operate|\bFTO\b/i);
  assert.throws(
    () => assertNoUnsupportedFtoClaim('This analysis establishes freedom to operate.'),
    /unsupported legal\/FTO conclusion/,
  );
});

test('runner rejects invalid retrieval contracts and empty source results', async () => {
  await assert.rejects(() => runZAxis({ retrieve: async () => ({ unexpected: [] }) }), /must return/);
  await assert.rejects(() => runZAxis({ retrieve: async () => [] }), /returned no records/);
});
