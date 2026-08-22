// Control room. Two jobs: flip the served version, and show what a scraper would
// currently get from /pipeline.
//
// The signal table runs src/extract-core.mjs — the same module the Node oracle and the
// test suite use, not a reimplementation. test/parity.test.mjs asserts the two bindings
// produce identical records and signals, because a cockpit that disagrees with the
// instrument is worse than no cockpit.

import { extract, computeSignals, CONFIGS, ROUTE, HARD_NEGATIVES } from './lib/extract-web.mjs';

const refreshButton = document.getElementById('refresh');
const openPipeline = document.getElementById('open-pipeline');
const schema = await fetch('./lib/record.schema.json', { cache: 'no-store' }).then(async (r) => {
  if (!r.ok) throw new Error(`control schema unavailable (HTTP ${r.status})`);
  return r.json();
});

const PIPELINE = '/pipeline/';
const TOKEN_KEY = 'mend.controlToken';
const statusEl = document.getElementById('status');
const signalsEl = document.getElementById('signals');
const noteEl = document.getElementById('readout-note');
const negEl = document.getElementById('negatives');
const negNoteEl = document.getElementById('negatives-note');
const buttons = [...document.querySelectorAll('.vbtn')];
let refreshing = false;

function demoCookieVersion() {
  const match = document.cookie.match(/(?:^|;\s*)mend_active_version=([^;]+)/);
  return ['v1', 'v2', 'v3', 'v4'].includes(match?.[1]) ? match[1] : null;
}

function setDemoVersion(version) {
  document.cookie = `mend_active_version=${version}; Path=/; Max-Age=3600; SameSite=Lax`;
}

