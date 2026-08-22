// What the numeric acceptance bar can and cannot catch.
//
// These assertions are the evidence behind contracts/repair-validator.md. If someone
// later "simplifies" verification down to a conformance threshold, these fail and say
// why. The claim being pinned is uncomfortable on purpose: two of the three mined
// hard negatives are indistinguishable from a correct repair by every number Mend
// emits, and are wrong in every row.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extract, computeSignals, CONFIGS, HARD_NEGATIVES } from '../src/extract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(readFileSync(join(root, 'contracts/record.schema.json'), 'utf8'));
const BASE = 'https://meridian.example/pipeline/';
const V2 = readFileSync(join(root, 'versions/v2/pipeline/index.html'), 'utf8');

const run = (config) => {
  const out = extract(V2, { config, baseUrl: BASE });
  return { signals: computeSignals(out, schema), values: out.records.map((r) => r.attributes.phase) };
};

const PHASE_VOCAB = new Set(['Discovery', 'Preclinical', 'Phase 1', 'Phase 2', 'Phase 3', 'Marketed', 'Discontinued']);

describe('mined hard negatives', () => {
  test('HN-1 is caught by the numeric bar but not by the alert threshold', () => {
    const { signals } = run(HARD_NEGATIVES.stage_pill_only);
    assert.equal(signals.schema_conformance, 0.95);
    assert.ok(signals.schema_conformance > 0.85, 'the 0.85 alert would clear — this is why alerts are not acceptance tests');
    assert.ok(signals.schema_conformance < 1, 'the pre-break bar does reject it');
  });

  for (const key of ['wrong_pill_union', 'slug_not_text']) {
    test(`${HARD_NEGATIVES[key].id} is INVISIBLE to every number Mend emits`, () => {
      const hn = run(HARD_NEGATIVES[key]);
      const good = run(CONFIGS.healed);

      // Indistinguishable from a correct repair on the numbers.
      assert.equal(hn.signals.schema_conformance, 1);
      assert.equal(hn.signals.field_null_rate.phase, 0);
      assert.equal(hn.signals.failure_class, 'none');
      assert.deepEqual(hn.signals, good.signals, 'signals are identical to a genuine fix');

      // And wrong in all but at most one row. (HN-3 gets a single accidental hit: the
      // archived row has no data-stage, so it falls through to .phase and lands on the
      // right answer by luck. One row in twenty right is not a repair.)
      assert.notDeepEqual(hn.values, good.values);
      const agreeing = hn.values.filter((v, i) => v === good.values[i]).length;
      assert.ok(agreeing <= 1, `expected at most one accidental agreement, got ${agreeing}`);
      assert.ok(hn.values.length - agreeing >= 19, 'at least 19 of 20 rows must be wrong');
    });
  }

  test('a value-domain check is the cheap partial answer, and it is not sufficient', () => {
    // An enum over known phases catches HN-2 and HN-3 without an LLM. Worth having.
    for (const key of ['wrong_pill_union', 'slug_not_text']) {
      const { values } = run(HARD_NEGATIVES[key]);
      assert.ok(values.some((v) => !PHASE_VOCAB.has(v)), `${key} should violate the phase vocabulary`);
    }
    // But the vocabulary is the thing EVOLVE exists to change, and it differs per
    // source — DNDi does not use Meridian's stage words. So it is a warning signal,
    // not the gate. See contracts/repair-validator.md.
    const { values } = run(CONFIGS.healed);
    assert.ok(values.every((v) => PHASE_VOCAB.has(v)), 'the correct fix stays inside the vocabulary');
  });
});
