// The heal.
//
// What was here before was a branch: `mode === 'repaired' ? adapterVersion 'v2'`. The
// repair was written by a human, committed next to the break, and selected at runtime.
// That demonstrates the governance around a repair — approval, deployment, re-run — and
// it demonstrates nothing about producing one, because the answer was already in the
// repository before the failure happened.
//
// This module derives the repair from the page.
//
// The method is value anchoring. A healthy run is not just a conformance number, it is a
// set of values: MRD-4471 was at "Phase 2", MRD-2210 at "Discontinued", and so on for
// twenty programmes. When the page is redesigned those values are still on it — a
// redesign moves data, it does not usually delete it. So the synthesizer searches the
// changed markup for the places those known values now live, and builds a reader chain
// out of whatever covers every row.
//
// Two properties fall out of that, and they are the reason for choosing it:
//
//   1. It cannot invent a plausible-looking wrong answer. HN-2 reads the pill next to
//      the right one and returns "Recruiting"; HN-3 reads the machine slug and returns
//      "phase-2". Neither equals any anchor, so neither is ever generated.
//      test/mend-heal.test.mjs asserts that directly.
//   2. It finds the union without being told the union exists. `.pill--stage` covers 19
//      rows, and the greedy cover keeps going because row 20 is still uncovered, which
//      is how it reaches the archived row's legacy `.phase` on its own.
//
// The gates stay exactly as contracts/repair-validator.md specifies: numeric bar AND
// validator, both required, failing differently on purpose. The synthesizer is not
// trusted just because it is careful — its output goes through the same two gates the
// hard negatives go through, which is the point of having gates.
//
// Stated limitation, because it is a real one: anchoring needs entities that survive the
// redesign, keyed the same way. Meridian keeps data-program stable across versions, and
// so do most redesigns, since the site's own JavaScript depends on those keys. When the
// keys move too, no anchor matches, the synthesizer returns nothing, and the route is
// ESCALATE. Returning nothing is the correct behaviour there — v3 is the case where a
// field moved and a field appeared at once, and it escalates rather than guessing.

import { extract, computeSignals, eachRow } from '../../mend/src/extract.mjs';
import { compilePlan, renderDiff, renderField, planField, withField } from './selector-plan.mjs';

/** Attributes that identify a row rather than describe it. Never a repair target. */
const IDENTITY_ATTRS = new Set(['data-program']);

/**
 * Read the signals and say, in prose that cites the numbers, what happened.
 *
 * The diagnosis has to name a field, because the repair is per-field. The broken field
 * is the one whose null rate rose against the last healthy run — not simply the one with
 * the most nulls, since a field can be legitimately sparse and stay that way.
 */
export function diagnose({ signals, baseline = null, route }) {
  const regressions = Object.entries(signals.field_null_rate)
    .map(([field, rate]) => ({ field, rate, before: baseline?.field_null_rate?.[field] ?? 0 }))
    .filter((entry) => entry.rate > entry.before)
    .sort((a, b) => b.rate - a.rate || a.field.localeCompare(b.field));

  const field = regressions[0]?.field ?? null;
  const rows = signals.rows_returned;
  const conformance = signals.schema_conformance;

  if (signals.failure_class === 'empty_result') {
    return {
      field: null,
      failureClass: signals.failure_class,
      route,
      repairable: false,
      prose:
        `rows_returned is 0 against a baseline of ${baseline?.rows_returned ?? 'unknown'}. ` +
        'The page responded but published no rows, so there is no markup to derive a selector from. ' +
        'This is a source outage, not a selector drift: repairing the scraper cannot produce rows the page did not send.',
    };
  }

  if (signals.unmapped_fields_seen.length > 0 && regressions.length > 0) {
    return {
      field,
      failureClass: signals.failure_class,
      route,
      repairable: false,
      prose:
        `schema_conformance is ${conformance.toFixed(2)} with rows_returned flat at ${rows}, and ` +
        `${signals.unmapped_fields_seen.join(', ')} appeared in the same run. A field that moved and a field that was ` +
        'replaced are indistinguishable from these signals: if the new field carries the old one\'s data this is a rename, ' +
        'and if it does not this is a break plus an unrelated addition. Both readings fit. Escalating rather than guessing.',
    };
  }

  if (!field) {
    return {
      field: null,
      failureClass: signals.failure_class,
      route,
      repairable: false,
      prose: `failure_class is ${signals.failure_class} and no field regressed against the last healthy run.`,
    };
  }

  const entry = regressions[0];
  return {
    field,
    failureClass: signals.failure_class,
    route,
    repairable: true,
    prose:
      `field_null_rate{${field}} rose from ${entry.before.toFixed(2)} to ${entry.rate.toFixed(2)} while rows_returned ` +
      `stayed at ${rows} and every other field held. schema_conformance fell to ${conformance.toFixed(2)}. ` +
      `The page still lists the same programmes, so it was not an outage and the rows still parse — ${field} alone ` +
      'stopped resolving, which is where a selector moved rather than where data disappeared.',
  };
}

