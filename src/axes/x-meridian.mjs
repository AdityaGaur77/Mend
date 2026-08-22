// X axis, backed by the Meridian pipeline page instead of a JSON fixture.
//
// x-pipeline-adapter.mjs consumes snapshots whose break is a key rename
// (pipeline_items -> programme_cards). That break is structural: the shape changes, so
// anything reading it fails in a way you cannot miss. Useful as a guard, but it is not
// the failure the product exists to catch.
//
// This adapter reads HTML. The break it sees is Meridian v2's redesign, where every row
// keeps its data attributes and only `phase` — the one display-only field — stops
// resolving. rows_returned stays at 20, nothing throws, the response is 200 OK, and
// schema_conformance goes to 0.05. Detection has to come from the numbers, because
// there is no exception to catch.
//
// Two acquisition modes, same code path afterwards:
//
//   origin set    fetch the deployed page. What Bright Data scrapes, over the network.
//   origin unset  read the committed mend/versions/<v>/ tree. No network, no deploy.
//
// The committed tree is not a mock of the page — the deployment is built from it by
// mend/scripts/activate.mjs, so both modes read the same bytes. That is what makes the
// whole loop rehearsable offline while staying honest about what runs live.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { extract, computeSignals, ROUTE } from '../../mend/src/extract.mjs';
import { compilePlan } from '../mend/selector-plan.mjs';

export const SOURCE_ID = 'meridian';
export const SCHEMA_ID = 'meridian.program';
export const SCHEMA_VERSION = 1;

/** Where the page lives in the repo, and the URL it is published at. */
const MEND_ROOT = new URL('../../mend/', import.meta.url);
const DEFAULT_ORIGIN = 'http://localhost:4173';
const PIPELINE_PATH = '/pipeline/';

export async function loadRecordSchema() {
  return JSON.parse(await readFile(new URL('contracts/record.schema.json', MEND_ROOT), 'utf8'));
}

function generatorOf(html) {
  return html.match(/<meta name="generator" content="([^"]*)"/)?.[1] ?? null;
}

/**
 * Acquire the pipeline page.
 *
 * The canonical URL never carries the version — /pipeline is what the scraper is
 * configured with, and which version it serves is decided by the control room. So the
 * returned sourceUrl is always canonical, and `version` only says which bytes we read.
 */
export async function readMeridian({
  origin = process.env.MEND_MERIDIAN_URL || null,
  version = process.env.MEND_MERIDIAN_VERSION || 'v4',
  fetchImpl = globalThis.fetch,
} = {}) {
  if (origin) {
    const url = new URL(PIPELINE_PATH, origin).toString();
    const response = await fetchImpl(url, { headers: { accept: 'text/html' } });
    if (!response.ok) {
      const error = new Error(`meridian fetch failed: HTTP ${response.status}`);
      error.failureClass = 'fetch_error';
      throw error;
    }
    return {
      html: await response.text(),
      sourceUrl: url,
      // The middleware stamps which version it rewrote to. Absent when no Edge Config
      // pointer is set, in which case the deployment is serving whatever was activated.
      version: response.headers.get('x-mend-version') ?? 'deployed',
      live: true,
    };
  }

  const file = new URL(`versions/${version}/pipeline/index.html`, MEND_ROOT);
  return {
    html: await readFile(file, 'utf8'),
    sourceUrl: new URL(PIPELINE_PATH, DEFAULT_ORIGIN).toString(),
    version,
    live: false,
    path: fileURLToPath(file),
  };
}

/**
 * One row, as a sentence. Every axis record has to carry evidence a human can check,
 * and it has to stay populated through the break — if the evidence string went empty
 * when phase went null the failure would become loud again, which is precisely the
 * thing this source exists not to be.
 */
function evidenceSentence(record, attributes) {
  const say = (value) => (value == null ? 'not published' : value);
  return `${record.label} (${say(attributes.compound)}) is published at ${say(attributes.phase)} · ${say(attributes.status)} for ${say(attributes.indication)}, partner ${say(attributes.partner)}, updated ${say(attributes.updated)}.`;
}

/**
 * The X/Y/Z runtime requires each record to carry an evidence claim with a non-empty
 * value. `phase` is the field that goes null, so it cannot be the value on its own;
 * falling back to status keeps every record structurally valid while the break shows up
 * in schema_conformance instead. Silent stays silent.
 */
function toEvidenceRecords(records, { sourceUrl, retrievedAt }) {
  return records.map((record) => ({
    ...record,
    axis: 'X',
    program: record.label,
    sourceUrl: record.sourceUrl,
    evidence: {
      axis: 'X',
      subject: record.label,
      value: record.attributes.phase ?? record.attributes.status ?? 'unknown',
      source_url: record.sourceUrl || sourceUrl,
      retrieved_at: retrievedAt,
      evidence: evidenceSentence(record, record.attributes),
    },
  }));
}

