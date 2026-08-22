// The heal, under test.
//
// The claim being made is not "the factory produced a repair". It is:
//
//   1. the repair was derived from the page rather than selected from a list,
//   2. the derivation cannot produce the mined hard negatives, and
//   3. the two gates reject them when they are supplied anyway.
//
// (3) is the part that matters most, because (1) and (2) are properties of one
// synthesizer and could stop holding the moment it is replaced. The gates are what stand
// between any proposal — synthesized, model-written, or typed in by a tired human at
// 3am — and a release.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { extract, computeSignals, CONFIGS, HARD_NEGATIVES } from '../mend/src/extract.mjs';
import { BASELINE_PLAN, compilePlan, withField } from '../src/mend/selector-plan.mjs';
import {
  diagnose,
  healSource,
  historicalValueJudge,
  numericGate,
  nextConfigVersion,
  readerSitesFor,
  synthesizeReaders,
  vocabularyWarnings,
  MINED_NEGATIVE_PLANS,
} from '../src/mend/heal.mjs';

const BASE = 'https://meridian.example/pipeline/';
const schema = JSON.parse(readFileSync(new URL('../mend/contracts/record.schema.json', import.meta.url), 'utf8'));
const html = (version) =>
  readFileSync(new URL(`../mend/versions/${version}/pipeline/index.html`, import.meta.url), 'utf8');

function run(version, plan = BASELINE_PLAN) {
  const extraction = extract(html(version), { config: compilePlan(plan), baseUrl: BASE });
  return { records: extraction.records, signals: computeSignals(extraction, schema) };
}

const HEALTHY = run('v4');
const BROKEN = run('v2');
const anchorsFor = (result, field) =>
  new Map(result.records.filter((r) => r.attributes[field] != null).map((r) => [r.label, r.attributes[field]]));
const ANCHORS = anchorsFor(HEALTHY, 'phase');

const healV2 = (overrides = {}) =>
  healSource({
    html: html('v2'),
    sourceUrl: BASE,
    schema,
    basePlan: BASELINE_PLAN,
    before: BROKEN,
    baseline: HEALTHY.signals,
    anchors: ANCHORS,
    route: 'repair',
    now: new Date('2026-08-22T12:00:00.000Z'),
    ...overrides,
  });

describe('diagnosis reads the signals and names one field', () => {
  test('the silent break is diagnosed as a moved selector, citing the numbers', () => {
    const diagnosis = diagnose({ signals: BROKEN.signals, baseline: HEALTHY.signals, route: 'repair' });
    assert.equal(diagnosis.field, 'phase');
    assert.equal(diagnosis.repairable, true);
    assert.match(diagnosis.prose, /field_null_rate\{phase\} rose from 0\.00 to 0\.95/);
    assert.match(diagnosis.prose, /rows_returned stayed at 20/);
  });

  test('an outage is not diagnosed as a selector problem', () => {
    // v1 publishes no rows. A scraper repair cannot produce rows the page did not send,
    // so this must not enter the repair path at all.
    const diagnosis = diagnose({ signals: run('v1').signals, baseline: HEALTHY.signals, route: 'repair' });
    assert.equal(diagnosis.repairable, false);
    assert.match(diagnosis.prose, /rows_returned is 0/);
  });

  test('a break and a new field at once is refused, not guessed at', () => {
    const diagnosis = diagnose({ signals: run('v3').signals, baseline: HEALTHY.signals, route: 'escalate' });
    assert.equal(diagnosis.repairable, false);
    assert.match(diagnosis.prose, /indistinguishable/);
  });
});