/**
 * Every place in one row whose content equals `value`.
 *
 * This is the search that makes the repair derived rather than selected. It looks at
 * what the row actually publishes and reports each site it could be read from, in the
 * two reader kinds the extractor supports.
 */
export function readerSitesFor(rowHtml, value) {
  const sites = [];

  for (const [, name, attrValue] of rowHtml.matchAll(/\b([a-zA-Z][\w-]*)="([^"]*)"/g)) {
    if (IDENTITY_ATTRS.has(name)) continue;
    if (attrValue === value) sites.push({ kind: 'attr', name });
  }

  for (const [, className, text] of rowHtml.matchAll(/class="([^"]*)"[^>]*>([^<]*)</g)) {
    if (text.trim() === value) sites.push({ kind: 'class', name: className });
  }

  return sites;
}

const readerKey = (reader) => `${reader.kind}:${reader.name}`;

/**
 * Candidate reader chains for one field, derived from the changed page.
 *
 * Ranked by how many anchored rows each single reader covers, then combined greedily
 * until every anchored row is covered. Both the partial chains and the full one are
 * returned: a partial is what a repair that stops early looks like, and putting it
 * through the same gates is how the demo shows the numeric bar rejecting a 0.95 fix
 * rather than asserting that it would.
 */
export function synthesizeReaders({ html, anchors }) {
  const rows = eachRow(html).filter(([label]) => anchors.has(label));
  if (rows.length === 0) return [];

  const coverage = new Map();
  for (const [label, rowHtml] of rows) {
    for (const site of readerSitesFor(rowHtml, anchors.get(label))) {
      const key = readerKey(site);
      if (!coverage.has(key)) coverage.set(key, { reader: site, labels: new Set() });
      coverage.get(key).labels.add(label);
    }
  }

  const ranked = [...coverage.values()].sort(
    (a, b) => b.labels.size - a.labels.size || readerKey(a.reader).localeCompare(readerKey(b.reader))
  );
  if (ranked.length === 0) return [];

  const chains = [];
  const chain = [];
  const covered = new Set();
  for (const candidate of ranked) {
    const adds = [...candidate.labels].filter((label) => !covered.has(label));
    if (adds.length === 0) continue;
    chain.push(candidate.reader);
    for (const label of adds) covered.add(label);
    chains.push({
      readers: [...chain],
      coveredRows: covered.size,
      totalRows: rows.length,
      complete: covered.size === rows.length,
    });
    if (covered.size === rows.length) break;
  }

  // Longest first: the complete chain is the one to try before any partial prefix of it.
  return chains.reverse();
}

/** The numeric bar from contracts/telemetry.md. Not the alert threshold — the baseline. */
export function numericGate({ after, baseline }) {
  if (!baseline) return { passed: false, reason: 'no healthy baseline to measure against' };

  const failures = [];
  if (after.schema_conformance < baseline.schema_conformance) {
    failures.push(
      `schema_conformance ${after.schema_conformance.toFixed(2)} < pre-break ${baseline.schema_conformance.toFixed(2)}`
    );
  }
  for (const [field, rate] of Object.entries(after.field_null_rate)) {
    const before = baseline.field_null_rate?.[field] ?? 0;
    if (rate > before) failures.push(`field_null_rate{${field}} ${rate.toFixed(2)} > pre-break ${before.toFixed(2)}`);
  }

  return {
    passed: failures.length === 0,
    reason: failures.join('; ') || `conformance ${after.schema_conformance.toFixed(2)} meets the pre-break bar`,
    bar: baseline.schema_conformance,
  };
}

