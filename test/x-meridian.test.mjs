// The X axis against the real page.
//
// The numbers asserted here are the same ones mend/contracts/telemetry.md freezes and
// mend/test/signals.test.mjs already pins against the raw extractor. Repeating them at
// the axis boundary is deliberate: the site proving its own break says nothing about
// whether the factory still sees it after normalization, evidence attachment and
// validation. A run that quietly swallowed the break somewhere in that path would leave
// the site's suite green.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  anchorsFrom,
  loadRecordSchema,
  readMeridian,
  runMeridianX,
  scrapeSpanAttributes,
  validateMeridian,
} from '../src/axes/x-meridian.mjs';
import { validateEvidenceRecords } from '../src/mend/evidence.mjs';
import { BASELINE_PLAN } from '../src/mend/selector-plan.mjs';

const schema = await loadRecordSchema();
const at = async (version, baseline = null) =>
  runMeridianX({ page: await readMeridian({ version }), plan: BASELINE_PLAN, schema, baseline });

const healthy = await at('v4');

describe('the reference numbers survive the axis boundary', () => {
  const expected = [
    ['v4', { rows: 20, conformance: 1, phaseNull: 0, failureClass: 'none', route: 'none', status: 'PASS' }],
    ['v1', { rows: 0, conformance: 0, phaseNull: undefined, failureClass: 'empty_result', route: 'repair', status: 'FAIL' }],
    ['v2', { rows: 20, conformance: 0.05, phaseNull: 0.95, failureClass: 'selector_drift', route: 'repair', status: 'FAIL' }],
    ['v3', { rows: 20, conformance: 0, phaseNull: 0.95, failureClass: 'upstream_shape_change', route: 'escalate', status: 'FAIL' }],
  ];

  for (const [version, want] of expected) {
    test(`${version} -> ${want.failureClass} -> ${want.route.toUpperCase()}`, async () => {
      const run = await at(version, healthy.signals);
      assert.equal(run.signals.rows_returned, want.rows);
      assert.equal(run.signals.schema_conformance, want.conformance);
      assert.equal(run.signals.field_null_rate.phase, want.phaseNull);
      assert.equal(run.signals.failure_class, want.failureClass);
      assert.equal(run.validation.route, want.route);
      assert.equal(run.validation.status, want.status);
    });
  }

  test('v2 is silent: the row count does not move and nothing throws', async () => {
    const broken = await at('v2', healthy.signals);
    assert.equal(broken.signals.rows_returned, healthy.signals.rows_returned);
    assert.equal(broken.records.length, healthy.records.length);
    for (const [field, rate] of Object.entries(broken.signals.field_null_rate)) {
      if (field !== 'phase') assert.equal(rate, 0, `${field} must not have broken`);
    }
  });
});

describe('evidence stays intact through the break', () => {
  test('a broken run still produces valid evidence for every row', async () => {
    // If evidence went missing when phase went null, the X/Y/Z runtime would throw and
    // the failure would become loud — which is exactly what this source exists not to be.
    const broken = await at('v2', healthy.signals);
    const validated = validateEvidenceRecords(broken.records, 'X');
    assert.equal(validated.length, 20);
    for (const record of validated) {
      assert.ok(record.evidence.length > 0);
      assert.match(record.source_url, /^https?:\/\//);
    }
  });

  test('the evidence value falls back to status rather than going empty', async () => {
    const broken = await at('v2', healthy.signals);
    const row = broken.records.find((record) => record.label === 'MRD-4471');
    assert.equal(row.attributes.phase, null, 'the field itself is null — that is the break');
    assert.equal(row.evidence.value, 'Recruiting', 'the evidence claim stays populated');
    assert.match(row.evidence.evidence, /not published/, 'and it says the phase is missing rather than inventing one');
  });

  test('the normalized record is the frozen top-level shape', async () => {
    assert.deepEqual(Object.keys(healthy.normalized[0]).sort(), ['attributes', 'id', 'label', 'sourceUrl']);
    assert.match(healthy.normalized[0].id, /^[0-9a-f]{16}$/);
  });
});

describe('validation measures against the last healthy run', () => {
  test('a healthy run with no baseline still passes', () => {
    assert.equal(validateMeridian(healthy.signals, { baseline: null }).status, 'PASS');
  });

  test('a repair that clears the alert but misses the baseline still fails', () => {
    // 0.95 > the 0.85 alert threshold, and below the 1.00 pre-break bar.
    const naive = { ...healthy.signals, schema_conformance: 0.95, field_null_rate: { phase: 0.05 } };
    const validation = validateMeridian(naive, { baseline: healthy.signals });
    assert.equal(validation.status, 'FAIL');
    assert.match(validation.reason, /below the last healthy run/);
  });
});

describe('acquisition', () => {
  test('the canonical source URL never carries the version', async () => {
    for (const version of ['v1', 'v2', 'v3', 'v4']) {
      const page = await readMeridian({ version });
      assert.match(page.sourceUrl, /\/pipeline\/$/);
      assert.equal(page.sourceUrl.includes(version), false, 'the scraper is not configured with a version');
    }
  });

  test('a live fetch reads the version the middleware says it served', async () => {
    const page = await readMeridian({
      origin: 'https://meridian.example',
      fetchImpl: async () => new Response('<html></html>', { headers: { 'x-mend-version': 'v2' } }),
    });
    assert.equal(page.version, 'v2');
    assert.equal(page.live, true);
    assert.equal(page.sourceUrl, 'https://meridian.example/pipeline/');
  });

  test('a non-2xx is a fetch_error, not an empty result', async () => {
    // These route differently — one retries then escalates, the other opens a repair.
    await assert.rejects(
      readMeridian({ origin: 'https://meridian.example', fetchImpl: async () => new Response('', { status: 503 }) }),
      (error) => error.failureClass === 'fetch_error'
    );
  });
});

describe('the span carries the frozen attribute names', () => {
  test('every attribute contracts/telemetry.md names is present', async () => {
    const broken = await at('v2', healthy.signals);
    const page = await readMeridian({ version: 'v2' });
    const attributes = scrapeSpanAttributes({
      page,
      plan: BASELINE_PLAN,
      signals: broken.signals,
      validation: broken.validation,
      runId: 'run-1',
    });

    for (const key of [
      'run.id', 'source.id', 'source.url', 'source.controlled', 'source.generator',
      'scraper.id', 'scraper.config_version', 'schema.id', 'schema.version',
      'rows_returned', 'rows_expected_min', 'schema_conformance', 'unmapped_fields_seen',
      'failure_class', 'mend.route',
    ]) {
      assert.ok(key in attributes, `missing span attribute ${key}`);
    }
    assert.equal(attributes['source.controlled'], true, 'the disclosure travels with the data');
    assert.equal(attributes['source.generator'], 'Meridian Web 2.4.0');
    assert.equal(attributes['mend.route'], 'repair');
    // field_null_rate is deliberately not a span attribute — it ships as a metric.
    assert.equal('field_null_rate' in attributes, false);
  });
});

describe('anchors', () => {
  test('a healthy run yields one known-good value per row', () => {
    const anchors = anchorsFrom(healthy, 'phase');
    assert.equal(anchors.size, 20);
    assert.equal(anchors.get('MRD-4471'), 'Phase 2');
    assert.equal(anchors.get('MRD-2210'), 'Discontinued');
  });

  test('a broken run yields almost none — which is why the healthy run is the one stored', async () => {
    const broken = await at('v2', healthy.signals);
    assert.equal(anchorsFrom(broken, 'phase').size, 1);
  });
});
