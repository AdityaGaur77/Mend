// v1 — deliberate source outage for the demo.
// The upstream endpoint responds, but no programme records arrive. This makes the
// row-count collapse visible to both the judges and the control-room signals.

import { page, esc, humanDate } from '../layout.mjs';

export function pipeline(data, version) {
  const { company, programs } = data;
  const body = `    <section class="pipeline-intro">
      <h1>Pipeline unavailable</h1>
      <p>The source responded, but the programme payload was empty. The last expected release contained ${programs.length} records.</p>
    </section>

    <aside class="outage-card" role="alert">
      <div class="outage-card__icon">!</div>
      <div>
        <strong>Data feed interrupted</strong>
        <p>Meridian could not load its development programmes. Nothing has been released from this run.</p>
        <small>Last known good update: ${esc(humanDate(company.pipelineUpdated))}</small>
      </div>
    </aside>

    <section class="pipeline-section">
      <div class="pipeline-shell pipeline-shell--empty">
        <table id="pipeline" class="pipeline">
          <caption class="visually-hidden">Meridian Therapeutics development pipeline</caption>
          <thead><tr><th scope="col">Programme</th><th scope="col">Status</th><th scope="col">Last update</th></tr></thead>
          <tbody><tr><td colspan="3" class="empty-state">No programme records returned</td></tr></tbody>
        </table>
      </div>
    </section>`;

  return page({
    version,
    title: 'Pipeline unavailable',
    description: 'Meridian Therapeutics pipeline data feed is unavailable.',
    body,
    depth: 1,
    bodyClass: 'page-pipeline page-pipeline--outage',
  });
}
