# Prior art

**Vlad Vinogradov, Alisa Vinogradova, Dmitrii Radkevich, Ilya Yasny, Dmitry Kobyzev, Ivan
Izmailov, Katsiaryna Yanchanka, Roman Doronin, Andrey Doronichev.** *LLM-Based Agents for
Competitive Landscape Mapping in Drug Asset Due Diligence.* Bioptic.io / Lance BioVentures.
[arXiv:2508.16571](https://arxiv.org/abs/2508.16571).

A competitor-discovery agent that, given an indication, retrieves the drugs making up its
competitive landscape and extracts canonical attributes. 83% recall against OpenAI Deep
Research at 65% and Perplexity Labs at 60%; in production, analyst turnaround on competitive
analysis fell from 2.5 days to ~3 hours.

Same domain as Mend, different half of the problem: they retrieve and validate, we detect when
an existing retrieval has quietly stopped working. Three things here are load-bearing for Mend.

## 1. The canonical attribute set

Their §2 defines the per-drug attributes worth extracting: **name aliases, modality (type),
mechanism(s) of action, targets, development stage, regulatory status, therapeutic area, other
indication(s), administration routes, company information.**

`data/programs.json` implements that set, which is why Meridian's schema is not invented:

| Paper | Meridian field | Published in |
|---|---|---|
| name aliases | `aliases[]` | detail pages, all versions |
| modality (type) | `modality` | pipeline table |
| mechanism(s) of action | `moa` | — *(EVOLVE queue)* |
| targets | `target` | pipeline table, **v3 only** — the EVOLVE beat |
| development stage | `phase` | pipeline table — **the field v2 breaks** |
| regulatory status | `regulatoryStatus` | — *(EVOLVE queue)* |
| therapeutic area | `therapeuticArea` | — *(EVOLVE queue)* |
| other indication(s) | `otherIndications[]` | — *(EVOLVE queue)* |
| administration routes | `route` | — *(EVOLVE queue)* |
| company information | n/a | single-company site |

The unpublished rows are the point. EVOLVE now has a queue of fields with a citation behind
each one, rather than whatever we felt like adding next. v3 shipping `target` is the first item
on a real list.

## 2. The alias tail

From p.6: drug names surface as development codes, regional brands, and salt/route strings, and
no single controlled vocabulary — RxNorm, DrugBank, Martindale, WHODrug, EMA xEVMPD — covers the
full alias tail. Their example: an FDA normalisation of 2024 FAERS opioid reports collapsed
7,892 free-text strings to 92 RxNorm ingredients, and only after repeated API lookups and manual
edits.

This is the citation behind Mend's ChEMBL beat. Meridian publishes every alias it has (43 across
20 programmes: development codes, partner codes, INNs, salt forms, one brand name). The
cross-check tries all of them and still misses for the MRD codes — so `long-tail-only` is a
demonstrated result rather than an assumption, and the miltefosine row hits precisely because a
marketed drug has vocabulary coverage that a long-tail asset does not.

## 3. Judging on mined hard negatives

Their central method: a post-retrieval LLM-as-a-judge tuned against **hard near-misses** —
umbrella terms, out-of-scope indications, withdrawn programmes — reaching 88.0% F1, with both
judges wired into CI/CD.

Mend's analogue is [`contracts/repair-validator.md`](../contracts/repair-validator.md), judging
repairs instead of competitors. The negative corpus is real and already in the fixture:
`HARD_NEGATIVES` in `src/extract-core.mjs` holds three proposed heals, two of which are
numerically indistinguishable from a correct repair and wrong in 19–20 rows out of 20.

Their framing is what made us look for those. Without it we would have shipped the numeric
conformance bar as the acceptance test and never discovered that two plausible repairs walk
straight through it.

## What the paper independently supports

- **Data in this domain is fragmented, alias-heavy, ontology-mismatched and rapidly changing**
  (abstract) — Mend's premise, from a group running it in production.
- **Frontier models both omit valid answers and hallucinate**, which is why they added a
  post-retrieval filter rather than trusting the agent. Mend's "never trust 'repair succeeded';
  measure it" is the same instinct applied to self-healing.
- **Judges belong in CI**, not just in the demo.
