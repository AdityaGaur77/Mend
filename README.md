# Mend

**A website built to break itself, and a factory that derives the repair from the page.**

Drug-programme data for neglected diseases lives on HTML pages, not APIs. When one of
those pages is redesigned a scraper does not usually crash — it returns **200 OK with the
right number of rows and quietly wrong data**. That is the failure worth catching, and it
is hard to demo against someone else's website because you cannot make them redesign it
on cue.

So this repo contains both halves: the page, and the loop that repairs the scraper.

```sh
npm install
npm test          # 172 assertions
npm run mend:heal # watch the whole loop, offline, no credentials
```

## The break

`mend/` is Meridian Therapeutics — a **fictional** biotech pipeline site, published as
static HTML in four versions. Nothing on it is real. v2 is a routine redesign that merges
the phase column into status pills; every row keeps its `data-*` attributes, because a
site's own JavaScript depends on them.

| | what it is | `rows_returned` | `schema_conformance` | `failure_class` | route |
|---|---|---|---|---|---|
| **v4** | the healthy baseline | 20 | 1.00 | `none` | publish |
| **v1** | a source outage | **0** | 0.00 | `empty_result` | REPAIR |
| **v2** | the silent break | **20** | **0.05** | `selector_drift` | REPAIR |
| **v3** | a field moved *and* one appeared | 20 | 0.00 | `upstream_shape_change` | ESCALATE |

**v4 is the baseline, not v1** — the numbers are Meridian's own release order.

Between v4 and v2 the row count does not move. Nothing that watches error rate, HTTP
status or row count sees this, which is why the alerts key on conformance and never on
error rate. `mend/test/signals.test.mjs` asserts every number in that table, so it is a
test of the pages rather than a claim about them.

## The heal

The repair is **derived from the page**, not selected from a list.

A healthy run stores what each row said — MRD-4471 at `Phase 2`, MRD-2210 at
`Discontinued`. A redesign moves data, it rarely deletes it, so the synthesizer searches
the changed markup for where those values went and covers rows greedily until every one
is explained. On v2 it finds the new stage pill covering 19 rows and **keeps going**,
because one archived row still renders through the pre-refresh partial — arriving at the
union without being told a union was needed.

Two properties fall out of anchoring on values, and they are why it was chosen:

- **It cannot invent a plausible wrong answer.** The mined hard negatives read the
  neighbouring pill (`Recruiting`) and the machine slug (`phase-2`). Neither equals any
  anchor, so neither is ever generated.
- **It refuses rather than guesses.** No anchors, no repair — the run escalates.

### Two gates, both required

Every candidate goes through both, and the mined hard negatives ride along on every run,
so this table is computed at run time rather than quoted:

| proposal | reads | conformance | numeric bar | validator |
|---|---|---|---|---|
| derived | `[class="pill pill--stage"], [class="phase"]` | 1.00 | pass | **accept** |
| derived, stopping early | `[class="pill pill--stage"]` | 0.95 | **fail** | reject |
| HN-2 | `[class="pill pill--enroll"], [class="status"]` | **1.00** | pass | **reject** |
| HN-3 | `[data-stage], [class="phase"]` | **1.00** | pass | **reject** |

HN-2 and HN-3 are **numerically identical to a correct repair** and wrong in 20 and 19
rows out of 20. Nothing that counts nulls separates them — only reading the values does.
HN-1 goes the other way: 0.95 clears the 0.85 alert threshold while one row in twenty is
still wrong.

So the numeric bar is `conformance_after >= conformance_before_the_break` — the pre-break
baseline, **never the alert threshold** — and the validator decides from values and never
sees a conformance number, because a judge told "conformance is 1.00" anchors on it.

**"Conformance is back to 1.00" and "the data is right" are different claims, and only
the first is measurable by counting.**

### Then it has to land

```
scrape → signals → detect → ChangeRequest → diagnose → derive
  → two gates → SoftwareChange → human approve → deploy → re-scrape
  → verify → release or block
```

The ChangeRequest is opened by the conformance condition, not by a person. A repair
deploys only behind a change approved by someone other than its author. And **release is
decided by re-measuring** — a repair can be derived, approved, deployed and still leave
the dataset `BLOCKED`.

## Running it

