import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvidence } from '../src/mend/evidence.mjs';
import { healthySnapshot, runVerticalSlice } from '../src/mend/vertical-slice.mjs';

function record(axis, value) {
  return createEvidence({
    axis,
    subject: axis === 'X' ? 'SERPINA1 program' : 'SERPINA1',
    value,
    source_url: `https://example.test/${axis.toLowerCase()}/${value}`,
    retrieved_at: '2026-08-22T00:00:00.000Z',
    evidence: `${axis} evidence for ${value}`,
  });
}

function runners() {
  return {
    X: async ({ mode }) => {
      if (mode === 'broken') throw new Error('record count collapsed from 8 to 0');
      return { records: [record('X', mode === 'repaired' ? 'recovered-program' : 'program')], summary: { programs: 1 }, validation: { status: 'PASS' } };
    },
    Y: async () => ({ records: [record('Y', 'structure')], summary: { structures: 1 }, validation: { status: 'PASS' } }),
    Z: async () => ({ records: [record('Z', 'patent')], summary: { patents: 1 }, validation: { status: 'PASS' } }),
  };
}

test('evidence contract rejects unsupported or untraceable claims', () => {
  assert.throws(() => createEvidence({ axis: 'Y', subject: 'SERPINA1', value: 'druggable', source_url: '', evidence: '' }), /source_url/);
  assert.throws(() => createEvidence({ axis: 'Q', subject: 'SERPINA1', value: 'claim', source_url: 'https://example.test', evidence: 'text' }), /X, Y, or Z/);
});

test('healthy X/Y/Z run publishes an evidence-backed target view', async () => {
  const run = await runVerticalSlice({ axisRunners: runners(), runId: 'healthy', factoryVersion: 'v1' });
  assert.equal(run.status, 'HEALTHY');
  assert.equal(run.publishStatus, 'PUBLISHED');
  assert.deepEqual(run.failedAxes, []);
  assert.deepEqual(Object.keys(healthySnapshot(run)), ['X', 'Y', 'Z']);
});

test('broken X is quarantined while previous healthy X and current Y/Z remain available', async () => {
  const first = await runVerticalSlice({ axisRunners: runners(), runId: 'v1-healthy', factoryVersion: 'v1' });
  const broken = await runVerticalSlice({
    axisRunners: runners(),
    mode: 'break-x',
    previousHealthy: healthySnapshot(first),
    runId: 'v1-broken',
    factoryVersion: 'v1',
  });
  assert.equal(broken.status, 'DEGRADED');
  assert.equal(broken.publishStatus, 'PRESERVED_PREVIOUS_HEALTHY');
  assert.deepEqual(broken.failedAxes, ['X']);
  assert.equal(broken.axes.X.status, 'STALE_HEALTHY');
  assert.equal(broken.axes.Y.status, 'HEALTHY');
  assert.equal(broken.axes.Z.status, 'HEALTHY');
  assert.match(broken.axes.X.quarantine.reason, /8 to 0/);
});

test('approved v2 repair restores all axes to healthy', async () => {
  const recovered = await runVerticalSlice({ axisRunners: runners(), mode: 'repaired', runId: 'v2-recovered', factoryVersion: 'v2' });
  assert.equal(recovered.status, 'HEALTHY');
  assert.equal(recovered.factoryVersion, 'v2');
  assert.equal(recovered.axes.X.records[0].value, 'recovered-program');
});
