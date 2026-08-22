// v2 — the redesign. This is the break.
//
// What a reader sees: a tidier table. Phase and Status have been merged into one
// "Development status" column rendered as pills, Partner has moved ahead of
// Indication, the header row is restyled, and the whole thing sits in a rounded
// scroll shell. Ordinary front-end housekeeping.
//
// What a scraper sees: the Phase cell is gone. Rows still parse, every other field
// still resolves off its data-* attribute, so rows_returned stays at 20 and nothing
// errors. `phase` just quietly goes null.
//
// One row is left behind. MRD-2210 is discontinued and its status cell still
// renders through the old partial, which still emits <span class="phase">. So the
// null rate is 19/20 = 0.95, not 1.00 — and the single phase value the scraper can
// still read belongs to a programme that was killed in Q1. Worse than missing data.
//
// That leftover row also gives the heal two rounds by construction: a repair that
// only learns `.pill--stage` gets to 0.95 conformance, not 1.0. The verification
// step is supposed to catch that. The selector that actually works is the union,
// `.pill--stage, .phase`.

import { page, esc, humanDate } from '../layout.mjs';

const stageSlug = (phase) => phase.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/** The redesigned status cell: two pills, and data-status carried on the cell itself. */
function statusCell(p) {
  return `<td class="status-cell" data-status="${esc(p.status)}">
              <span class="pill pill--stage" data-stage="${esc(stageSlug(p.phase))}">${esc(
    p.phase
  )}</span>
              <span class="pill pill--enroll">${esc(p.status)}</span>
            </td>`;
}

/** The partial the redesign missed. Still the old markup, still emits class="phase". */
function legacyStatusCell(p) {
  return `<td class="status-cell status-cell--legacy" data-status="${esc(p.status)}">
              <span class="phase">${esc(p.phase)}</span>
              <span class="status">${esc(p.status)}</span>
            </td>`;
}

export function pipeline(data, version, { withTarget = false, withDiseaseFilter = false, failureMode = null } = {}) {
  const { company, programs } = data;

  const diseaseTargets = new Map();
  for (const program of programs) {
    if (!diseaseTargets.has(program.indication)) diseaseTargets.set(program.indication, new Set());
    diseaseTargets.get(program.indication).add(program.target);
  }

  const rows = programs
    .map((p) => {
      const archived = p.phase === 'Discontinued';
      const cell = archived ? legacyStatusCell(p) : statusCell(p);
      const targetCell = withTarget
        ? `\n            <td class="target" data-target="${esc(
            p.target
          )}"><code class="target-symbol">${esc(p.target)}</code></td>`
        : '';
      return `          <tr class="pipeline-row${
        archived ? ' pipeline-row--archived' : ''
      }" data-program="${esc(p.program)}">
            <td class="program-code"><a href="./${esc(p.slug)}/">${esc(p.program)}</a></td>
            <td class="compound" data-compound="${esc(p.compound)}">${esc(p.compound)}</td>
            <td class="partner" data-partner="${esc(p.partner)}">${esc(p.partner)}</td>
            <td class="indication" ${failureMode === 'schema' ? `data-disease="${esc(p.indication)}"` : `data-indication="${esc(p.indication)}"`}>${esc(p.indication)}</td>
            <td class="modality" data-modality="${esc(p.modality)}">${esc(p.modality)}</td>${targetCell}
            ${cell}
            <td class="updated"><time datetime="${esc(p.updated)}" data-updated="${esc(
        p.updated
      )}">${esc(humanDate(p.updated))}</time></td>
          </tr>`;
    })
    .join('\n');

  const targetHead = withTarget ? '\n            <th scope="col">Target</th>' : '';
  const breakNotice = version === 'v2'
    ? `
    <aside class="break-notice" role="status">
      <strong>Upstream layout changed</strong>
      <span>The pipeline page has been redesigned. Data is still visible, but monitors expecting the old Phase field need repair.</span>
    </aside>`
    : '';
  const schemaNotice = failureMode === 'schema'
    ? `
    <aside class="break-notice break-notice--severe" role="alert">
      <strong>Validation failed: schema mismatch</strong>
      <span>The source still returns 20 rows, but machine-readable disease fields were renamed without a contract update. The page looks populated while downstream records are incomplete.</span>
    </aside>`
    : '';

  const diseaseFilter = withDiseaseFilter
    ? `
    <section class="pipeline-filter" aria-labelledby="disease-filter-label">
      <label id="disease-filter-label" for="disease-filter">Search diseases</label>
      <input id="disease-filter" type="search" list="disease-suggestions" placeholder="e.g. Chagas disease" autocomplete="off" aria-controls="pipeline">
      <datalist id="disease-suggestions">
        ${[...diseaseTargets.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([disease, targets]) => `<option value="${esc(disease)}">${targets.size} ${targets.size === 1 ? 'target' : 'targets'}</option>`)
          .join('')}
      </datalist>
      <span id="pipeline-filter-count" class="pipeline-filter__count" role="status" aria-live="polite">Showing all ${programs.length} programmes</span>
    </section>`
    : '';

  const filterScript = withDiseaseFilter
    ? `
    <script>
      (() => {
        const filter = document.getElementById('disease-filter');
        const count = document.getElementById('pipeline-filter-count');
        const rows = [...document.querySelectorAll('#pipeline tbody tr')];
        const applyFilter = () => {
          const disease = filter.value.trim();
          const query = disease.toLowerCase();
          let visible = 0;
          for (const row of rows) {
            const matches = !query || row.querySelector('[data-indication]').dataset.indication.toLowerCase().includes(query);
            row.hidden = !matches;
            if (matches) visible += 1;
          }
          count.textContent = disease
            ? 'Showing ' + visible + ' ' + (visible === 1 ? 'programme' : 'programmes') + ' matching “' + disease + '”'
            : 'Showing all ' + visible + ' programmes';
        };
        filter.addEventListener('input', applyFilter);
      })();
    </script>`
    : '';

  const body = `    <section class="pipeline-intro">
      <h1>Pipeline</h1>
      <p>${programs.length} programmes across neglected tropical disease, tuberculosis, and respiratory
      medicine. Reviewed ${esc(humanDate(company.pipelineUpdated))}.</p>
    </section>

${diseaseFilter}
${breakNotice}${schemaNotice}
    <section class="pipeline-section">
      <div class="pipeline-shell">
        <div class="pipeline-scroll">
          <table id="pipeline" class="pipeline pipeline--refreshed">
            <caption class="visually-hidden">Meridian Therapeutics development pipeline</caption>
            <thead class="pipeline__head">
          <tr>
            <th scope="col">Programme</th>
            <th scope="col">Compound</th>
            <th scope="col">Partner</th>
            <th scope="col">Indication</th>
            <th scope="col">Modality</th>${targetHead}
            <th scope="col">Development status</th>
            <th scope="col">Last update</th>
          </tr>
            </thead>
            <tbody>
${rows}
            </tbody>
          </table>
        </div>
      </div>
    </section>${filterScript}`;

  return page({
    version,
    title: 'Pipeline',
    description: `Meridian Therapeutics development pipeline — ${programs.length} programmes.`,
    body,
    depth: 1,
    bodyClass: 'page-pipeline',
  });
}