function setPipelineLink(version) {
  if (!version) {
    openPipeline.href = '/pipeline/';
    openPipeline.textContent = 'Open pipeline';
    return;
  }
  // The stable version paths are always deployed. They make the demo reliable even
  // when the optional Edge Middleware rewrite is unavailable on a preview deployment.
  openPipeline.href = `/_v/${version}/pipeline/`;
  openPipeline.textContent = `Open ${version} pipeline`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`${url} timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const CONFIG_LABELS = {
  baseline: 'baseline — what shipped against v1',
  healed_naive: 'healed_naive — the trap (HN-1)',
  healed: 'healed — .pill--stage, .phase',
};

const pct = (n) => (n * 100).toFixed(0) + '%';
const cls = (v, good) => (v === good ? 'ok' : 'bad');

// The bar a repair must clear is the conformance of the last HEALTHY run, so it has to
// outlive the break — and therefore this page load. Deriving it fresh each time meant the
// verdict column read "no bar yet" exactly while v2 was live, which is the one moment it
// matters. Persist the high-water mark instead; deployed, this is the `last_conformance`
// stored on the source in Port.
const BAR_KEY = 'mend.preBreakBar';

function readBar() {
  try {
    const v = Number.parseFloat(localStorage.getItem(BAR_KEY));
    return Number.isFinite(v) ? v : null;
  } catch {
    return null; // private window, blocked storage — degrade to "no bar yet"
  }
}
function saveBar(v) {
  try {
    localStorage.setItem(BAR_KEY, String(v));
  } catch {
    /* nothing to do; the bar is a convenience, not a source of truth */
  }
}

let preBreakBar = readBar();

async function readSignals(html, baseUrl) {
  const rows = [];

  for (const [name, config] of Object.entries(CONFIGS)) {
    const out = await extract(html, { config, baseUrl });
    const s = computeSignals(out, schema);
    rows.push({ name, s, sample: out.records[0]?.attributes.phase ?? null });
  }
  return rows;
}

function renderSignals(rows) {
  const base = rows.find((r) => r.name === 'baseline');
  if (base && base.s.schema_conformance > (preBreakBar ?? -1)) {
    preBreakBar = base.s.schema_conformance;
    saveBar(preBreakBar);
  }

  signalsEl.innerHTML = rows
    .map(({ name, s }) => {
      const conf = s.schema_conformance;
      const nullRate = s.field_null_rate.phase ?? 0;
      const unmapped = s.unmapped_fields_seen.join(', ') || '—';
      const route = ROUTE[s.failure_class];
      const routeCls = { none: 'ok', repair: 'warn', evolve: 'evolve', escalate: 'bad' }[route] ?? 'dim';
      const verdict =
        preBreakBar == null ? '<span class="dim">no bar yet</span>'
        : conf >= preBreakBar ? '<span class="ok">PASS</span>'
        : '<span class="bad">FAIL</span>';
      return `<tr>
        <td>${CONFIG_LABELS[name] ?? name}</td>
        <td class="num">${s.rows_returned}</td>
        <td class="num ${cls(conf, 1)}">${pct(conf)}<span class="bar"><i class="${conf < 0.999 ? 'low' : ''}" style="width:${conf * 100}%"></i></span></td>
        <td class="num ${nullRate ? 'bad' : 'ok'}">${pct(nullRate)}</td>
        <td class="${unmapped === '—' ? 'dim' : 'evolve'}">${unmapped}</td>
        <td class="${s.failure_class === 'none' ? 'dim' : 'warn'}">${s.failure_class}</td>
        <td class="${routeCls}">${route}</td>
        <td>${verdict}</td>
      </tr>`;
    })
    .join('');

  const naive = rows.find((r) => r.name === 'healed_naive');
  noteEl.innerHTML =
    naive && naive.s.schema_conformance > 0.85 && naive.s.schema_conformance < 1
      ? `The trap, live: <code>healed_naive</code> scores ${pct(naive.s.schema_conformance)} — above the 0.85 alert
         threshold, so the alert clears and the dashboard goes green, and below the pre-break bar, so it is
         still wrong. An alert threshold is a detector, not an acceptance test.`
      : 'Rows returned counts rows <em>matched</em>, not rows valid. During a silent failure the first stays flat while the second collapses.';
}

function setLive(version, configured) {
  setPipelineLink(version);
  for (const b of buttons) {
    const isLive = b.dataset.version === version;
    b.setAttribute('aria-current', String(isLive));
    b.querySelector('.vbtn__live').textContent = isLive ? 'LIVE' : '';
    b.disabled = !configured;
  }
}

function token() {
  let t = sessionStorage.getItem(TOKEN_KEY);
  if (!t) {
    t = prompt('Control token (CONTROL_TOKEN from the Vercel project):') ?? '';
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
  }
  return t;
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  refreshButton.disabled = true;
  refreshButton.textContent = 'Refreshing…';
  let state = { configured: false, version: null, reason: 'no /api/activate endpoint' };
  try {
    const res = await fetchWithTimeout('/api/activate', { cache: 'no-store' });
    const payload = await res.json().catch(() => ({}));
    state = res.ok ? payload : {
      configured: true,
      demo: true,
      version: demoCookieVersion(),
      reason: payload.error ?? `activation endpoint returned HTTP ${res.status}`,
    };
  } catch (err) {
    state = { configured: true, demo: true, version: demoCookieVersion(), reason: err.message };
  }

  setLive(state.version, state.configured);
  statusEl.innerHTML = state.demo
    ? `<span class="warn">Browser demo mode</span> — ${state.reason}. Version buttons remain available; use Open pipeline to see the change.`
    : state.configured
    ? `Serving <strong>${state.version}</strong> at <code>/pipeline</code>.`
    : `<span class="warn">Switching unavailable</span> — ${state.reason}. Serving the deployed
       version; the signals below are still live and correct. Use
       <code>npm run site:activate v2 &amp;&amp; git push</code> to flip it.`;

  try {
    const html = await fetch(PIPELINE, { cache: 'no-store' }).then((r) => r.text());
    const baseUrl = new URL(PIPELINE, location.origin).toString();
    renderSignals(await readSignals(html, baseUrl));
    await renderNegatives(html, baseUrl);
  } catch (err) {
    signalsEl.innerHTML = `<tr><td colspan="8" class="bad">Could not read ${PIPELINE}: ${err.message}</td></tr>`;
    negEl.innerHTML = `<tr><td colspan="6" class="bad">${err.message}</td></tr>`;
    noteEl.innerHTML = '<span class="bad">The control room could not read the live pipeline. Press Refresh status to try again.</span>';
  } finally {
    refreshing = false;
    refreshButton.disabled = false;
    refreshButton.textContent = 'Refresh status';
  }
}

async function activate(version) {
  const t = token();
  if (!t) return;
  statusEl.textContent = `Switching to ${version}…`;
  refreshButton.disabled = true;
  buttons.forEach((b) => (b.disabled = true));
  try {
    const res = await fetchWithTimeout('/api/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-control-token': t },
      body: JSON.stringify({ version }),
    });
    if (res.status === 401) {
      sessionStorage.removeItem(TOKEN_KEY);
      throw new Error('token rejected — press again to re-enter it');
    }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  } catch (err) {
    statusEl.innerHTML = `<span class="bad">${err.message}</span>`;
    setDemoVersion(version);
    setLive(version, true);
    statusEl.innerHTML = `<span class="warn">Browser demo mode</span> — API unavailable, so this browser is now set to <strong>${version}</strong>. Use Open pipeline to see the change.`;
    refreshButton.disabled = false;
    buttons.forEach((b) => (b.disabled = false));
    return;
  }
  await refresh();
}

/**
 * The finding from contracts/repair-validator.md, live.
 *
 * HN-2 and HN-3 return numbers identical to a correct repair and values that are wrong in
 * nearly every row. Showing them side by side is the argument for a second, independent
 * check — nothing in the conformance column separates them.
 */
async function renderNegatives(html, baseUrl) {
  const truth = await extract(html, { config: CONFIGS.healed, baseUrl });
  const truthValues = truth.records.map((r) => r.attributes.phase);

  const candidates = [
    ['correct  .pill--stage, .phase', CONFIGS.healed, true],
    ...Object.values(HARD_NEGATIVES).map((hn) => [`${hn.id}  ${hn.label}`, hn, false]),
  ];

  const cells = [];
  let blind = 0;
  for (const [label, config, isTruth] of candidates) {
    const out = await extract(html, { config, baseUrl });
    const s = computeSignals(out, schema);
    const values = out.records.map((r) => r.attributes.phase);
    const wrong = values.filter((v, i) => v !== truthValues[i]).length;
    const accepted = s.schema_conformance >= (preBreakBar ?? 1);
    if (accepted && !isTruth && wrong > 0) blind++;
    cells.push(`<tr>
      <td class="${isTruth ? 'ok' : ''}">${label}</td>
      <td class="num ${s.schema_conformance === 1 ? 'ok' : 'bad'}">${pct(s.schema_conformance)}</td>
      <td class="num ${s.field_null_rate.phase ? 'bad' : 'ok'}">${pct(s.field_null_rate.phase ?? 0)}</td>
      <td class="${isTruth || wrong === 0 ? 'ok' : 'bad'}">${values[0] == null ? '<span class="dim">null</span>' : JSON.stringify(values[0])}</td>
      <td class="num ${wrong ? 'bad' : 'ok'}">${wrong} / ${values.length}</td>
      <td class="${accepted && wrong ? 'bad' : accepted ? 'ok' : 'dim'}">${accepted ? (wrong ? 'ACCEPT — blind' : 'ACCEPT') : 'reject'}</td>
    </tr>`);
  }
  negEl.innerHTML = cells.join('');
  negNoteEl.innerHTML = blind
    ? `<span class="bad">${blind} of these are wrong and the numeric gate accepts them anyway.</span>
       Same conformance, same null rate, same failure_class as a genuine fix — and wrong in nearly every row.
       Counting nulls cannot separate them because the fields are all populated. That is what the
       Repair-Validator is for: <code>conformance is back to 1.00</code> and <code>the data is right</code>
       are different claims.`
    : 'These checks are most useful on the failure versions (v1, v2, and v3); v4 is the healthy restore.';
}

for (const b of buttons) b.addEventListener('click', () => activate(b.dataset.version));
refreshButton.addEventListener('click', refresh);
refresh().catch((err) => {
  statusEl.innerHTML = `<span class="bad">Control room failed to start: ${err.message}</span>`;
  refreshButton.disabled = false;
  buttons.forEach((b) => (b.disabled = true));
});
