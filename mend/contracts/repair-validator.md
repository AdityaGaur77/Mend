# Repair-Validator

A second, independent check on whether a proposed heal is genuine. Spec only — the agent
track implements it. Modelled on the Competitor-Validator in Vinogradov et al.,
[arXiv:2508.16571](https://arxiv.org/abs/2508.16571), which filters a retrieval agent's
output with an LLM-as-a-judge tuned on mined hard negatives (90.4% precision, 85.7% recall,
88.0% F1) and runs it in CI.

## Why a second check exists

Mend's numeric acceptance bar is `conformance_after >= conformance_before_the_break`. That is
a real improvement on "the alert went quiet". It is still not sufficient, and we can show
exactly how insufficient, because the fixture contains the counterexamples.

Three proposed repairs against Meridian v2, measured (`test/hard-negatives.test.mjs` pins these):

| Proposal | conformance | null rate | failure_class | rows wrong | numeric gate |
|---|---|---|---|---|---|
| HN-1 `.pill--stage` | 0.95 | 0.05 | none | 1 / 20 | reject |
| **HN-2 `.pill--enroll, .status`** | **1.00** | **0.00** | **none** | **20 / 20** | **accept** |
| **HN-3 `data-stage, .phase`** | **1.00** | **0.00** | **none** | **19 / 20** | **accept** |
| correct `.pill--stage, .phase` | 1.00 | 0.00 | none | 0 / 20 | accept |

HN-2 and HN-3 are **numerically identical to a correct repair** — same conformance, same null
rate, same failure class — and wrong in essentially every row. No amount of counting nulls
separates them, because the fields are all populated. Only reading the values does.

Note also that HN-2 is not a strawman. It is a union of a new selector and a legacy fallback:
structurally the same shape as the right answer, and exactly what a competent agent proposes
after seeing that one archived row still uses the old markup. It picked the neighbouring pill.

**Conclusion the whole design rests on: "conformance is back to 1.00" and "the data is right"
are different claims, and only the first one is measurable by counting.**

## Two gates, both required

```
release  ⟺  numeric bar passes  AND  validator accepts
```

Neither alone. The numeric bar catches HN-1, which the validator might wave through as
plausible. The validator catches HN-2 and HN-3, which the numeric bar cannot see. They fail
differently on purpose.

## The cheap partial answer, and why it is not the gate

A value-domain check — is every `phase` inside a known vocabulary — catches both HN-2 and HN-3
for free, with no model involved. Have it. It is fast, deterministic, and explains itself.

But it cannot be the gate:

- The vocabulary is the thing **EVOLVE exists to change**. A legitimate new stage value
  ("Phase 2b", "Registrational") would be rejected as a break.
- It does not transfer. DNDi's stage words are not Meridian's, and the long tail is
  precisely where controlled vocabularies stop matching — the same argument the paper makes
  about drug-name aliases (p.6): no single vocabulary covers the tail.

So: run it as a **warning signal** that feeds the validator's evidence, not as a veto.

## Interface

Input:

```json
{
  "run_id": "...",
  "source_id": "meridian",
  "field": "phase",
  "signals_before": { "schema_conformance": 0.05, "field_null_rate": { "phase": 0.95 } },
  "signals_after":  { "schema_conformance": 1.00, "field_null_rate": { "phase": 0.00 } },
  "proposed_diff": "phase: .phase  ->  .pill--stage, .phase",
  "samples": [
    { "label": "MRD-4471", "before": null, "after": "Phase 2", "row_html": "<tr …>" }
  ],
  "vocabulary_warnings": ["3 of 20 values outside the observed phase vocabulary"]
}
```

Output:

```json
{ "verdict": "accept" | "reject", "confidence": 0.0, "reason": "…", "evidence_rows": ["MRD-…"] }
```

Rules for the judge:

1. Decide from the **values**, not the counts. The counts are already known to be
   insufficient — that is why it was called.
2. Cite specific rows. A verdict with no `evidence_rows` is not a verdict.
3. `reject` on any doubt. A rejected repair escalates to a human, which is cheap. An accepted
   wrong repair ships bad data under a green dashboard, which is the failure Mend exists to
   prevent.
4. It never sees whether the numeric bar passed. Independence is the point; a judge told
   "conformance is 1.00" will anchor on it.

## Tuning and CI

`HARD_NEGATIVES` in `src/extract-core.mjs` is the seed negative corpus — HN-1, HN-2, HN-3, each
runnable offline against the committed fixtures with no API call. Positives: the correct heal,
plus every healthy run.

Tune to F1 on that set, report precision and recall separately (a validator that rejects
everything scores well on precision and is useless). Grow the corpus the way the paper mined
theirs: keep every proposal a human rejected during the build, labelled.

Run it in CI on every change to a scraper config, the same way the paper feeds both its judges
into CI/CD. A repair that cannot survive the hard-negative set does not merge.