describe('the repair is derived from the page', () => {
  test('the changed markup is searched for where the known values went', () => {
    const row = html('v2').match(/<tr\b[^>]*data-program="MRD-4471"[^>]*>[\s\S]*?<\/tr>/)[0];
    const sites = readerSitesFor(row, 'Phase 2');
    assert.deepEqual(sites, [{ kind: 'class', name: 'pill pill--stage' }]);
    // The neighbouring pill and the machine slug hold different strings, so neither is
    // ever a site for this value. This is why HN-2 and HN-3 cannot be synthesized.
    assert.deepEqual(readerSitesFor(row, 'Recruiting').filter((s) => s.name === 'pill pill--stage'), []);
  });

  test('the union is found without being told a union is needed', () => {
    const chains = synthesizeReaders({ html: html('v2'), anchors: ANCHORS });
    const complete = chains.find((chain) => chain.complete);
    assert.deepEqual(complete.readers, [
      { kind: 'class', name: 'pill pill--stage' },
      { kind: 'class', name: 'phase' },
    ]);
    assert.equal(complete.coveredRows, 20);
    // The 19-row prefix is offered too — that is the repair that stops early.
    assert.ok(chains.some((chain) => !chain.complete && chain.coveredRows === 19));
  });

  test('the derived repair is exactly the hand-written healed config', () => {
    const accepted = healV2().accepted;
    const derived = extract(html('v2'), { config: compilePlan(accepted.plan), baseUrl: BASE });
    const handWritten = extract(html('v2'), { config: CONFIGS.healed, baseUrl: BASE });
    assert.deepEqual(derived.records, handWritten.records);
  });

  test('the repair bumps the scraper config version and touches one field', () => {
    const accepted = healV2().accepted;
    assert.equal(accepted.plan.version, '2026-08-22.1');
    assert.notEqual(accepted.plan.version, BASELINE_PLAN.version);
    assert.deepEqual(
      accepted.plan.fields.filter((f) => f.field !== 'phase'),
      BASELINE_PLAN.fields.filter((f) => f.field !== 'phase')
    );
    assert.equal(accepted.proposedDiff, 'phase: [class="phase"]  ->  [class="pill pill--stage"], [class="phase"]');
  });

  test('no mined hard negative is ever synthesized', () => {
    const synthesized = synthesizeReaders({ html: html('v2'), anchors: ANCHORS });
    for (const negative of MINED_NEGATIVE_PLANS.filter((n) => n.id !== 'HN-1')) {
      assert.ok(
        !synthesized.some((chain) => JSON.stringify(chain.readers) === JSON.stringify(negative.readers)),
        `${negative.id} must not be derivable from the page`
      );
    }
  });

  test('with no anchors nothing is derived and the run escalates', () => {
    const result = healV2({ anchors: new Map() });
    assert.equal(result.accepted, null);
    assert.equal(result.escalated, true);
    assert.equal(result.exhausted, true);
  });
});

describe('two gates, both required', () => {
  const result = healV2({ extraCandidates: MINED_NEGATIVE_PLANS });
  const mined = (hn) => result.candidates.filter((c) => c.origin === 'mined-negative')[MINED_NEGATIVE_PLANS.findIndex((n) => n.id === hn)];

  test('exactly one candidate is accepted, and it is a derived one', () => {
    const accepted = result.candidates.filter((candidate) => candidate.accepted);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].origin, 'synthesized');
    assert.equal(accepted[0].signals.schema_conformance, 1);
  });

  test('HN-1 is caught by the numeric bar — 0.95 clears the alert and misses the baseline', () => {
    const candidate = mined('HN-1');
    assert.equal(candidate.signals.schema_conformance, 0.95);
    assert.ok(candidate.signals.schema_conformance > 0.85, 'the 0.85 alert would go quiet here');
    assert.equal(candidate.numeric.passed, false);
    assert.equal(candidate.accepted, false);
  });

  for (const hn of ['HN-2', 'HN-3']) {
    test(`${hn} passes every number and is caught by the validator`, () => {
      const candidate = mined(hn);
      // Numerically indistinguishable from a correct repair. This is the whole argument
      // for a second gate: nothing that counts nulls can separate these.
      assert.equal(candidate.signals.schema_conformance, 1);
      assert.equal(candidate.signals.field_null_rate.phase, 0);
      assert.equal(candidate.signals.failure_class, 'none');
      assert.equal(candidate.numeric.passed, true);

      assert.equal(candidate.validator.verdict, 'reject');
      assert.ok(candidate.validator.evidence_rows.length > 0, 'a verdict with no evidence rows is not a verdict');
      assert.equal(candidate.accepted, false);
    });
  }

  test('the mined negatives here behave exactly like HARD_NEGATIVES in the site fixture', () => {
    // If these two drift, this suite would be gating against a different set of near
    // misses than the ones the site's own corpus pins.
    const pairs = [
      ['HN-1', HARD_NEGATIVES.stage_pill_only],
      ['HN-2', HARD_NEGATIVES.wrong_pill_union],
      ['HN-3', HARD_NEGATIVES.slug_not_text],
    ];
    for (const [id, negative] of pairs) {
      const plan = withField(BASELINE_PLAN, 'phase', MINED_NEGATIVE_PLANS.find((n) => n.id === id).readers, 'x');
      assert.deepEqual(
        extract(html('v2'), { config: compilePlan(plan), baseUrl: BASE }).records,
        extract(html('v2'), { config: { fields: negative.fields }, baseUrl: BASE }).records,
        `${id} must match ${negative.id} in the site corpus`
      );
    }
  });

  test('the numeric bar is the pre-break baseline, never the alert threshold', () => {
    const naive = run('v2', withField(BASELINE_PLAN, 'phase', [{ kind: 'class', name: 'pill pill--stage' }], 'x'));
    assert.equal(numericGate({ after: naive.signals, baseline: HEALTHY.signals }).passed, false);
    assert.equal(numericGate({ after: HEALTHY.signals, baseline: HEALTHY.signals }).passed, true);
  });

  test('with no healthy baseline the numeric gate refuses rather than defaults to pass', () => {
    assert.equal(numericGate({ after: HEALTHY.signals, baseline: null }).passed, false);
  });
});

