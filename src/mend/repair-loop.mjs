// The operational loop, end to end, against the real page.
//
//   scrape -> signals -> detect -> ChangeRequest -> diagnose -> derive repair
//     -> two gates -> SoftwareChange -> human approve -> deploy -> re-scrape
//     -> verify -> release or block
//
// The pieces existed separately before this: signals in mend/, approval in
// software-change.mjs, orchestration in vertical-slice.mjs. What was missing is the part
// where a detected failure produces a repair that lands somewhere and gets measured
// afterwards. Wiring is most of this file; the two judgement calls in it are:
//
//   1. A repair is deployed only after a SoftwareChange is APPROVED by someone other
//      than its author. proposeSoftwareChange already refuses an unverified change and
//      decideSoftwareChange already refuses a self-approval — this loop routes the
//      heal's own gate results in as that verification, so the interlock has real
//      evidence under it rather than a hardcoded PASS.
//
//   2. Release is decided by re-measuring, never by the repair having been applied. The
//      re-scrape reads the same page again with the new config, and if conformance does
//      not come back to the pre-break bar the change is deployed and the dataset is
//      still blocked. Those are different things and the loop keeps them apart.

import { randomUUID } from 'node:crypto';

import {
  anchorsFrom,
  loadRecordSchema,
  readMeridian,
  runMeridianX,
  scrapeSpanAttributes,
} from '../axes/x-meridian.mjs';
import { healSource, MINED_NEGATIVE_PLANS } from './heal.mjs';
import { openChangeRequest, rejectChangeRequest, verifyChangeRequest } from './change-request.mjs';
import { createScraperRegistry } from './scraper-registry.mjs';
import { decideSoftwareChange, deploySoftwareChange, proposeSoftwareChange } from './software-change.mjs';

const AUTHOR = 'mend-heal-agent';

/** Emit one scrape's worth of the frozen telemetry contract. */
function emitScrape({ telemetry, run, page, plan, runId, durationMs, parentSpan }) {
  if (!telemetry) return;
  const span = telemetry.startSpan?.(
    'mend.scrape',
    scrapeSpanAttributes({ page, plan, signals: run.signals, validation: run.validation, runId }),
    parentSpan
  );

  const source = { 'source.id': run.source.id };
  const meridian = telemetry.metrics?.meridian;
  meridian?.rows?.record(run.signals.rows_returned, source);
  meridian?.conformance?.record(run.signals.schema_conformance, { ...source, 'schema.id': run.schema.id });
  for (const [field, rate] of Object.entries(run.signals.field_null_rate)) {
    meridian?.fieldNullRate?.record(rate, { ...source, field });
  }
  for (const field of run.signals.unmapped_fields_seen) {
    meridian?.unmappedFields?.record(1, { ...source, field });
  }
  if (durationMs != null) meridian?.runDuration?.record(durationMs, source);

  telemetry.log?.(
    run.validation.status === 'PASS' ? 'INFO' : 'ERROR',
    // Worth saying in the log line itself: this is a 200 OK. Nothing threw.
    `meridian scrape ${run.validation.status} — rows ${run.signals.rows_returned}, conformance ${run.signals.schema_conformance.toFixed(2)}, ${run.signals.failure_class}`,
    {
      'run.id': runId,
      'source.id': run.source.id,
      rows_returned: run.signals.rows_returned,
      schema_conformance: run.signals.schema_conformance,
      failure_class: run.signals.failure_class,
      'mend.route': run.validation.route,
    },
    span
  );
  span?.end?.();
  return span;
}

/** Acquire a page and run the deployed config over it, with telemetry. */
export async function scrapeOnce({
  registry,
  origin,
  version,
  schema,
  baseline = null,
  telemetry,
  runId = randomUUID(),
  parentSpan,
  fetchImpl,
}) {
  const startedAt = performance.now();
  const page = await readMeridian({ origin, version, fetchImpl });
  const plan = registry.deployed();
  const run = await runMeridianX({ page, plan, schema, baseline });
  const durationMs = performance.now() - startedAt;
  emitScrape({ telemetry, run, page, plan, runId, durationMs, parentSpan });
  return { run, page, plan, runId, durationMs };
}