/**
 * The value-domain check contracts/repair-validator.md asks for: is every value inside
 * the vocabulary the healthy run used? Explicitly a warning that feeds the validator's
 * evidence and explicitly not a veto — the vocabulary is the thing EVOLVE exists to
 * change, so a legitimate new stage value must not be rejected as a break.
 */
export function vocabularyWarnings({ samples, anchors }) {
  const known = new Set(anchors.values());
  const outside = samples.filter((sample) => sample.after != null && !known.has(sample.after));
  if (outside.length === 0) return [];
  return [
    `${outside.length} of ${samples.length} values fall outside the vocabulary the last healthy run used ` +
      `(${[...new Set(outside.map((sample) => sample.after))].slice(0, 4).join(', ')})`,
  ];
}

/**
 * The second gate. Decides from the values and nothing else.
 *
 * contracts/repair-validator.md specifies an LLM judge tuned on mined hard negatives,
 * and rule 4 is that it never sees whether the numeric bar passed, because a judge told
 * "conformance is 1.00" anchors on it. This implementation honours that literally: it is
 * handed samples and a diff, and there is no conformance number in its input to anchor
 * on. Swap `judge` for a model-backed one and the interface does not change.
 *
 * The deterministic judge rules on agreement with the last healthy value. That is
 * narrower than a model — it can only speak about entities that existed before the
 * break, and it has nothing to say about a genuinely new row — but it is exactly the
 * evidence rules 1 and 2 ask for: a decision from the values, citing specific rows.
 */
export function historicalValueJudge({ field, samples, proposedDiff, warnings = [] }) {
  const checked = samples.filter((sample) => sample.expected != null);
  if (checked.length === 0) {
    return {
      verdict: 'reject',
      confidence: 0,
      reason: 'no row in this proposal has a known-good value to compare against, so nothing about it can be checked',
      evidence_rows: samples.slice(0, 3).map((sample) => sample.label),
    };
  }

  const disagreed = checked.filter((sample) => sample.after !== sample.expected);
  const repaired = checked.filter((sample) => sample.before !== sample.after && sample.after === sample.expected);
  const confidence = (checked.length - disagreed.length) / checked.length;

  if (disagreed.length > 0) {
    const shown = disagreed.slice(0, 3);
    return {
      verdict: 'reject',
      confidence,
      reason:
        `${disagreed.length} of ${checked.length} rows return a ${field} that disagrees with the value the row ` +
        `published before the change — ` +
        shown
          .map((sample) => `${sample.label} reads ${JSON.stringify(sample.after)}, was ${JSON.stringify(sample.expected)}`)
          .join('; ') +
        `. The proposal ${proposedDiff} populates the field without recovering its meaning.` +
        (warnings.length ? ` ${warnings.join(' ')}` : ''),
      evidence_rows: disagreed.map((sample) => sample.label),
    };
  }

  return {
    verdict: 'accept',
    confidence,
    reason:
      `all ${checked.length} rows return the ${field} the row published before the change, including ` +
      `${repaired.length} that read null under the deployed config` +
      (warnings.length ? `. ${warnings.join(' ')}` : '.'),
    // Rule 2: a verdict with no evidence_rows is not a verdict. Cite what changed.
    evidence_rows: (repaired.length ? repaired : checked).slice(0, 5).map((sample) => sample.label),
  };
}

/** Run one candidate chain against the page and collect what both gates need. */
function evaluateCandidate({ candidate, html, sourceUrl, schema, field, anchors, basePlan, before, baseline, version, judge }) {
  const plan = withField(basePlan, field, candidate.readers, version);
  const extraction = extract(html, { config: compilePlan(plan), baseUrl: sourceUrl });
  const after = computeSignals(extraction, schema);

  const beforeByLabel = new Map(before.records.map((record) => [record.label, record.attributes[field]]));
  const samples = extraction.records.map((record) => ({
    label: record.label,
    before: beforeByLabel.get(record.label) ?? null,
    after: record.attributes[field],
    expected: anchors.get(record.label) ?? null,
  }));

  const proposedDiff = renderDiff(basePlan, plan, field);
  const numeric = numericGate({ after, baseline });
  const warnings = vocabularyWarnings({ samples, anchors });
  // Rule 4: the judge receives values and a diff. No conformance number reaches it.
  const validator = judge({ field, samples, proposedDiff, warnings });

  return {
    id: `${field}:${candidate.readers.map((r) => `${r.kind}=${r.name}`).join('|')}`,
    selector: renderField(plan, field),
    proposedDiff,
    plan,
    readers: candidate.readers,
    coveredRows: candidate.coveredRows,
    totalRows: candidate.totalRows,
    signals: after,
    numeric,
    validator,
    warnings,
    accepted: numeric.passed && validator.verdict === 'accept',
  };
}

