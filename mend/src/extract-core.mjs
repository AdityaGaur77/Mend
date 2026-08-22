// Extraction and signal logic, with every Node dependency removed.
//
// This file is imported by both the Node oracle (src/extract.mjs) and the browser
// control room (src/extract-web.mjs). It exists because those two must never
// disagree: the control room is shown on camera as the numbers, and if it computed
// them differently from the thing the tests assert, the demo would be lying about
// its own instrument. test/parity.test.mjs enforces the agreement.
//
// The only thing the two environments do differently is SHA-256, so `hash` is
// injected as a SYNCHRONOUS function. Node has a sync SHA-256; the browser's
// crypto.subtle is async-only, so the web wrapper pre-hashes in a first pass using
// hashInputs() below and passes a lookup. That keeps this file sync, keeps the Node
// API unchanged, and avoids shipping a second hand-rolled SHA-256 that could drift
// from Node's.
//
// Three scraper configs, which is the whole story:
//
//   baseline      what shipped against v1. Reads phase from .phase
//   healed_naive  what an agent proposes after seeing v2's pills. Reads .pill--stage
//   healed        what actually works. Reads .pill--stage, falling back to .phase
//
// healed_naive gets to 0.95 conformance and looks fixed. That is the trap, and it is
// there on purpose — one archived row on Meridian still renders the old partial.
// contracts/repair-validator.md names it as canonical hard negative #1.

import { validate } from './validate.mjs';

const ROW_RE = /<tr\b[^>]*\bdata-program="([^"]*)"[^>]*>([\s\S]*?)<\/tr>/g;

const attr = (name) => (row) => {
  const m = row.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : null;
};

/** Text content of the first element carrying class="<name>". */
const classText = (name) => (row) => {
  const m = row.match(new RegExp(`class="${name}"[^>]*>([^<]*)<`));
  return m ? m[1].trim() || null : null;
};

/** Text of the first .pill--stage span. */
const stagePillText = (row) => {
  const m = row.match(/class="pill pill--stage"[^>]*>([^<]*)</);
  return m ? m[1].trim() || null : null;
};

const firstOf =
  (...readers) =>
  (row) => {
    for (const read of readers) {
      const value = read(row);
      if (value != null) return value;
    }
    return null;
  };

const COMMON = {
  compound: attr('data-compound'),
  indication: attr('data-indication'),
  modality: attr('data-modality'),
  status: attr('data-status'),
  partner: attr('data-partner'),
  updated: attr('data-updated'),
};

export const CONFIGS = {
  baseline: { version: '2026-05-02.1', fields: { ...COMMON, phase: classText('phase') } },
  healed_naive: { version: '2026-08-19.1', fields: { ...COMMON, phase: stagePillText } },
  healed: { version: '2026-08-19.2', fields: { ...COMMON, phase: firstOf(stagePillText, classText('phase')) } },
};

/** Text of the first .pill--enroll span — the pill NEXT TO the one a repair wants. */
const enrollPillText = (row) => {
  const m = row.match(/class="pill pill--enroll"[^>]*>([^<]*)</);
  return m ? m[1].trim() || null : null;
};

/**
 * Mined hard negatives — proposed repairs that look correct and are not.
 *
 * Modelled on the Competitor-Validator negative corpus in Vinogradov et al.
 * (arXiv:2508.16571): a judge is only as good as the near-misses it was tuned
 * against. These are the near-misses for repairs. contracts/repair-validator.md is
 * the spec; test/hard-negatives.test.mjs pins what each one scores.
 *
 * The uncomfortable result is HN-2 and HN-3. Both are structurally the same shape as
 * the correct fix — a union of the new selector and a legacy fallback, which is
 * exactly what a competent agent proposes — and both reach schema_conformance 1.00
 * with a zero null rate and failure_class "none". Every value they return is wrong.
 *
 * So the numeric acceptance bar cannot separate a real repair from these. Nothing
 * about counting nulls can: the fields are all populated. Only reading the VALUES
 * catches them. That is the argument for a second, independent check, and it is why
 * "conformance is back to 1.00" must never be reported as "the data is right".
 */
export const HARD_NEGATIVES = {
  // HN-1 — learns the new pill, misses the archived row still on the old partial.
  // The numeric bar does catch this one (0.95 < 1.00). The 0.85 alert does not.
  stage_pill_only: {
    id: 'HN-1',
    label: '.pill--stage — misses the archived row',
    why: 'Reads .pill--stage only, missing the archived row on the legacy partial.',
    caughtBy: 'numeric bar',
    fields: { ...COMMON, phase: stagePillText },
  },
  // HN-2 — right structure, wrong pill. Returns enrolment statuses for every row.
  wrong_pill_union: {
    id: 'HN-2',
    label: '.pill--enroll, .status — the neighbouring pill',
    why: 'Reads ".pill--enroll, .status" — the neighbouring pill. Conformance 1.00, every value is an enrolment status rather than a phase.',
    caughtBy: 'values only',
    fields: { ...COMMON, phase: firstOf(enrollPillText, classText('status')) },
  },
  // HN-3 — right cell, machine slug instead of display text.
  slug_not_text: {
    id: 'HN-3',
    label: 'data-stage, .phase — the machine slug',
    why: 'Reads the data-stage slug rather than the pill text. Conformance 1.00, values are "phase-2" not "Phase 2".',
    caughtBy: 'values only',
    fields: { ...COMMON, phase: firstOf(attr('data-stage'), classText('phase')) },
  },
};