describe('the validator decides from values alone', () => {
  test('it is never handed a conformance number to anchor on', () => {
    // contracts/repair-validator.md rule 4. Enforced by giving the judge a spy.
    let seen = null;
    healV2({ judge: (input) => { seen = input; return { verdict: 'reject', confidence: 0, reason: 'spy', evidence_rows: ['x'] }; } });
    assert.deepEqual(Object.keys(seen).sort(), ['field', 'proposedDiff', 'samples', 'warnings']);
    assert.equal(JSON.stringify(seen).includes('schema_conformance'), false);
  });

  test('it rejects when a value disagrees with what the row published before', () => {
    const verdict = historicalValueJudge({
      field: 'phase',
      proposedDiff: 'phase: a -> b',
      samples: [
        { label: 'MRD-4471', before: null, after: 'Recruiting', expected: 'Phase 2' },
        { label: 'MRD-2210', before: null, after: 'Discontinued', expected: 'Discontinued' },
      ],
    });
    assert.equal(verdict.verdict, 'reject');
    assert.deepEqual(verdict.evidence_rows, ['MRD-4471']);
    assert.equal(verdict.confidence, 0.5);
  });

  test('it refuses to rule when there is nothing to compare against', () => {
    const verdict = historicalValueJudge({
      field: 'phase',
      proposedDiff: 'phase: a -> b',
      samples: [{ label: 'MRD-9999', before: null, after: 'Phase 1', expected: null }],
    });
    assert.equal(verdict.verdict, 'reject');
    assert.equal(verdict.confidence, 0);
  });

  test('the vocabulary check warns and does not veto', () => {
    // A legitimate new stage value is what EVOLVE exists for, so this must never be a gate.
    const warnings = vocabularyWarnings({
      samples: [{ label: 'MRD-1', after: 'Phase 2b' }],
      anchors: new Map([['MRD-1', 'Phase 2']]),
    });
    assert.equal(warnings.length, 1);
    const verdict = historicalValueJudge({
      field: 'phase',
      proposedDiff: 'd',
      samples: [{ label: 'MRD-1', before: null, after: 'Phase 2', expected: 'Phase 2' }],
      warnings,
    });
    assert.equal(verdict.verdict, 'accept', 'a warning must not become a veto');
    assert.match(verdict.reason, /outside the vocabulary/);
  });
});

describe('config version bumps', () => {
  test('same day increments the serial', () => {
    assert.equal(nextConfigVersion('2026-08-22.1', new Date('2026-08-22T09:00:00Z')), '2026-08-22.2');
  });
  test('a new day restarts at .1', () => {
    assert.equal(nextConfigVersion('2026-05-02.1', new Date('2026-08-22T09:00:00Z')), '2026-08-22.1');
  });
});
