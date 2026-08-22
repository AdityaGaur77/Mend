// A synthesized plan is only trustworthy if compiling a plan is the same thing as
// writing the config by hand. These tests are that equivalence.
//
// mend/src/extract-core.mjs holds three hand-written configs whose behaviour the site's
// own 75 assertions already pin. If compilePlan(BASELINE_PLAN) extracts identically to
// CONFIGS.baseline on every version, then the declarative representation has not changed
// what the extractor does — it has only made the config into something that can be
// diffed, reviewed, and derived.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { extract, CONFIGS } from '../mend/src/extract.mjs';
import { BASELINE_PLAN, compilePlan, renderDiff, renderField, withField } from '../src/mend/selector-plan.mjs';

const VERSIONS = ['v1', 'v2', 'v3', 'v4'];
const BASE = 'https://meridian.example/pipeline/';
const html = (version) =>
  readFileSync(new URL(`../mend/versions/${version}/pipeline/index.html`, import.meta.url), 'utf8');

const HEALED_PLAN = withField(
  BASELINE_PLAN,
  'phase',
  [
    { kind: 'class', name: 'pill pill--stage' },
    { kind: 'class', name: 'phase' },
  ],
  '2026-08-19.2'
);

describe('a compiled plan is the hand-written config', () => {
  for (const version of VERSIONS) {
    test(`baseline plan == CONFIGS.baseline on ${version}`, () => {
      const fromPlan = extract(html(version), { config: compilePlan(BASELINE_PLAN), baseUrl: BASE });
      const fromConfig = extract(html(version), { config: CONFIGS.baseline, baseUrl: BASE });
      assert.deepEqual(fromPlan.records, fromConfig.records);
    });

    test(`healed plan == CONFIGS.healed on ${version}`, () => {
      const fromPlan = extract(html(version), { config: compilePlan(HEALED_PLAN), baseUrl: BASE });
      const fromConfig = extract(html(version), { config: CONFIGS.healed, baseUrl: BASE });
      assert.deepEqual(fromPlan.records, fromConfig.records);
    });
  }

  test('the naive heal is reproducible as a plan too', () => {
    const naive = withField(BASELINE_PLAN, 'phase', [{ kind: 'class', name: 'pill pill--stage' }], 'x');
    assert.deepEqual(
      extract(html('v2'), { config: compilePlan(naive), baseUrl: BASE }).records,
      extract(html('v2'), { config: CONFIGS.healed_naive, baseUrl: BASE }).records
    );
  });
});

describe('a plan is reviewable', () => {
  test('a field renders as the literal match the extractor performs', () => {
    // Not `.pill--stage`: extract-core matches the whole class attribute, so the short
    // CSS form would describe a selector nobody runs.
    assert.equal(renderField(HEALED_PLAN, 'phase'), '[class="pill pill--stage"], [class="phase"]');
    assert.equal(renderField(BASELINE_PLAN, 'compound'), '[data-compound]');
  });

  test('a repair renders as a one-line diff', () => {
    assert.equal(
      renderDiff(BASELINE_PLAN, HEALED_PLAN, 'phase'),
      'phase: [class="phase"]  ->  [class="pill pill--stage"], [class="phase"]'
    );
  });

  test('withField leaves every other field alone', () => {
    assert.deepEqual(
      HEALED_PLAN.fields.filter((f) => f.field !== 'phase'),
      BASELINE_PLAN.fields.filter((f) => f.field !== 'phase')
    );
    assert.notEqual(HEALED_PLAN.version, BASELINE_PLAN.version, 'a repair must bump the config version');
  });

  test('a plan is JSON — it survives the round trip a Port entity or artifact needs', () => {
    const roundTripped = JSON.parse(JSON.stringify(HEALED_PLAN));
    assert.deepEqual(
      extract(html('v2'), { config: compilePlan(roundTripped), baseUrl: BASE }).records,
      extract(html('v2'), { config: compilePlan(HEALED_PLAN), baseUrl: BASE }).records
    );
  });
});

describe('malformed plans are refused rather than silently mis-extracting', () => {
  test('an unknown reader kind throws', () => {
    assert.throws(() => compilePlan({ version: '1', fields: [{ field: 'phase', readers: [{ kind: 'xpath', name: '//td' }] }] }), /unknown reader kind/);
  });

  test('a field with no readers throws', () => {
    assert.throws(() => compilePlan({ version: '1', fields: [{ field: 'phase', readers: [] }] }), /at least one reader/);
  });

  test('a plan with no version throws', () => {
    assert.throws(() => compilePlan({ fields: [{ field: 'phase', readers: [{ kind: 'class', name: 'phase' }] }] }), /needs a version/);
  });
});