/**
 * Every row the extractor sees, as [label, rowHtml].
 *
 * Exported so a repair synthesizer searches exactly the rows extract() parses rather
 * than declaring a second row regex that could drift from this one. A synthesizer that
 * disagreed with the extractor about what a row is would propose repairs against markup
 * the extractor never reads.
 */
export function eachRow(html) {
  return [...html.matchAll(ROW_RE)].map(([, label, row]) => [label, row]);
}

/** Every attribute key the row actually publishes, mapped or not. Drives unmapped_fields_seen. */
function observedKeys(row) {
  const keys = new Set();
  for (const m of row.matchAll(/\bdata-([a-z0-9-]+)="/g)) {
    const key = m[1];
    if (key !== 'program' && key !== 'stage') keys.add(key);
  }
  return keys;
}

/** The exact strings extract() will hash, in order. Lets an async-only environment pre-compute them. */
export function hashInputs(html, { baseUrl } = {}) {
  const inputs = [];
  for (const [, label, row] of html.matchAll(ROW_RE)) {
    const href = row.match(/href="([^"]*)"/)?.[1] ?? '';
    inputs.push(`${new URL(href, baseUrl).toString()}\0${label}`);
  }
  return inputs;
}

/**
 * Parse a pipeline page into normalized records.
 * A field the config cannot find is emitted as null — never omitted, never "".
 * That rule is what makes a silent failure countable.
 *
 * `hash(input) -> 16 hex chars`, synchronous. See hashInputs() for the async case.
 */
export function extract(html, { config = CONFIGS.baseline, baseUrl, hash } = {}) {
  const records = [];
  const seenKeys = new Set();

  for (const [, label, row] of html.matchAll(ROW_RE)) {
    const href = row.match(/href="([^"]*)"/)?.[1] ?? '';
    const sourceUrl = new URL(href, baseUrl).toString();

    const attributes = {};
    for (const [field, read] of Object.entries(config.fields)) attributes[field] = read(row);
    for (const key of observedKeys(row)) seenKeys.add(key);

    records.push({ id: hash(`${sourceUrl}\0${label}`), label, sourceUrl, attributes });
  }

  return { records, observedKeys: seenKeys };
}

/** Turn an extraction into the numbers contracts/telemetry.md names. */
export function computeSignals({ records, observedKeys }, schema, { rowsExpectedMin = 0, previous = null } = {}) {
  const rows = records.length;
  const declared = new Set(Object.keys(schema.properties.attributes.properties));
  const mapped = Object.keys(records[0]?.attributes ?? {});

  const valid = records.filter((r) => validate(r, schema).length === 0).length;
  const conformance = rows === 0 ? 0 : valid / rows;

  const fieldNullRate = {};
  for (const field of mapped) {
    const nulls = records.filter((r) => r.attributes[field] == null).length;
    fieldNullRate[field] = rows === 0 ? 0 : nulls / rows;
  }

  const unmapped = [...observedKeys].filter((k) => !declared.has(k)).sort();

  return {
    rows_returned: rows,
    schema_conformance: conformance,
    field_null_rate: fieldNullRate,
    unmapped_fields_seen: unmapped,
    failure_class: classify({ rows, conformance, unmapped, rowsExpectedMin, previous }),
  };
}

/** The routing table from contracts/telemetry.md, in code. Order matters. */
export function classify({ rows, conformance, unmapped, rowsExpectedMin = 0, previous = null }) {
  if (rows === 0) return 'empty_result';

  const degraded = conformance < 0.85;
  const grew = unmapped.length > 0;

  // Both at once is genuinely ambiguous — a moved field and a replaced field look
  // identical from here. Escalate rather than guess.
  if (degraded && grew) return 'upstream_shape_change';
  if (degraded) return 'selector_drift';
  if (grew) return 'schema_extension';
  if (rowsExpectedMin && rows < rowsExpectedMin) return 'row_count_collapse';

  void previous;
  return 'none';
}

export const ROUTE = {
  none: 'none',
  selector_drift: 'repair',
  row_count_collapse: 'repair',
  empty_result: 'repair',
  schema_extension: 'evolve',
  fetch_error: 'escalate',
  upstream_shape_change: 'escalate',
};
