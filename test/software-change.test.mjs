import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decideSoftwareChange,
  deploySoftwareChange,
  proposeSoftwareChange,
  repairBriefFromFailure,
} from '../src/mend/software-change.mjs';

function proposal(kind = 'BUILD') {
  return proposeSoftwareChange({
    kind,
    brief: kind === 'BUILD' ? 'Build X/Y/Z for SERPINA1/AATD' : 'Repair X pipeline extraction',
    author: 'mend-agent',
    changedFiles: ['src/axes/x-pipeline.mjs', 'test/x-pipeline.test.mjs'],
    gitRef: kind === 'BUILD' ? 'commit-v1' : 'commit-v2',
    verification: { status: 'PASS', tests: 12 },
    changeId: kind === 'BUILD' ? 'change-v1' : 'repair-v2',
  });
}

test('verified change requires a different human actor before deployment', () => {
  const change = proposal();
  assert.equal(change.state, 'AWAITING_APPROVAL');
  assert.throws(() => decideSoftwareChange(change, { decision: 'APPROVE', actor: 'mend-agent', reason: 'self approval' }), /cannot approve/);
  assert.throws(() => deploySoftwareChange(change, { factoryVersion: 'v1' }), /only an approved/);

  const approved = decideSoftwareChange(change, { decision: 'APPROVE', actor: 'analyst', reason: 'tests and diff reviewed' });
  const deployed = deploySoftwareChange(approved, { factoryVersion: 'v1' });
  assert.equal(deployed.state, 'DEPLOYED');
  assert.equal(deployed.deployment.factoryVersion, 'v1');
  assert.equal(deployed.deployment.gitRef, 'commit-v1');
});

test('rejection leaves a software change undeployable', () => {
  const rejected = decideSoftwareChange(proposal(), { decision: 'REJECT', actor: 'analyst', reason: 'evidence incomplete' });
  assert.equal(rejected.state, 'REJECTED');
  assert.throws(() => deploySoftwareChange(rejected, { factoryVersion: 'v1' }), /only an approved/);
});

test('failed X validation becomes a bounded repair brief', () => {
  const repair = repairBriefFromFailure({
    run: { runId: 'run-broken', factoryVersion: 'v1' },
    validation: { axis: 'X', status: 'FAIL', previousCount: 8, currentCount: 0, reason: 'record-count collapse' },
    activeIntegration: 'src/axes/x-pipeline.mjs',
  });
  assert.equal(repair.affectedAxis, 'X');
  assert.equal(repair.previousHealthyCount, 8);
  assert.equal(repair.currentCount, 0);
  assert.ok(repair.requiredArtifacts.includes('regression test'));
});

test('unverified software cannot enter human review', () => {
  assert.throws(() => proposeSoftwareChange({
    brief: 'Build', author: 'agent', changedFiles: ['file'], gitRef: 'commit', verification: { status: 'FAIL' },
  }), /verification must pass/);
});
