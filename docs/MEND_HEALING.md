# The heal

How a conformance number becomes a deployed scraper config, and what stops a plausible
wrong repair from getting there.

## What was here before

```js
mode === 'repaired' ? { adapterVersion: 'v2' } : { adapterVersion: 'v1' }
```

The repair was written by a person, committed next to the break, and selected at runtime.
That is a real demonstration of the governance around a repair — proposal, approval,
deployment, re-run — and it demonstrates nothing about producing one, because the answer
was in the repository before the failure happened.

It also could not fail interestingly. `v1 → v2` is a JSON key rename
(`pipeline_items` → `programme_cards`), so anything reading the old shape breaks
structurally and loudly. Real pipelines do not usually fail that way.

## The failure worth catching

Meridian v2 is a routine redesign: `Phase` and `Status` merged into status pills, the
Partner column moved, a new stylesheet. Every row keeps its `data-*` attributes, because
a site's own JavaScript depends on them.

So the scrape returns **HTTP 200, twenty rows, no exception**, and one field is quietly
gone:

```
v4  rows=20  schema_conformance=1.00  phase_null=0.00  none
v2  rows=20  schema_conformance=0.05  phase_null=0.95  selector_drift
```

`rows_returned` counts rows *matched*, not rows *valid*. During a silent failure the
first stays flat while the second collapses. Nothing that watches error rate, HTTP status
or row count sees this. That is why alerts key on conformance.

## Deriving the repair

The method is **value anchoring**, in `src/mend/heal.mjs`.

A healthy run is not just a conformance number; it is a set of values. MRD-4471 was at
`Phase 2`, MRD-2210 at `Discontinued`, and so on for twenty programmes. A redesign moves
data, it rarely deletes it — so those values are still on the changed page, somewhere
else. The synthesizer looks for them:

1. **Diagnose.** Find the field whose null rate rose against the last healthy run. Not
   simply the emptiest field — a field can be legitimately sparse and stay that way.
2. **Search.** For each row, scan the changed markup for every place whose content equals
   that row's known-good value. Two reader kinds, because the extractor has two: an
   attribute value, or the text of an element with a given class attribute.
3. **Cover.** Rank readers by how many rows each one explains, then combine greedily
   until every anchored row is covered.
4. **Gate.** Run each candidate through both gates. Nothing is accepted for being
   plausible.

On v2 step 3 finds `[class="pill pill--stage"]` covering 19 rows, and keeps going,
because one row is still uncovered — the archived MRD-2210 still renders through the
pre-refresh partial and emits `<span class="phase">`. So it reaches
`[class="pill pill--stage"], [class="phase"]`, which is exactly the hand-written healed
config, derived without anyone knowing in advance that a union was needed.

### Two properties this buys

**It cannot synthesize the mined hard negatives.** HN-2 reads the neighbouring pill and
returns `Recruiting`; HN-3 reads the machine slug and returns `phase-2`. Neither string
equals any anchor, so neither is ever generated. `test/mend-heal.test.mjs` asserts that
directly.

**It refuses rather than guesses.** Anchoring needs entities that survive the redesign
under the same key. When they do not — v1's outage publishes no rows at all, v3 breaks a
field and adds one in the same release — no anchor matches, nothing is derived, and the
route is ESCALATE.

## Two gates, both required

From [`mend/contracts/repair-validator.md`](../mend/contracts/repair-validator.md):

```
release  ⟺  numeric bar passes  AND  validator accepts
```

**The numeric bar** is `conformance_after >= conformance_before_the_break`, with no field's
null rate worse than it was. The bar is the pre-break baseline, **not the alert
threshold** — that distinction is the point of having it.

**The validator** decides from the values and never sees a conformance number. Rule 4 of
the spec: a judge told "conformance is 1.00" anchors on it. A test passes the loop a spy
judge and asserts on the keys it received.

Every run prints the table, so this is computed rather than quoted:

| Proposal | reads | conformance | numeric | validator |
|---|---|---|---|---|
| derived | `[class="pill pill--stage"], [class="phase"]` | 1.00 | pass | **accept** |
| derived, partial | `[class="pill pill--stage"]` | 0.95 | **fail** | reject |
| HN-1 | `[class="pill pill--stage"]` | 0.95 | **fail** | reject |
| HN-2 | `[class="pill pill--enroll"], [class="status"]` | **1.00** | pass | **reject** |
| HN-3 | `[data-stage], [class="phase"]` | **1.00** | pass | **reject** |