```sh
npm run mend:heal                 # v4 → v2: derive, gate, approve, deploy, verify
npm run mend:heal -- --reject     # the interlock: reviewer declines, nothing deploys
npm run mend:heal -- --broken v3  # ambiguous — escalates rather than guessing
npm run mend:heal -- --broken v1  # outage — a selector repair cannot make rows appear
npm run mend:heal -- --reset      # forget the deployed repair and start over
npm run mend:heal -- --live       # against MEND_MERIDIAN_URL instead of the local tree
```

A repair persists: once one is deployed the next run finds nothing to fix, because the
deployed config now reads the changed page correctly. That is the loop working — `--reset`
is how the demo gets rehearsed twice.

### The visual demo

Two terminals, no credentials, nothing deployed:

```sh
npm run site:serve   # localhost:4173 — the website and the control room
npm start            # localhost:3000 — the factory
```

1. **`localhost:4173/pipeline`** — 20 programmes, healthy.
2. **`localhost:4173/control`** — the control room. Conformance 1.00.
3. **Click v2.** The page redesigns live at the same URL. Rows still 20, conformance
   falls to 0.05. *This is the pitch.*
4. **`npm run mend:heal -- --reset`** — the candidate table, hard negatives rejected.
5. **`localhost:3000/mend/repair`** — the same thing as a page.

Offline, `site:serve` implements `/api/activate` itself, so the break button works with
no Vercel, no Edge Config and no tokens.

### Over HTTP

```sh
curl -X POST localhost:3000/mend/repair -H 'content-type: application/json' -d '{}'
curl -X POST localhost:3000/mend/runs   -H 'content-type: application/json' -d '{"mode":"break-x"}'
curl localhost:3000/mend/scraper
```

`/mend/runs` runs the X/Y/Z slice with Meridian behind X. When the page breaks, X goes
`STALE_HEALTHY` and keeps serving its last good records while structural readiness (Y) and
IP activity (Z) stay published — one source moving a selector must not take the other two
down with it.

## Deploying the site

Root `vercel.json` points at `mend/public`, so a Vercel project on this repo serves
Meridian. That file also stops Vercel's zero-config Node detection from wrapping
`src/server.mjs` as a serverless function, which would crash on boot. The factory API is
**not** deployed by that config — it runs locally.

`npm run site:activate v2 && git push` flips the live page in about 30 seconds, and the
canonical `/pipeline` URL never changes. See [`mend/README.md`](mend/README.md) for the
Edge Config switch that flips versions without a redeploy.

## Where things are

```
mend/                     the website — data, templates, four rendered versions, contracts
mend/src/extract-core.mjs extraction + signals, shared by the Node oracle and the browser
mend/contracts/           record schema, ChangeRequest schema, telemetry, repair-validator
src/mend/heal.mjs         diagnosis, selector synthesis, both gates
src/mend/selector-plan.mjs a scraper config as data, so a repair can be diffed and reviewed
src/mend/repair-loop.mjs  detect → approve → deploy → re-measure
src/mend/scraper-registry.mjs where a repair actually lands
src/axes/x-meridian.mjs   the X axis, reading real HTML
observability/signoz/     dashboards and alert rules
port/                     the catalogue model
docs/MEND_HEALING.md      the full design, and what it does not prove
```

## What this does not prove

- **We authored the break.** Meridian shows the loop works. It cannot show the loop
  matters — a live run against a source we do not control is what carries that claim.
- **Anchoring needs history.** A source with no healthy run behind it, or one that
  re-keys its rows during a redesign, yields nothing to anchor on. The first break on a
  new source is never auto-repaired.
- **The judge is deterministic, not tuned.** Three hand-built near-misses prove the
  numeric gate is insufficient. They are nowhere near a tuned validator.
- **The reference extractor is regex-based.** Fine against HTML we generate ourselves,
  and not what should run against a source we do not control.

Full detail in [`docs/MEND_HEALING.md`](docs/MEND_HEALING.md).

---

> Meridian Therapeutics is fictional. Every page carries `noindex, nofollow`, `robots.txt`
> disallows everything, the Port entity sets `controlled: true` and the scrape span sets
> `source.controlled = true` — the disclosure travels with the data rather than living
> only in a README.
