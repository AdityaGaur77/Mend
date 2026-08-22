# Meridian Therapeutics — the controlled break surface

> **Meridian Therapeutics is a fictional company.** It does not exist. No programme,
> compound, trial, phase, or result on this site is real. It was built to be broken on
> purpose so that a data pipeline can be observed failing and repairing. Every page carries
> `noindex, nofollow`, `robots.txt` disallows everything, and every page footer says the same
> thing. The Port catalogue entry sets `controlled: true` and the scrape span sets
> `source.controlled = true`, so the disclosure travels with the data rather than living only
> in this file.
>
> One real substance appears: **miltefosine**, listed as an in-licensed access programme. It
> is real, it is genuinely used for visceral leishmaniasis, and it is in ChEMBL — which is the
> point, because it gives the ChEMBL lookup something to hit next to twenty fictional codes
> that miss. No clinical claim is invented about it; the only fiction is that Meridian
> distributes it.

Meridian's attribute set is not invented either: it implements the canonical drug attributes
defined in Vinogradov et al., *LLM-Based Agents for Competitive Landscape Mapping in Drug Asset
Due Diligence* ([arXiv:2508.16571](https://arxiv.org/abs/2508.16571)). Every programme publishes
its aliases — 43 across 20 programmes, spanning development codes, partner codes, INNs, salt
forms and one brand name — because that paper's central data argument is that no controlled
vocabulary covers the drug-name alias tail. Publishing them lets the ChEMBL cross-check try every
alias and *still* miss, which makes `long-tail-only` a demonstrated result rather than an
assumption. Details in [docs/PRIOR-ART.md](docs/PRIOR-ART.md).

## What this is for

Mend watches drug-programme data for neglected diseases, which lives on HTML pages rather than
in APIs. When one of those pages is redesigned, a scraper does not usually crash. It returns
**200 OK with the right number of rows and quietly wrong data**. That is the failure worth
detecting, and it is hard to demo against someone else's website because you cannot make them
redesign it on cue.

So this is our website, in four versions.

**v4 is the healthy baseline**, not v1. The version numbers are release order on
Meridian's side — v4 is `Meridian Web 2.3.1`, the oldest page here — and the demo runs
v4 → v2, not v1 → v2. Worth reading twice; it is the one confusing thing about this
fixture.

| | Generator | What changed | `rows_returned` | `schema_conformance` | `failure_class` | Route |
|---|---|---|---|---|---|---|
| **v4** | 2.3.1 | the healthy page | 20 | 1.00 | `none` | — |
| **v1** | 3.0.0 | source outage — the payload arrives empty | **0** | 0.00 | `empty_result` | REPAIR |
| **v2** | 2.4.0 | Phase and Status merged into status pills; Partner moved ahead of Indication; new stylesheet | **20** | **0.05** | `selector_drift` | REPAIR |
| **v3** | 3.1.0 | Indication renamed to `data-disease`, Target column added | 20 | 0.00 | `upstream_shape_change` | ESCALATE |

Between v4 and v2 the row count does not move. That is the entire point, and it is why
v2 is the demo: v1 is the loud failure everyone already detects, and v3 is the ambiguous
one nothing should attempt to auto-repair.

`test/signals.test.mjs` asserts every number in that table, so it is a test of the pages
rather than a claim about them.

## The exact diff between versions

Nothing here is hidden — a demo that depends on the audience not knowing what we changed is a
worse demo.

**v1 → v2.** The pipeline table was redesigned:

```html
<!-- v1 -->
<td class="phase">Phase 2</td>
<td class="status" data-status="Recruiting">Recruiting</td>

<!-- v2 -->
<td class="status-cell" data-status="Recruiting">
  <span class="pill pill--stage" data-stage="phase-2">Phase 2</span>
  <span class="pill pill--enroll">Recruiting</span>
</td>
```

Alongside that: a new stylesheet, a rounded scroll shell, restyled header cells, reworded
column labels (`Updated` → `Last update`), the Partner column moved ahead of Indication, and
`<meta name="generator">` bumped from `Meridian Web 2.3.1` to `2.4.0`.

Every row keeps its `data-program`, `data-compound`, `data-indication`, `data-modality`,
`data-status`, `data-partner` and `data-updated` attributes, because real redesigns preserve
the data attributes their own JavaScript depends on. So every field except `phase` keeps
resolving, rows keep parsing, and nothing throws.

`phase` was the one field that only ever existed as display text. That asymmetry is what turns
a routine redesign into a silent failure — and it is the ordinary case, not a contrived one.

**One row is left behind.** `MRD-2210` is discontinued, and its status cell still renders
through the pre-refresh partial, so it still emits `<span class="phase">`. The null rate is
therefore **19/20 = 0.95**, not 1.00. The single phase value a stale scraper can still read
belongs to a programme that was killed in Q1 2026 — data that is worse than missing.

**v2 → v3.** A `Target` column, on the pipeline table and on each programme page. Nothing
else. `unmapped_fields_seen: ["target"]`, conformance untouched.

## Running it

```sh
npm test                       # 47 assertions: the break is what we say it is
npm run site:build             # data/ + templates/ -> versions/v1, v2, v3, v4
npm run site:activate v4       # versions/v4 -> public/  (the healthy baseline)
npm run site:serve             # http://localhost:4173
```

No dependencies. Node 18+, nothing to install.

### Shipping the break

```sh
npm run site:activate v2
git commit -am "redesign: merge phase into development status"
git push                       # Vercel redeploys in ~30s
```

The canonical URL `/pipeline` never changes and the scraper config never learns that versions
exist. Reverting is `npm run site:activate v4` and another push.

`versions/` and `public/` are **committed on purpose**. The rendered HTML is the artefact — the
v1→v2 diff in git is what a redesign actually looks like, and that diff is part of the demo.
Rendering is deterministic (no timestamps, no build ids), so a rebuild on unchanged input
produces no diff and `git status` stays a useful check.

### Checking the break by hand

```sh
npm run site:activate v2 && npm run site:serve

curl -s localhost:4173/pipeline/ | grep -c '<tr[^>]*data-program='   # 20  <- flat
curl -s localhost:4173/pipeline/ | grep -c 'class="phase"'           # 1   <- the break
curl -s localhost:4173/pipeline/ | grep -c 'noindex'                 # 1
```

## The numbers, verified

`src/extract.mjs` is a reference extractor — **not** the production scraper, which is Bright
Data's job. It exists so the numbers in [`contracts/telemetry.md`](contracts/telemetry.md) can
be checked by anyone, offline, in a second, and so the agent track has an oracle to test a
proposed heal against before spending a collector run on it.

```
v4 baseline     rows=20 conf=1.00 phaseNull=0.00 unmapped=[]               none                  -> none
v1 baseline     rows= 0 conf=0.00 phaseNull=-    unmapped=[]               empty_result          -> repair
v2 baseline     rows=20 conf=0.05 phaseNull=0.95 unmapped=[]               selector_drift        -> repair
v2 healed_naive rows=20 conf=0.95 phaseNull=0.05 unmapped=[]               none                  -> none
v2 healed       rows=20 conf=1.00 phaseNull=0.00 unmapped=[]               none                  -> none
v3 baseline     rows=20 conf=0.00 phaseNull=0.95 unmapped=[disease,target] upstream_shape_change -> escalate
v3 healed       rows=20 conf=0.00 phaseNull=0.00 unmapped=[disease,target] upstream_shape_change -> escalate
```

`test/signals.test.mjs` asserts every one of those numbers, so the telemetry contract is not a
claim about the pages — it is a test of them.

### The heal has two rounds by construction

Because of the leftover archived row:

| selector | phase read | conformance |
|---|---|---|
| baseline `.phase` | 1/20 | 0.05 |
| naive heal `.pill--stage` | 19/20 | **0.95** |
| correct heal `.pill--stage, .phase` | 20/20 | 1.00 |

The naive heal scores **above the 0.85 alert threshold**. The alert clears, the dashboard goes
green, one row in twenty is still wrong. So a repair is not verified by the alert going quiet:

```
verified  ⟺  conformance_after >= conformance_before_the_break
```

An alert threshold is a detector, not an acceptance test. Wiring one up as the other is how a
self-healing system convinces itself it fixed something. This is also why the rejection beat in
the demo has a real reason behind it, rather than being theatre.

### And the numeric bar is not sufficient either

Two of the three mined hard negatives in `src/extract-core.mjs` score **conformance 1.00, null
rate 0.00, `failure_class: none`** — numerically identical to a correct repair — while being
wrong in 19 and 20 rows out of 20 respectively. HN-2 reads the pill next to the right one and
returns enrolment statuses for every programme; HN-3 reads the machine slug and returns
`"phase-2"` instead of `"Phase 2"`. Nothing that counts nulls can separate them from a genuine
fix, because the fields are all populated.

So release needs **two gates**: `numeric bar passes AND validator accepts`. See
[contracts/repair-validator.md](contracts/repair-validator.md); the evidence is pinned in
`test/hard-negatives.test.mjs`, and `/control` shows it live.

### v3 escalates either way

v3 builds on v2's redesign and then renames `data-indication` to `data-disease` while adding a
`target` column. So it breaks a field *and* grows one in the same release, which is genuinely
ambiguous — if the new field carries the old one's data this is a rename, and if it does not
this is a break plus an unrelated addition. Both readings fit the signals.

That routes to `upstream_shape_change` → **ESCALATE**, and it stays there even for a scraper
healed during v2, because healing `phase` does nothing for `indication`. Guessing here is how a
self-healing system quietly corrupts data, so v3 is the beat where the factory declines to act.

`npm run mend:heal -- --broken v3` shows it declining.

## The break button

`/control` flips which version the server returns at `/pipeline`, in under a second, without a
redeploy. All four versions are always deployed at `/_v/v1` … `/_v/v4`; an Edge
Middleware rewrites `/pipeline` to whichever one a pointer in Vercel Edge Config names.

```
control room  ──POST /api/activate──>  Edge Config pointer
                                             │
/pipeline ──> middleware reads pointer ──> rewrite to /_v/<version>/pipeline  (static file)
```

The control room also reads `/pipeline` live and shows what a scraper would currently get —
rows, conformance, phase null rate, unmapped fields, failure class, route — computed by the same
module the test suite asserts against (`src/extract-core.mjs`, parity enforced by
`test/parity.test.mjs`). If SigNoz is not up, that table still shows the flat-line-and-cliff.

### Three properties this design protects

1. **`/pipeline` can never 500.** The matcher is scoped to `/pipeline/:path*`, the whole
   middleware body is inside a try/catch, and every failure path returns undefined, which serves
   the static file already deployed there. A broken pointer, an Edge Config outage, an expired
   token — all fall through. `test/route-version.test.mjs` pins the decision function against
   every malformed input we could think of.
2. **Zero setup still works.** With no `EDGE_CONFIG` the middleware is a no-op and the site
   behaves exactly as it did before any of this existed. The control room says switching is
   unavailable and why, and its signal table still works. The demo does not depend on it.
3. **The switch is authenticated.** `/api/activate` requires `x-control-token` matching
   `CONTROL_TOKEN`, or 401. The Vercel API token that performs the write stays server-side and
   never reaches the browser.

### Vercel setup

| env var | purpose |
|---|---|
| `EDGE_CONFIG` | auto-injected when you connect an Edge Config store to the project |
| `EDGE_CONFIG_ID` | `ecfg_…` — only needed if it cannot be parsed from `EDGE_CONFIG` |
| `VERCEL_API_TOKEN` | writes the pointer |
| `CONTROL_TOKEN` | the shared secret the control room prompts for |
| `VERCEL_TEAM_ID` | only if the Edge Config store belongs to a team |

Reads use plain `fetch` against the Edge Config endpoint, so **no `@vercel/edge-config`
dependency is added to this repo.**

### Locally

`npm run site:serve` implements `/api/activate` itself by running `scripts/activate.mjs`, so the
whole demo — control room, buttons, live signals — is rehearsable offline with no Vercel, no
Edge Config and no tokens. Different mechanism, same observable result at `/pipeline`.

## Fixture modes

The scaffold's `normal | fail | recover` modes map onto the versions:

| mode | HTML | scraper config |
|---|---|---|
| `normal` | `versions/v4` | whatever is deployed |
| `break-x` | `versions/v2` | whatever is deployed |
| `repaired` | `versions/v2` | whatever is deployed |

`repaired` serves **the same bytes** as `break-x`. What changed is the scraper, not the page.
Worth saying out loud in the demo — it is the difference between healing and papering over.
There are no separate fixture copies to drift out of sync, because the fixtures *are*
`versions/`.

Note that all three rows say the same thing about the config: the factory reads it from the
scraper registry rather than selecting one per mode, so `repaired` is only repaired if a heal
was actually approved and deployed first. See `../src/mend/meridian-runners.mjs`.

## What is here

```
data/programs.json          20 programmes — the single source of truth
templates/                  layout, shared home + detail, four pipeline renderers, four stylesheets
control/                    the control room — index.html, control.js, control.css
scripts/                    build.mjs, activate.mjs, serve.mjs — no dependencies
versions/v1 v2 v3 v4        committed rendered HTML, 23 pages each
public/                     committed, deploys: canonical + _v/{v1,v2,v3,v4} + control/
src/extract-core.mjs        extraction + signals, pure — shared by Node and the browser
src/extract.mjs             Node binding (the oracle the tests assert against)
src/extract-web.mjs         browser binding for the control room
src/validate.mjs            ~60-line JSON Schema subset validator, zero deps
src/route-version.mjs       pure middleware routing decision, unit-tested
contracts/                  record schema, ChangeRequest schema, telemetry, repair-validator
docs/PRIOR-ART.md           the Bioptic paper and what Mend takes from it
port/                       5 blueprints + the release-readiness scorecard
observability/signoz/       dashboard + 3 alert rules
test/                       69 assertions
CONTRACTS.md                the frozen contract — paste into CLAUDE.md at port-over
PITCH.md                    what Mend is and why

../middleware.js            Edge Middleware: rewrites /pipeline to the selected version
../api/activate.js          the switch the control room calls
```

## Deploying

Bright Data scrapes from its own infrastructure, so the page has to be publicly reachable — it
cannot be served from localhost. That is also why "push v2" is a real deploy rather than a flag
flip, which makes the demo beat more honest, not less.

The repo root `vercel.json` points at `mend/public`, so a Vercel project on this repo with the
default root directory serves Meridian and nothing else. Two things follow, and both matter:

- **Do not deploy this repo root without that file.** `package.json` declares
  `"start": "node src/server.mjs"`, and Vercel's zero-config Node detection will wrap the
  scaffold's fixture server as a serverless function. It calls `createServer().listen()`, boots
  OTLP exporters against an endpoint that does not exist in a lambda, and reads a gitignored
  artifact — it crashes with `FUNCTION_INVOCATION_FAILED`. The root `vercel.json` sets an
  explicit `outputDirectory`, which stops that detection.
- **Every Meridian page is still static HTML with no JavaScript.** `/pipeline` and everything
  under it has no runtime that can fail. The control room at `/control` does ship JS, and
  `/api/activate` is a function — those are separate surfaces, and the distinction matters: the
  thing being scraped has no moving parts.
- `cleanUrls` and `trailingSlash` are deliberately **not** set. Both would put a 308 in front of
  `/pipeline` — the URL Bright Data scrapes — and in front of `POST /api/activate`. Directory
  indexes are served at both `/pipeline` and `/pipeline/` without either.

Alternative, if you would rather leave the repo root free for a future backend deploy: delete
the root `vercel.json` and set the Vercel project's **Root Directory to `mend`** instead.
`mend/vercel.json` then applies on its own — `outputDirectory: "public"`, `cleanUrls`, and an
`X-Robots-Tag: noindex, nofollow` header on everything.

Either way, `npm run site:activate v2 && git push` flips the live page in about 30 seconds, and
the canonical `/pipeline` URL never changes.

## Honest failure modes

- **We authored the break.** Meridian proves the loop works. It cannot prove the loop matters,
  because we chose what broke and when. The live run against DNDi is what carries that claim,
  and it is not optional.
- **`phase` was made breakable.** Every other field carries a data attribute; `phase` does not.
  That is a real pattern — display-only fields are exactly the ones that move in a redesign —
  but we did choose it. Stated here rather than discovered by a judge.
- **The reference extractor is regex-based.** Fine against HTML we generate ourselves; it is
  not what should ever run against DNDi. Bright Data does the real extraction.
- **`src/validate.mjs` implements a subset of JSON Schema** — type, required, properties,
  additionalProperties, minLength, pattern, minimum/maximum, enum, items. No `$ref`, no
  `allOf`/`anyOf`/`oneOf`, `format` is advisory. It covers `record.schema.json` completely and
  would need replacing with ajv for anything richer.
- **The SigNoz dashboard and alert JSON are hand-authored** against the v4 dashboard and
  threshold-rule shapes. They have not been round-tripped through a running SigNoz instance, so
  expect to fix field names on first import.
- **The Port scorecard's `human_approved` rule** expresses "a verified change request is
  related to this source". Port's query DSL for cross-blueprint conditions varies by version;
  treat that rule as intent to be adjusted against the live API rather than as working config.
- **The unrendered canonical attributes are the EVOLVE queue, not dead data.** `moa`,
  `therapeuticArea`, `regulatoryStatus`, `otherIndications` and `route` sit in
  `data/programs.json` and are published by no version yet. Each is one template change away
  from being the next EVOLVE beat. See [docs/PRIOR-ART.md](docs/PRIOR-ART.md).
- **The middleware and `/api/activate` have not been run on Vercel.** They are written against
  the documented contracts and the routing decision is unit-tested, but Edge Config needs a
  one-time dashboard step that cannot be done from here. The fallback is designed so that if any
  of it is wrong, the site serves the deployed version rather than failing.
- **The Repair-Validator is a spec, not an implementation.** `contracts/repair-validator.md`
  defines the interface and the negative corpus; no judge has been built or tuned.
- **`HARD_NEGATIVES` is three entries.** The paper mined a labelled corpus across 100
  indications. Three hand-built near-misses are enough to prove the numeric gate is insufficient
  — which is what they are for — and nowhere near enough to tune a judge against.

## Not in this task

The tracker, the Bright Data collector (still pointed at `example.com`), the Port workflow
automation, the SigNoz deployment, and the DNDi and ChEMBL integrations. All of them build
against [`CONTRACTS.md`](CONTRACTS.md), which is frozen here so those tracks can run in parallel
and integrate early rather than late.

The diagnosis and repair loop is no longer in this list — it lives in `../src/mend/` and is
documented in [`../docs/MEND_HEALING.md`](../docs/MEND_HEALING.md). The Repair-Validator is
implemented there as a deterministic judge rather than the LLM one
[`contracts/repair-validator.md`](contracts/repair-validator.md) specifies; the interface is
the one in that spec, so a model-backed judge drops in without changing the caller.
