function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function evidenceList(records) {
  return records.map((record) => `<li><a href="${escapeHtml(record.source_url)}" target="_blank" rel="noreferrer">${escapeHtml(record.subject)} — ${escapeHtml(record.value)}</a><p>${escapeHtml(record.evidence)}</p></li>`).join('');
}

export function renderTargetView(run) {
  const x = run?.axes?.X ?? { records: [], summary: {} };
  const y = run?.axes?.Y ?? { records: [], summary: {} };
  const z = run?.axes?.Z ?? { records: [], summary: {} };
  const status = run?.status ?? 'NOT_RUN';
  const version = run?.factoryVersion ?? '—';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mend — SERPINA1/AATD</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui;color:#ecf2ff;background:#08111f}body{margin:0}.shell{max-width:1080px;margin:auto;padding:48px 24px}header{display:flex;justify-content:space-between;gap:24px;align-items:end;margin-bottom:32px}h1{font-size:44px;margin:0}h2{margin:8px 0;color:#a9b8d4;font-weight:500}.status{padding:10px 14px;border:1px solid #34557e;border-radius:999px;background:#10233d}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}.card{background:#101d30;border:1px solid #213958;border-radius:18px;padding:22px}.axis{color:#72d5ff;font-weight:750;letter-spacing:.08em}.number{font-size:44px;font-weight:800;margin:16px 0 4px}.muted{color:#9fb0ca}details{margin-top:20px}ul{padding-left:20px}li{margin:14px 0}a{color:#8ddfff}p{font-size:13px;color:#a9b8d4}@media(max-width:760px){.grid{grid-template-columns:1fr}header{align-items:start;flex-direction:column}}
</style></head><body><main class="shell"><header><div><div class="axis">MEND</div><h1>SERPINA1</h1><h2>Alpha-1 Antitrypsin Deficiency</h2></div><div class="status">Factory ${escapeHtml(version)} · ${escapeHtml(status)}</div></header>
<section class="grid">
<article class="card"><div class="axis">X — PIPELINE</div><div class="number">${escapeHtml(x.summary.programsFound ?? x.records.length)}</div><div class="muted">Programs · ${escapeHtml(x.summary.organizations ?? 0)} organizations</div><details><summary>Source evidence</summary><ul>${evidenceList(x.records)}</ul></details></article>
<article class="card"><div class="axis">Y — STRUCTURE</div><div class="number">${escapeHtml(y.summary.experimental_structures ?? y.records.length)}</div><div class="muted">Experimental structures · best ${escapeHtml(y.summary.best_resolution_angstrom ?? 'unknown')} Å</div><details><summary>Source evidence</summary><ul>${evidenceList(y.records)}</ul></details></article>
<article class="card"><div class="axis">Z — IP ACTIVITY</div><div class="number">${escapeHtml(z.summary.relevant_records ?? z.records.length)}</div><div class="muted">Visible records · intelligence signal, not legal advice</div><details><summary>Source evidence</summary><ul>${evidenceList(z.records)}</ul></details></article>
</section></main></body></html>`;
}

const STEP_TITLES = {
  baseline: 'Healthy run',
  detect: 'Detection',
  diagnose: 'Diagnosis',
  propose: 'Proposal',
  deploy: 'Deployment',
  verify: 'Verification',
  escalate: 'Escalated',
  reject: 'Rejected by reviewer',
};

function signalLine(signals) {
  if (!signals) return '';
  const nulls = Object.entries(signals.field_null_rate ?? {})
    .filter(([, rate]) => rate > 0)
    .map(([field, rate]) => `${field} ${rate.toFixed(2)}`)
    .join(', ');
  return [
    `rows_returned <b>${signals.rows_returned}</b>`,
    `schema_conformance <b>${signals.schema_conformance.toFixed(2)}</b>`,
    nulls ? `field_null_rate ${escapeHtml(nulls)}` : '',
    `failure_class <b>${escapeHtml(signals.failure_class)}</b>`,
  ].filter(Boolean).join(' · ');
}

/**
 * The repair, as a page.
 *
 * The candidate table is the part worth showing on a screen. Three of its rows reach
 * conformance 1.00 and only one of them is a real fix — which is unarguable when the
 * numbers are sitting next to each other in the same table, and easy to wave away when
 * it is a claim in a README.
 */
export function renderRepairView(loop) {
  const diagnose = loop?.steps?.find((step) => step.step === 'diagnose');
  const candidates = diagnose?.candidates ?? [];
  const request = loop?.changeRequest;
  const change = loop?.softwareChange;

  const rows = candidates.map((candidate) => {
    const gate = (passed) => `<span class="${passed ? 'ok' : 'no'}">${passed ? 'pass' : 'fail'}</span>`;
    return `<tr class="${candidate.accepted ? 'accepted' : ''}">
      <td>${escapeHtml(candidate.label ?? (candidate.origin === 'synthesized' ? 'derived from the page' : candidate.origin))}</td>
      <td><code>${escapeHtml(candidate.selector)}</code></td>
      <td class="num">${candidate.conformance.toFixed(2)}</td>
      <td>${gate(candidate.numeric)}</td>
      <td>${gate(candidate.validator === 'accept')}</td>
      <td class="why">${escapeHtml(candidate.validatorReason ?? '')}</td>
    </tr>`;
  }).join('');

  const steps = (loop?.steps ?? []).map((step) => `<li>
      <div class="step-head"><b>${escapeHtml(STEP_TITLES[step.step] ?? step.step)}</b>${step.runId ? ` <span class="muted">${escapeHtml(step.runId)}</span>` : ''}</div>
      ${step.signals ? `<div class="muted">${signalLine(step.signals)}</div>` : ''}
      ${step.prose ? `<p>${escapeHtml(step.prose)}</p>` : ''}
      ${step.diff ? `<div><code>${escapeHtml(step.diff)}</code></div>` : ''}
      ${step.configVersion ? `<div class="muted">scraper.config_version → ${escapeHtml(step.configVersion)}</div>` : ''}
      ${step.reason ? `<p>${escapeHtml(step.reason)}</p>` : ''}
      ${step.verified != null ? `<div class="muted">verified <b>${step.verified}</b>${step.mttrSeconds != null ? ` · mttr ${step.mttrSeconds}s` : ''}</div>` : ''}
    </li>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Mend — repair loop</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui;color:#ecf2ff;background:#08111f}body{margin:0}
.shell{max-width:1100px;margin:auto;padding:44px 24px}
header{margin-bottom:28px}.axis{color:#72d5ff;font-weight:750;letter-spacing:.08em}
h1{font-size:38px;margin:6px 0}h2{font-size:18px;margin:34px 0 12px;color:#a9b8d4;font-weight:600}
.status{display:inline-block;padding:8px 14px;border:1px solid #34557e;border-radius:999px;background:#10233d}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid #1d3252;vertical-align:top}
th{color:#8ea3c4;font-weight:600}td.num{font-variant-numeric:tabular-nums}
tr.accepted{background:#0e2a20}code{color:#8ddfff;font-size:12px}
.ok{color:#5fe0a0;font-weight:700}.no{color:#ff8f9c;font-weight:700}
.why{color:#9fb0ca;max-width:380px}
ol{list-style:none;padding:0}ol li{border-left:2px solid #24405f;padding:0 0 20px 18px;margin-left:6px}
.step-head{margin-bottom:4px}.muted{color:#9fb0ca;font-size:13px}
p{font-size:13px;color:#c3d0e6;margin:6px 0;max-width:80ch}
.note{border:1px solid #24405f;border-radius:12px;padding:14px 18px;background:#0d1a2c;font-size:13px;color:#a9b8d4}
.scroll{overflow-x:auto}
</style></head><body><main class="shell">
<header>
  <div class="axis">MEND</div>
  <h1>Repair loop — meridian</h1>
  <div class="status">${escapeHtml(loop?.status ?? 'NOT_RUN')} · publish ${escapeHtml(loop?.publish ?? '—')}${request?.mttr_seconds != null ? ` · mttr ${request.mttr_seconds}s` : ''}</div>
</header>

<h2>Candidate repairs, and what each gate said</h2>
<div class="scroll"><table>
  <thead><tr><th>Proposal</th><th>Reads</th><th>conformance</th><th>numeric bar</th><th>validator</th><th>validator reason</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="6">No candidates — the run did not enter the repair path.</td></tr>'}</tbody>
</table></div>
<p class="note">Three proposals reach conformance 1.00. Two of them are wrong in almost every row.
The numeric bar cannot separate them because the fields are all populated — only reading the
values does, which is why release needs both gates and not the better one.</p>

<h2>What happened</h2>
<ol>${steps}</ol>

<h2>Governance</h2>
<div class="note">
  ChangeRequest <b>${escapeHtml(request?.type ?? '—')}</b> · status <b>${escapeHtml(request?.status ?? '—')}</b> · opened by the conformance condition, not by a person.<br>
  SoftwareChange <b>${escapeHtml(change?.state ?? '—')}</b>${change?.decision ? ` · ${escapeHtml(change.decision.decision)} by ${escapeHtml(change.decision.actor)}` : ''}${change?.deployment ? ` · factory ${escapeHtml(change.deployment.factoryVersion)}` : ''}<br>
  ${change ? `Author <b>${escapeHtml(change.author)}</b> cannot approve their own change.` : ''}
</div>
</main></body></html>`;
}