HN-2 and HN-3 are **numerically identical to a correct repair** — same conformance, same
null rate, same `failure_class` — and wrong in 20 and 19 rows out of 20. Nothing that
counts nulls can separate them, because the fields are all populated. HN-1 goes the other
way: it scores 0.95, which clears the 0.85 alert, so the dashboard goes green with one row
in twenty still wrong.

The two gates fail differently on purpose. Neither is sufficient.

### The judge

`historicalValueJudge` rules on agreement with the last healthy value, cites the specific
rows that disagree, and rejects on any doubt. It is narrower than the LLM judge the spec
describes — it can only speak about entities that existed before the break — but it
satisfies the rules that matter: decide from values, cite rows, reject when unsure.

The vocabulary check runs as a **warning that feeds the judge's evidence, never a veto**,
because the vocabulary is the thing EVOLVE exists to change: a legitimate new stage value
must not be rejected as a break.

Swapping in a model-backed judge changes nothing at the call site.

## Landing it

A derived repair still has to be approved and deployed, and then measured again.

```
scrape → signals → detect → ChangeRequest → diagnose → derive
  → two gates → SoftwareChange → human approve → deploy → re-scrape
  → verify → release or block
```

- **ChangeRequest** (`src/mend/change-request.mjs`) is opened by the conformance
  condition, not by a person. `type` is routed from `failure_class`, never chosen. It
  validates against its frozen schema on the way out.
- **SoftwareChange** (`src/mend/software-change.mjs`, unchanged) refuses an unverified
  change and refuses a self-approval. The heal's own gate results are routed in as its
  verification evidence, so the interlock has something real under it.
- **The scraper registry** (`src/mend/scraper-registry.mjs`) is where the repair lands.
  Without it the loop could approve a fix and re-run against the config it started with,
  which reads as a heal in the logs and changes nothing about tomorrow's scrape.
- **Verification** re-scrapes the same page with the new config. The bytes did not
  change; the scraper did. A repair can be derived, approved, deployed, and still leave
  the dataset **BLOCKED**, because release is decided by re-measuring and not by having
  applied a fix. A test proves that by moving the page between the gates and the re-scrape.

`mttr_seconds` is set only once `verification.verified` is true.

## Running it

```sh
npm run mend:heal                 # v4 → v2: derive, gate, approve, deploy, verify
npm run mend:heal -- --reject     # the interlock: reviewer declines, nothing deploys
npm run mend:heal -- --broken v3  # ambiguous — escalates rather than guessing
npm run mend:heal -- --broken v1  # outage — a selector repair cannot make rows appear
npm run mend:heal -- --reset      # forget the deployed repair and start over
npm run mend:heal -- --live       # against MEND_MERIDIAN_URL instead of the local tree
```

Over HTTP:

```sh
npm start
curl -X POST localhost:3000/mend/repair -H 'content-type: application/json' -d '{}'
curl -X POST localhost:3000/mend/runs   -H 'content-type: application/json' \
  -d '{"source":"meridian","mode":"break-x"}'
curl localhost:3000/mend/scraper
open http://localhost:3000/mend/repair
```

A repair persists: once one is deployed the next run finds nothing to fix, because the
deployed config now reads the changed page correctly. That is the loop working. `--reset`
is how the demo gets rehearsed twice.

## What this does not prove

- **We authored the break.** Meridian shows the loop works. It cannot show the loop
  matters, because we chose what broke and when. A live run against a source we do not
  control is what carries that claim.
- **Anchoring needs history.** A source with no healthy run behind it, or one that
  re-keys its rows during the redesign, yields nothing to anchor on. The loop escalates,
  which is correct, and it means the first break on a new source is never auto-repaired.
- **The judge is deterministic, not tuned.** Three hand-built near-misses are enough to
  prove the numeric gate is insufficient — which is what they are for — and nowhere near
  enough to tune a real judge against. The spec's corpus-mining and F1 reporting are not
  done.
- **The reference extractor is regex-based.** Fine against HTML we generate ourselves,
  and not what should run against a source we do not control. Bright Data does the real
  extraction; this is the offline oracle a proposed heal is checked with first.
- **One field at a time.** The diagnosis names a single field. A redesign that moves two
  independent fields at once would need two passes, and has not been tried.
