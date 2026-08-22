// Home and program-detail pages.
//
// These are deliberately stable across v1/v2/v3 in structure — the redesign in v2
// ships as a new stylesheet here, not new markup. Only the pipeline table changes
// shape, because the pipeline table is the scrape target and a demo is easier to
// read when exactly one thing moved. v3 is the exception: it starts publishing the
// molecular target, on the detail page as well as in the table.

import { page, esc, humanDate } from './layout.mjs';

const showsTarget = (version) => version === 'v3';

export function home(data, version) {
  const { company, programs } = data;
  const clinical = programs.filter((p) => p.phase.startsWith('Phase'));
  const late = programs.filter((p) => p.phase === 'Phase 2' || p.phase === 'Phase 3');
  const partners = [...new Set(programs.map((p) => p.partner).filter((x) => x !== '—'))];

  const body = `    <section class="hero">
      <h1>${esc(company.tagline)}</h1>
      <p class="hero__lede">Meridian is a clinical-stage company working on kinetoplastid and helminth
      infections — diseases with millions of patients and almost no commercial pull. We run
      ${clinical.length} clinical-stage programmes and ${programs.length - clinical.length} earlier ones.</p>
      <p><a class="button" href="./pipeline/">See the pipeline</a></p>
    </section>

    <section class="panel">
      <h2>Where the work is</h2>
      <ul class="stat-row">
        <li class="stat"><span class="stat__num">${programs.length}</span><span class="stat__label">Programmes</span></li>
        <li class="stat"><span class="stat__num">${late.length}</span><span class="stat__label">Phase 2 or later</span></li>
        <li class="stat"><span class="stat__num">${partners.length}</span><span class="stat__label">Product-development partners</span></li>
        <li class="stat"><span class="stat__num">${company.founded}</span><span class="stat__label">Founded</span></li>
      </ul>
      <p class="panel__note">Partners: ${esc(partners.join(', '))}. Portfolio last reviewed
      ${esc(humanDate(company.pipelineUpdated))}.</p>
    </section>

    <section class="panel">
      <h2>Late-stage programmes</h2>
      <ul class="teaser-list">
${late
  .map(
    (p) => `        <li><a href="./pipeline/${esc(p.slug)}/"><strong>${esc(p.program)}</strong>
          <span>${esc(p.indication)}</span> <em>${esc(p.phase)}</em></a></li>`
  )
  .join('\n')}
      </ul>
    </section>`;

  return page({
    version,
    title: 'Home',
    description: company.tagline,
    body,
    depth: 0,
    bodyClass: 'page-home',
  });
}

export function about(data, version) {
  const body = `    <section class="hero about-hero">
      <p class="eyebrow">A self-healing data factory</p>
      <h1>Keep a research landscape alive after the web changes.</h1>
      <p class="hero__lede">Drug-program evidence for neglected and rare diseases often lives on pages,
      not APIs. Mend turns those fragile sources into a versioned, validated research view and makes
      failure, repair, approval, and release visible.</p>
      <p><a class="button" href="./../control/">Watch the controlled break</a></p>
    </section>

    <section class="panel about-grid">
      <div>
        <h2>The problem</h2>
        <p>Web pages change without notice. A scraper can return rows that look fine while one important
        field has quietly gone null, or an integration can return nothing at all. Mend treats external
        evidence as untrusted until it passes a contract for shape, completeness, and volume.</p>
      </div>
      <div>
        <h2>The promise</h2>
        <p>A failed run is isolated and quarantined. The last trustworthy release stays available while
        a bounded repair is proposed, tested, reviewed by a human, and released only after verification.</p>
      </div>
    </section>

    <section class="panel">
      <h2>One target, three evidence axes</h2>
      <p>Mend joins the questions that decide whether a research opportunity is worth pursuing. Scores are
      signals with explicit rules, not legal or investment conclusions.</p>
      <div class="axis-grid">
        <article class="axis-card"><span class="axis-card__key">X</span><h3>Pipeline activity</h3><p>Is anyone building it? Programmes, development stage, organizations, new entrants, and phase movement.</p><small>Pipeline pages · Open Targets · ChEMBL · trial registries</small></article>
        <article class="axis-card"><span class="axis-card__key">Y</span><h3>Structure quality</h3><p>Is the science ready? Disease-state form, resolution, experimental method, human relevance, and ligand or partner context.</p><small>EMDB · RCSB PDB · UniProt</small></article>
        <article class="axis-card"><span class="axis-card__key">Z</span><h3>Freedom to act</h3><p>Is the space open? Patent activity, assignees, dependencies, expiry signals, and open or nonprofit participation.</p><small>PatentsView · Lens · FDA books · trial collaborators</small></article>
      </div>
      <p class="panel__note"><strong>Map interpretation:</strong> high X/low Y means “racing blind”; low X/high Y/high Z is an “open opportunity”; high X/high Y/low Z is “solved and crowded.” Z is an IP activity signal, never a freedom-to-operate opinion.</p>
    </section>

    <section class="panel">
      <h2>The factory loop</h2>
      <ol class="factory-steps">
        <li><strong>Discover and scrape</strong><span>Collect evidence from allowed public sources through replaceable adapters.</span></li>
        <li><strong>Normalize and verify</strong><span>Apply shared contracts, null-rate gates, row-count checks, and source evidence requirements.</span></li>
        <li><strong>Quarantine on failure</strong><span>Keep bad output out of the release and preserve the last-known-good snapshot.</span></li>
        <li><strong>Repair and approve</strong><span>Generate a bounded repair, retest it against the contract, and require human approval.</span></li>
        <li><strong>Diff, release, observe</strong><span>Publish only verified data and record what changed, why, and which run produced it.</span></li>
      </ol>
    </section>

    <section class="panel about-grid">
      <div>
        <h2>What the tools contribute</h2>
        <ul class="plain-list"><li><strong>Scraper Studio:</strong> reusable extraction and repair previews.</li><li><strong>SigNoz:</strong> traces, validation failures, repair events, durations, and row counts.</li><li><strong>Port:</strong> source context, repair proposals, approval, risk, and release decisions.</li><li><strong>GitHub:</strong> versioned contracts, adapters, tests, and release history.</li></ul>
      </div>
      <div>
        <h2>What this demo proves</h2>
        <ul class="plain-list"><li><strong>v1:</strong> an empty-result outage is visible and routed to repair.</li><li><strong>v2:</strong> selector drift can be silent even when row counts stay flat.</li><li><strong>v3:</strong> a schema change can require escalation, not a guessed fix.</li><li><strong>v4:</strong> the original healthy release can be restored.</li></ul>
      </div>
    </section>

    <section class="panel about-limits">
      <h2>Honest limits</h2>
      <p>Mend does not claim that rare diseases have no data, that a quiet company page is healthy, or that a Z score is legal advice. Freshness stamps and independent cross-checks are needed to detect sources that stop updating. Enrichment gaps are marked unknown rather than scored as zero, and illustrative map positions are labeled until enrichment runs.</p>
      <p class="panel__note">This site is a fictional, noindex demonstration. The underlying research view is intended to show the factory’s contracts and recovery behavior, not to provide medical, scientific, investment, or legal advice.</p>
    </section>

    <section class="panel references">
      <h2>Further reading</h2>
      <ul class="plain-list"><li><a href="https://arxiv.org/abs/2508.16571" target="_blank" rel="noopener">LLM-Based Agents for Competitive Landscape Mapping in Drug Asset Due Diligence</a></li><li><a href="https://platform-docs.opentargets.org/target/tractability" target="_blank" rel="noopener">Open Targets tractability</a></li><li><a href="https://www.ebi.ac.uk/emdb/" target="_blank" rel="noopener">EMDB</a> · <a href="https://www.rcsb.org/" target="_blank" rel="noopener">RCSB PDB</a> · <a href="https://www.uniprot.org/" target="_blank" rel="noopener">UniProt</a></li></ul>
    </section>`;

  return page({
    version,
    title: 'How Mend works',
    description: 'How Mend validates, repairs, and releases neglected-disease research data.',
    body,
    depth: 1,
    bodyClass: 'page-about',
  });
}

