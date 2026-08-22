// The ChangeRequest — the artifact SigNoz writes, Port stores, and the agent picks up.
//
// The point of the shape is in the first line of its schema description: opened by
// telemetry, not by a person. Nobody files the ticket. A conformance condition fires and
// this object exists, which is why `type` is routed from failure_class rather than
// chosen, and why `signals` carries the raw numbers — so a human can disagree with the
// factory's reading of them instead of having to take the diagnosis on trust.
//
// Validated here against mend/contracts/change-request.schema.json on the way out. The
// contract was frozen so four tracks could build against it in parallel; a producer that
// does not check its own output against it is just hoping.

import { readFile } from 'node:fs/promises';

import { validate } from '../../mend/src/validate.mjs';

let cachedSchema = null;

export async function loadChangeRequestSchema() {
  cachedSchema ??= JSON.parse(
    await readFile(new URL('../../mend/contracts/change-request.schema.json', import.meta.url), 'utf8')
  );
  return cachedSchema;
}

/**
 * failure_class -> route -> ChangeRequest type.
 *
 * The schema allows only REPAIR and EVOLVE, and ESCALATE is not a third type — it is a
 * REPAIR nobody is allowed to attempt automatically. It opens with status `escalated`
 * so the queue shows a human is required rather than showing nothing at all.
 */
export function requestTypeFor(route) {
  if (route === 'evolve') return { type: 'EVOLVE', status: 'proposed' };
  if (route === 'escalate') return { type: 'REPAIR', status: 'escalated' };
  return { type: 'REPAIR', status: 'proposed' };
}

function round(value) {
  return value == null ? null : Math.round(value * 1e6) / 1e6;
}

/** Build the request a failing run opens. Throws if it does not satisfy the contract. */
export async function openChangeRequest({
  run,
  runId,
  baseline = null,
  diagnosis = null,
  proposal = null,
  detectedAt = new Date().toISOString(),
  schema,
}) {
  const { type, status } = requestTypeFor(run.validation.route);
  const signals = run.signals;

  const request = {
    type,
    run_id: runId,
    source_id: run.source.id,
    detected_at: detectedAt,
    signals: {
      rows_returned: signals.rows_returned,
      rows_previous: baseline?.rows_returned ?? null,
      rows_expected_min: signals.rows_expected_min ?? null,
      schema_conformance: round(signals.schema_conformance),
      schema_conformance_previous: round(baseline?.schema_conformance ?? null),
      field_null_rate: Object.fromEntries(
        Object.entries(signals.field_null_rate).map(([field, rate]) => [field, round(rate)])
      ),
      unmapped_fields_seen: signals.unmapped_fields_seen,
      failure_class: signals.failure_class,
      source_generator: run.source.generator ?? null,
    },
    diagnosis: diagnosis ?? null,
    proposal: proposal ?? null,
    verification: null,
    status,
    mttr_seconds: null,
  };

  const errors = validate(request, schema ?? (await loadChangeRequestSchema()));
  if (errors.length) throw new Error(`ChangeRequest violates its own contract: ${errors.join('; ')}`);
  return request;
}

/**
 * Attach the re-run.
 *
 * `verified` is not "the alert cleared" and not "conformance is high" — it is the rule
 * in contracts/telemetry.md: back to at least the pre-break bar on conformance, and no
 * field worse than it was. A proposal with no verification block is never releasable,
 * because "repair succeeded" is a measurement and not a claim.
 */
export async function verifyChangeRequest(request, { rerunRunId, after, baseline, verifiedAt, schema }) {
  const nullRatesHeld = Object.entries(after.field_null_rate).every(
    ([field, rate]) => rate <= (baseline?.field_null_rate?.[field] ?? 0)
  );
  const verified = Boolean(baseline) && after.schema_conformance >= baseline.schema_conformance && nullRatesHeld;

  const next = {
    ...request,
    verification: {
      rerun_run_id: rerunRunId,
      rows_after: after.rows_returned,
      conformance_after: round(after.schema_conformance),
      field_null_rate_after: Object.fromEntries(
        Object.entries(after.field_null_rate).map(([field, rate]) => [field, round(rate)])
      ),
      verified,
    },
    status: verified ? 'verified' : 'rejected',
    mttr_seconds: verified
      ? round((Date.parse(verifiedAt) - Date.parse(request.detected_at)) / 1000)
      : null,
  };

  const errors = validate(next, schema ?? (await loadChangeRequestSchema()));
  if (errors.length) throw new Error(`verified ChangeRequest violates its own contract: ${errors.join('; ')}`);
  return next;
}

/** A repair the gates turned down. Rejected is a first-class outcome, not an error path. */
export async function rejectChangeRequest(request, { reason, schema }) {
  const next = { ...request, status: 'rejected', diagnosis: `${request.diagnosis ?? ''}\nRejected: ${reason}`.trim() };
  const errors = validate(next, schema ?? (await loadChangeRequestSchema()));
  if (errors.length) throw new Error(`rejected ChangeRequest violates its own contract: ${errors.join('; ')}`);
  return next;
}
