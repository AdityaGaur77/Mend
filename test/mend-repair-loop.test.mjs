// The loop, end to end, including the outcomes that are not a successful repair.
//
// A self-healing system is easy to demonstrate on the path where it heals. What decides
// whether it can be trusted is what it does on the other four: when the reviewer says
// no, when the signals are ambiguous, when the page is simply down, and when the repair
// is applied and the re-measurement still does not clear the bar. All five are here.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadRecordSchema } from '../src/axes/x-meridian.mjs';
import { runRepairLoop } from '../src/mend/repair-loop.mjs';
import { createScraperRegistry } from '../src/mend/scraper-registry.mjs';
import { BASELINE_PLAN } from '../src/mend/selector-plan.mjs';
import { loadChangeRequestSchema } from '../src/mend/change-request.mjs';
import { readFile } from 'node:fs/promises';

import { validate } from '../mend/src/validate.mjs';

const schema = await loadRecordSchema();
const changeRequestSchema = await loadChangeRequestSchema();

// A fixed clock so mttr_seconds is a stated number rather than whatever the machine
// happened to take. The loop stamps six times between detection and the verified re-run
// (detect, heal, propose, decide, deploy, verify), so at 15s a tick that is 90 seconds.
function clockFrom(start, stepSeconds = 15) {
  let tick = 0;
  return () => new Date(Date.parse(start) + tick++ * stepSeconds * 1000);
}

const loop = (overrides = {}) =>
  runRepairLoop({
    registry: createScraperRegistry(),
    schema,
    now: clockFrom('2026-08-22T12:00:00.000Z'),
    ...overrides,
  });

// Top-level await: describe() callbacks are synchronous, so the run happens here and
// the assertions below read its result.
const result = await loop();

describe('the repair path', () => {

  test('the factory repairs and the dataset is released', () => {
    assert.equal(result.status, 'REPAIRED');
    assert.equal(result.publish, 'PUBLISHED');
  });

  test('the run goes baseline -> detect -> diagnose -> propose -> deploy -> verify', () => {
    assert.deepEqual(result.steps.map((step) => step.step), [
      'baseline', 'detect', 'diagnose', 'propose', 'deploy', 'verify',
    ]);
  });

  test('detection is a 200 OK with the row count unmoved', () => {
    const [baseline, detect] = result.steps;
    assert.equal(detect.signals.rows_returned, baseline.signals.rows_returned);
    assert.equal(baseline.signals.schema_conformance, 1);
    assert.equal(detect.signals.schema_conformance, 0.05);
    assert.equal(detect.route, 'repair');
  });

  test('the repair actually lands in the registry rather than being described', () => {
    assert.equal(result.registry.deployed().version, '2026-08-22.1');
    assert.notEqual(result.registry.deployed().version, BASELINE_PLAN.version);
    const [deployment] = result.registry.history();
    assert.equal(deployment.from, BASELINE_PLAN.version);
    assert.equal(deployment.changeId, result.softwareChange.changeId);
  });

  test('verification re-measures the same page and reaches the pre-break bar', () => {
    const verify = result.steps.at(-1);
    assert.equal(verify.signals.schema_conformance, 1);
    assert.equal(verify.verified, true);
    assert.equal(verify.mttrSeconds, 90);
  });

  test('the ChangeRequest satisfies its frozen contract at every stage', () => {
    assert.deepEqual(validate(result.changeRequest, changeRequestSchema), []);
    assert.equal(result.changeRequest.type, 'REPAIR');
    assert.equal(result.changeRequest.status, 'verified');
    assert.equal(result.changeRequest.verification.verified, true);
    assert.equal(result.changeRequest.mttr_seconds, 90);
    // The raw numbers travel with the request so a human can disagree with the reading.
    assert.equal(result.changeRequest.signals.schema_conformance, 0.05);
    assert.equal(result.changeRequest.signals.schema_conformance_previous, 1);
    assert.equal(result.changeRequest.signals.source_generator, 'Meridian Web 2.4.0');
  });

  test('the software change was approved by someone other than its author', () => {
    const change = result.softwareChange;
    assert.equal(change.state, 'DEPLOYED');
    assert.equal(change.kind, 'REPAIR');
    assert.equal(change.decision.decision, 'APPROVE');
    assert.notEqual(change.decision.actor, change.author);
  });

  test('the approval carries the gate results as its evidence', () => {
    const gates = result.softwareChange.verification.checks;
    assert.deepEqual(gates.map((check) => check.gate).sort(), ['numeric', 'validator']);
    assert.ok(gates.every((check) => check.passed));
    assert.ok(gates.find((check) => check.gate === 'validator').evidenceRows.length > 0);
  });
});