/**
 * "Also known as" — every published name for a programme.
 *
 * Present in all three versions: this is baseline content, not a version signal.
 * It exists because drug names are alias-heavy — a single asset surfaces as a
 * development code, a partner code, an INN, a salt string, or a brand name, and no
 * controlled vocabulary covers the whole tail (Vinogradov et al., arXiv:2508.16571,
 * p.6). Publishing them lets the ChEMBL cross-check try every alias before it
 * concludes long-tail-only, which turns that flag from an assumption into a result.
 */
function aliasRow(p) {
  const chips = p.aliases
    .map((a) => `<span class="alias" data-alias="${esc(a)}">${esc(a)}</span>`)
    .join('\n          ');
  return `        <dt>Also known as</dt>
        <dd class="aliases">
          ${chips}
        </dd>`;
}

export function detail(program, data, version) {
  const p = program;
  const rows = [
    ['Compound', 'compound', 'data-compound', p.compound],
    ['Indication', 'indication', 'data-indication', p.indication],
    ['Modality', 'modality', 'data-modality', p.modality],
    ['Phase', 'phase', null, p.phase],
    ['Status', 'status', 'data-status', p.status],
    ['Partner', 'partner', 'data-partner', p.partner],
  ];
  if (showsTarget(version)) rows.push(['Molecular target', 'target', 'data-target', p.target]);

  const rendered = rows.map(([label, cls, attr, value]) => {
    const a = attr ? ` ${attr}="${esc(value)}"` : '';
    return `        <dt>${esc(label)}</dt>
        <dd class="${cls}"${a}>${esc(value)}</dd>`;
  });
  // Aliases sit directly under Compound, where a reader looking for a name expects them.
  rendered.splice(1, 0, aliasRow(p));
  const facts = rendered.join('\n');

  const body = `    <article class="program-detail" data-program="${esc(p.program)}">
      <p class="crumb"><a href="../">Pipeline</a> / ${esc(p.program)}</p>
      <h1>${esc(p.program)}</h1>
      <p class="program-detail__lede">${esc(p.summary)}</p>
      <dl class="facts">
${facts}
        <dt>Last updated</dt>
        <dd class="updated"><time datetime="${esc(p.updated)}" data-updated="${esc(p.updated)}">${esc(
    humanDate(p.updated)
  )}</time></dd>
      </dl>
      <p class="back"><a href="../">← All programmes</a></p>
    </article>`;

  return page({
    version,
    title: `${p.program} — ${p.indication}`,
    description: p.summary,
    body,
    depth: 2,
    bodyClass: 'page-detail',
  });
}