export function summarizeMeridian(records, signals) {
  const partners = new Set(records.map((record) => record.attributes.partner).filter((p) => p && p !== '—'));
  const indications = new Set(records.map((record) => record.attributes.indication).filter(Boolean));
  return {
    programsFound: signals.rows_returned,
    // Named `organizations` as well because the existing target view reads that key for
    // the X card; for Meridian the collaborating organizations are the partners.
    organizations: partners.size,
    partners: partners.size,
    indications: indications.size,
    schemaConformance: signals.schema_conformance,
  };
}

/**
 * PASS/FAIL against the frozen contract, not against a missingness heuristic.
 *
 * Two things can fail a run, and they fail differently on purpose:
 *   - failure_class is anything but `none` — the page changed in a way that routes
 *   - conformance regressed below the last healthy run — the numeric bar from
 *     contracts/telemetry.md, which is the pre-break baseline and NOT the alert
 *     threshold. A repair that clears 0.85 and sits under the baseline is still broken.
 */
export function validateMeridian(signals, { baseline = null } = {}) {
  const reasons = [];
  const route = ROUTE[signals.failure_class] ?? 'escalate';

  if (signals.failure_class !== 'none') {
    reasons.push(`failure_class=${signals.failure_class} routes to ${route.toUpperCase()}`);
  }
  if (baseline && signals.schema_conformance < baseline.schema_conformance) {
    reasons.push(
      `schema_conformance ${signals.schema_conformance.toFixed(2)} is below the last healthy run's ${baseline.schema_conformance.toFixed(2)}`
    );
  }
  for (const [field, rate] of Object.entries(signals.field_null_rate)) {
    const before = baseline?.field_null_rate?.[field] ?? 0;
    if (rate > before) reasons.push(`field_null_rate{${field}} rose from ${before.toFixed(2)} to ${rate.toFixed(2)}`);
  }

  return {
    axis: 'X',
    status: reasons.length === 0 ? 'PASS' : 'FAIL',
    route,
    failureClass: signals.failure_class,
    quarantined: reasons.length > 0,
    reasons,
    reason: reasons.join('; ') || null,
    currentCount: signals.rows_returned,
    previousCount: baseline?.rows_returned ?? null,
  };
}

/** Span attributes for `mend.scrape`, exactly as contracts/telemetry.md names them. */
export function scrapeSpanAttributes({ page, plan, signals, validation, runId }) {
  return {
    'run.id': runId,
    'source.id': SOURCE_ID,
    'source.url': page.sourceUrl,
    'source.controlled': true,
    'source.generator': generatorOf(page.html) ?? '',
    'scraper.id': plan.id ?? SCHEMA_ID,
    'scraper.config_version': plan.version,
    'schema.id': SCHEMA_ID,
    'schema.version': SCHEMA_VERSION,
    rows_returned: signals.rows_returned,
    rows_expected_min: signals.rows_expected_min ?? 0,
    schema_conformance: signals.schema_conformance,
    unmapped_fields_seen: signals.unmapped_fields_seen,
    failure_class: signals.failure_class,
    'mend.route': validation.route,
  };
}

/**
 * Run the X axis against one acquired page with one scraper plan.
 *
 * Returns both views of the data on purpose: `normalized` is the pure
 * {id,label,sourceUrl,attributes} the record schema is measured against, and `records`
 * is that same data wearing the evidence claim the X/Y/Z runtime requires. Signals are
 * computed on the pure records, before anything is bolted on.
 */
export async function runMeridianX({
  page,
  plan,
  schema,
  baseline = null,
  rowsExpectedMin = 0,
  retrievedAt = new Date().toISOString(),
} = {}) {
  if (!page?.html) throw new TypeError('runMeridianX needs an acquired page');
  const recordSchema = schema ?? (await loadRecordSchema());
  const config = compilePlan(plan);

  const extraction = extract(page.html, { config, baseUrl: page.sourceUrl });
  const signals = {
    ...computeSignals(extraction, recordSchema, { rowsExpectedMin }),
    rows_expected_min: rowsExpectedMin,
  };
  const validation = validateMeridian(signals, { baseline });

  return {
    axis: 'X',
    source: {
      id: SOURCE_ID,
      url: page.sourceUrl,
      controlled: true,
      generator: generatorOf(page.html),
      version: page.version,
      live: Boolean(page.live),
    },
    scraper: { id: plan.id ?? SCHEMA_ID, config_version: plan.version },
    schema: { id: SCHEMA_ID, version: SCHEMA_VERSION },
    retrievedAt,
    normalized: extraction.records,
    records: toEvidenceRecords(extraction.records, { sourceUrl: page.sourceUrl, retrievedAt }),
    signals,
    summary: summarizeMeridian(extraction.records, signals),
    validation,
  };
}

/** Convenience: acquire and run in one call. */
export async function scrapeMeridian({ origin, version, plan, schema, baseline, rowsExpectedMin, fetchImpl } = {}) {
  const page = await readMeridian({ origin, version, fetchImpl });
  return runMeridianX({ page, plan, schema, baseline, rowsExpectedMin });
}

/** label -> the value this field held in a healthy run. The heal's ground truth. */
export function anchorsFrom(run, field) {
  return new Map(
    (run?.normalized ?? [])
      .filter((record) => record.attributes?.[field] != null)
      .map((record) => [record.label, record.attributes[field]])
  );
}