describe('the outcomes that are not a repair', () => {
  test('a reviewer rejection blocks the dataset and deploys nothing', async () => {
    const result = await loop({ approve: false });
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.publish, 'BLOCKED');
    assert.equal(result.softwareChange.state, 'REJECTED');
    assert.equal(result.changeRequest.status, 'rejected');
    // The interlock is only real if the config is untouched afterwards.
    assert.equal(result.registry.deployed().version, BASELINE_PLAN.version);
    assert.deepEqual(result.registry.history(), []);
  });

  test('a break and a new field at once escalates instead of guessing', async () => {
    const result = await loop({ brokenVersion: 'v3' });
    assert.equal(result.status, 'ESCALATED');
    assert.equal(result.publish, 'BLOCKED');
    assert.equal(result.softwareChange, null);
    assert.equal(result.registry.deployed().version, BASELINE_PLAN.version);
    assert.match(result.changeRequest.diagnosis, /indistinguishable/);
    assert.deepEqual(validate(result.changeRequest, changeRequestSchema), []);
  });

  test('an outage is not treated as something a selector repair can fix', async () => {
    const result = await loop({ brokenVersion: 'v1' });
    assert.equal(result.status, 'ESCALATED');
    assert.equal(result.changeRequest.signals.failure_class, 'empty_result');
    assert.equal(result.changeRequest.signals.rows_returned, 0);
    assert.match(result.changeRequest.diagnosis, /cannot produce rows the page did not send/);
  });

  test('an unchanged page produces no change request at all', async () => {
    const result = await loop({ brokenVersion: 'v4' });
    assert.equal(result.status, 'HEALTHY');
    assert.equal(result.publish, 'PUBLISHED');
    assert.equal(result.changeRequest, null);
  });

  test('a repair that deploys and then fails verification still blocks the dataset', async () => {
    // The page moves again between the gates and the re-scrape — the live case, where a
    // proposal is measured against one version of a page and deployed against another.
    // The repair is real, the approval is real, and release must still be refused,
    // because release is decided by the re-measurement and not by having applied a fix.
    const pages = ['v4', 'v2', 'v1'];
    let call = 0;
    const fetchImpl = async () => new Response(
      await readFile(new URL(`../mend/versions/${pages[call++]}/pipeline/index.html`, import.meta.url), 'utf8'),
      { headers: { 'content-type': 'text/html' } }
    );

    const result = await loop({ origin: 'https://meridian.example', fetchImpl });

    assert.equal(result.softwareChange.state, 'DEPLOYED', 'the repair was approved and applied');
    assert.notEqual(result.registry.deployed().version, BASELINE_PLAN.version);
    assert.equal(result.changeRequest.verification.verified, false);
    assert.equal(result.changeRequest.status, 'rejected');
    assert.equal(result.changeRequest.mttr_seconds, null, 'mttr is only set once a repair verifies');
    assert.equal(result.status, 'UNVERIFIED');
    assert.equal(result.publish, 'BLOCKED');
    assert.deepEqual(validate(result.changeRequest, changeRequestSchema), []);
  });
});

describe('the gates run on every loop, not only in the test suite', () => {
  test('the mined negatives are carried through the live candidate table', () => {
    const diagnose = result.steps.find((step) => step.step === 'diagnose');
    const mined = diagnose.candidates.filter((candidate) => candidate.origin === 'mined-negative');
    assert.equal(mined.length, 3);
    assert.ok(mined.every((candidate) => !candidate.accepted));

    // Two of them are numerically perfect. That contrast is the demo, and it is computed
    // at run time rather than quoted from a document.
    const numericallyPerfect = mined.filter((candidate) => candidate.conformance === 1 && candidate.numeric);
    assert.equal(numericallyPerfect.length, 2);
    assert.ok(numericallyPerfect.every((candidate) => candidate.validator === 'reject'));
    assert.ok(numericallyPerfect.every((candidate) => candidate.evidenceRows.length > 0));
  });

  test('turning the mined negatives off does not change which repair is accepted', async () => {
    const withNegatives = await loop();
    const without = await loop({ includeMinedNegatives: false });
    assert.equal(
      withNegatives.registry.deployed().version,
      without.registry.deployed().version
    );
    assert.deepEqual(
      withNegatives.registry.deployed().fields,
      without.registry.deployed().fields
    );
  });
});

describe('the scraper registry', () => {
  test('a deployment needs an approved change behind it', () => {
    const registry = createScraperRegistry();
    assert.throws(
      () => registry.deploy({ ...BASELINE_PLAN, version: 'x' }, {}),
      /requires an approved change id/
    );
  });

  test('a repair that does not bump the config version is refused', () => {
    const registry = createScraperRegistry();
    assert.throws(() => registry.deploy(BASELINE_PLAN, { changeId: 'c1' }), /already deployed/);
  });

  test('the registry round-trips through JSON', () => {
    const restored = createScraperRegistry(JSON.parse(JSON.stringify(result.registry.toJSON())));
    assert.deepEqual(restored.deployed(), result.registry.deployed());
    assert.deepEqual(restored.history(), result.registry.history());
  });
});