/**
 * Detect, repair, approve, deploy, re-measure.
 *
 * `healthyVersion` is what the factory scraped successfully before the change — the
 * source of both the numeric bar and the anchors. In a live deployment that comes from
 * the last healthy run's stored record, not from a version name; passing a version here
 * is how the loop is rehearsed offline against the committed tree.
 */
export async function runRepairLoop({
  registry = createScraperRegistry(),
  origin = null,
  healthyVersion = 'v4',
  brokenVersion = 'v2',
  schema,
  telemetry,
  reviewer = 'human-reviewer',
  approve = true,
  includeMinedNegatives = true,
  now = () => new Date(),
  fetchImpl,
} = {}) {
  const recordSchema = schema ?? (await loadRecordSchema());
  const root = telemetry?.startSpan?.('mend.repair_loop', { 'source.id': 'meridian' });
  const steps = [];

  try {
    // 1. The healthy run. Its conformance is the bar and its values are the anchors.
    const healthy = await scrapeOnce({
      registry, origin, version: healthyVersion, schema: recordSchema, telemetry,
      runId: 'meridian-healthy', parentSpan: root, fetchImpl,
    });
    const baseline = healthy.run.signals;
    const steps0 = { step: 'baseline', runId: healthy.runId, signals: baseline, status: healthy.run.validation.status };
    steps.push(steps0);

    // 2. The page changes. Same URL, same scraper, 200 OK, quietly different data.
    const detectedAt = now().toISOString();
    const broken = await scrapeOnce({
      registry, origin, version: brokenVersion, schema: recordSchema, baseline, telemetry,
      runId: 'meridian-detect', parentSpan: root, fetchImpl,
    });
    steps.push({
      step: 'detect', runId: broken.runId, signals: broken.run.signals,
      status: broken.run.validation.status, route: broken.run.validation.route,
    });

    if (broken.run.validation.status === 'PASS') {
      return { status: 'HEALTHY', steps, changeRequest: null, softwareChange: null, registry, publish: 'PUBLISHED' };
    }

    // 3. The alert condition opens the request. Nobody files the ticket.
    let changeRequest = await openChangeRequest({
      run: broken.run, runId: broken.runId, baseline, detectedAt,
    });

    // 4. Diagnose and derive. The mined negatives ride along so the gates are exercised
    //    on every run rather than only in the test suite.
    const heal = healSource({
      html: broken.page.html,
      sourceUrl: broken.page.sourceUrl,
      schema: recordSchema,
      basePlan: registry.deployed(),
      before: { records: broken.run.normalized, signals: broken.run.signals },
      baseline,
      anchors: anchorsFrom(healthy.run, 'phase'),
      route: broken.run.validation.route,
      extraCandidates: includeMinedNegatives ? MINED_NEGATIVE_PLANS : [],
      now: now(),
    });
    changeRequest = { ...changeRequest, diagnosis: heal.diagnosis.prose };
    steps.push({
      step: 'diagnose', field: heal.field, prose: heal.diagnosis.prose,
      candidates: heal.candidates.map((candidate) => ({
        origin: candidate.origin,
        label: candidate.label,
        selector: candidate.selector,
        conformance: candidate.signals.schema_conformance,
        numeric: candidate.numeric.passed,
        validator: candidate.validator.verdict,
        validatorReason: candidate.validator.reason,
        evidenceRows: candidate.validator.evidence_rows,
        accepted: candidate.accepted,
      })),
    });

    if (!heal.accepted) {
      const reason = heal.diagnosis.repairable
        ? 'no candidate passed both the numeric bar and the validator'
        : heal.diagnosis.prose;
      changeRequest = await rejectChangeRequest(changeRequest, { reason });
      telemetry?.log?.('ERROR', `meridian repair escalated: ${reason}`, { 'run.id': broken.runId }, root);
      steps.push({ step: 'escalate', reason });
      return { status: 'ESCALATED', steps, changeRequest, softwareChange: null, registry, publish: 'BLOCKED' };
    }

    const accepted = heal.accepted;
    changeRequest = {
      ...changeRequest,
      proposal: {
        scraper_config_diff: accepted.proposedDiff,
        schema_diff: null,
        ui_diff: null,
        test_diff: null,
      },
    };

    // 5. A repair is a software change. The gate results are its verification evidence —
    //    proposeSoftwareChange refuses anything that has not passed something first.
    let softwareChange = proposeSoftwareChange({
      kind: 'REPAIR',
      brief: `Repair ${heal.field} on ${broken.run.source.id}: ${accepted.proposedDiff}`,
      author: AUTHOR,
      changedFiles: ['artifacts/mend/scraper-registry.json'],
      gitRef: `mend/repair/${accepted.plan.version}`,
      verification: {
        status: 'PASS',
        checks: [
          { gate: 'numeric', passed: accepted.numeric.passed, detail: accepted.numeric.reason },
          {
            gate: 'validator',
            passed: accepted.validator.verdict === 'accept',
            detail: accepted.validator.reason,
            evidenceRows: accepted.validator.evidence_rows,
          },
        ],
      },
      createdAt: now().toISOString(),
    });
    steps.push({ step: 'propose', changeId: softwareChange.changeId, diff: accepted.proposedDiff });

    // 6. The interlock. A rejected repair is a first-class outcome, not an error.
    if (!approve) {
      softwareChange = decideSoftwareChange(softwareChange, {
        decision: 'REJECT', actor: reviewer, reason: 'reviewer declined the proposed repair',
        decidedAt: now().toISOString(),
      });
      changeRequest = await rejectChangeRequest(changeRequest, { reason: 'human reviewer rejected the repair' });
      steps.push({ step: 'reject', actor: reviewer });
      return { status: 'REJECTED', steps, changeRequest, softwareChange, registry, publish: 'BLOCKED' };
    }

    softwareChange = decideSoftwareChange(softwareChange, {
      decision: 'APPROVE', actor: reviewer,
      reason: `derived repair meets the pre-break bar and the validator cites ${accepted.validator.evidence_rows.length} rows`,
      decidedAt: now().toISOString(),
    });
    softwareChange = deploySoftwareChange(softwareChange, {
      factoryVersion: accepted.plan.version, deployedAt: now().toISOString(),
    });
    changeRequest = { ...changeRequest, status: 'approved' };
    telemetry?.metrics?.repairAttempts?.add(1, { axis: 'X', 'run.id': broken.runId });

    // 7. The repair lands. Until this line the factory has only described a fix.
    registry.deploy(accepted.plan, {
      changeId: softwareChange.changeId,
      actor: reviewer,
      reason: accepted.proposedDiff,
      deployedAt: now().toISOString(),
    });
    steps.push({ step: 'deploy', configVersion: accepted.plan.version, changeId: softwareChange.changeId });

    // 8. Re-scrape the SAME page with the new config. The bytes did not change; the
    //    scraper did. That distinction is the difference between healing and papering over.
    const rerun = await scrapeOnce({
      registry, origin, version: brokenVersion, schema: recordSchema, baseline, telemetry,
      runId: 'meridian-verify', parentSpan: root, fetchImpl,
    });
    const verifiedAt = now().toISOString();
    changeRequest = await verifyChangeRequest(changeRequest, {
      rerunRunId: rerun.runId, after: rerun.run.signals, baseline, verifiedAt,
    });
    steps.push({
      step: 'verify', runId: rerun.runId, signals: rerun.run.signals,
      verified: changeRequest.verification.verified, mttrSeconds: changeRequest.mttr_seconds,
    });

    if (changeRequest.verification.verified) {
      telemetry?.metrics?.repairSuccess?.add(1, { axis: 'X', 'run.id': rerun.runId });
      telemetry?.metrics?.meridian?.mttr?.record(changeRequest.mttr_seconds ?? 0, { 'source.id': 'meridian' });
    }

    return {
      status: changeRequest.verification.verified ? 'REPAIRED' : 'UNVERIFIED',
      publish: changeRequest.verification.verified ? 'PUBLISHED' : 'BLOCKED',
      steps,
      changeRequest,
      softwareChange,
      registry,
      records: rerun.run.records,
    };
  } finally {
    root?.end?.();
  }
}