/** `2026-08-22.1` -> `2026-08-22.2`, or a fresh stamp when the day rolled over. */
export function nextConfigVersion(current, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const [day, serial] = String(current ?? '').split('.');
  return day === today ? `${today}.${Number(serial ?? 0) + 1}` : `${today}.1`;
}

/**
 * Detect -> diagnose -> synthesize -> gate.
 *
 * Returns every candidate it considered with the verdict of both gates on each, not
 * just the winner. The rejected ones are the evidence that the gates do something, and
 * they are what a reviewer needs in order to disagree with the factory.
 */
export function healSource({
  html,
  sourceUrl,
  schema,
  basePlan,
  before,
  baseline,
  anchors,
  route,
  extraCandidates = [],
  judge = historicalValueJudge,
  now = new Date(),
} = {}) {
  const diagnosis = diagnose({ signals: before.signals, baseline, route });

  if (!diagnosis.repairable) {
    return { diagnosis, field: diagnosis.field, candidates: [], accepted: null, escalated: true };
  }

  const field = diagnosis.field;
  const version = nextConfigVersion(basePlan.version, now);
  const synthesized = synthesizeReaders({ html, anchors }).map((candidate) => ({ ...candidate, origin: 'synthesized' }));
  const supplied = extraCandidates.map((candidate) => ({
    readers: candidate.readers,
    coveredRows: null,
    totalRows: null,
    complete: null,
    origin: candidate.origin ?? 'supplied',
    label: candidate.label ?? null,
  }));

  const candidates = [...synthesized, ...supplied].map((candidate) => ({
    ...evaluateCandidate({
      candidate,
      html,
      sourceUrl,
      schema,
      field,
      anchors,
      basePlan,
      before,
      baseline,
      version,
      judge,
    }),
    origin: candidate.origin,
    label: candidate.label ?? null,
  }));

  const accepted = candidates.find((candidate) => candidate.origin === 'synthesized' && candidate.accepted) ?? null;

  return {
    diagnosis,
    field,
    candidates,
    accepted,
    escalated: accepted === null,
    // Nothing was derivable: no anchored row could be located in the changed markup.
    exhausted: synthesized.length === 0,
  };
}

export { renderDiff, renderField, planField };

/**
 * The mined hard negatives from mend/src/extract-core.mjs, as reader chains.
 *
 * They exist here so the gates can be run against them — on every test run, and live in
 * the demo — rather than asserted about. HN-1 is also what the synthesizer produces as a
 * partial chain on its way to the full one, so it arrives at the gates twice by two
 * different routes and is rejected the same way both times.
 *
 * test/mend-heal.test.mjs pins these against HARD_NEGATIVES so the two cannot drift.
 */
export const MINED_NEGATIVE_PLANS = Object.freeze([
  {
    id: 'HN-1',
    label: 'the new pill only — misses the archived row',
    origin: 'mined-negative',
    readers: [{ kind: 'class', name: 'pill pill--stage' }],
  },
  {
    id: 'HN-2',
    label: 'the neighbouring pill — conformance 1.00, every value an enrolment status',
    origin: 'mined-negative',
    readers: [
      { kind: 'class', name: 'pill pill--enroll' },
      { kind: 'class', name: 'status' },
    ],
  },
  {
    id: 'HN-3',
    label: 'the machine slug — conformance 1.00, values are "phase-2" not "Phase 2"',
    origin: 'mined-negative',
    readers: [
      { kind: 'attr', name: 'data-stage' },
      { kind: 'class', name: 'phase' },
    ],
  },
]);
