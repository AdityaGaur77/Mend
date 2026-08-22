// Flips which Meridian version /pipeline serves, by writing a pointer to Vercel Edge
// Config. The middleware reads that pointer on the next request.
//
//   GET   -> { configured, version, reason }
//   POST  -> { version } with header x-control-token
//
// The write requires a Vercel API token, which stays server-side and never reaches the
// browser. The browser only ever holds CONTROL_TOKEN, a shared secret whose sole power is
// switching a fictional biotech's pipeline page between three versions. Without it: 401.
// Otherwise anyone who finds this URL could flip the demo mid-presentation.

import { isValidVersion, parseEdgeConfig, VERSION_IDS } from '../mend/src/route-version.mjs';

const KEY = 'activeVersion';
const DEMO_COOKIE = 'mend_active_version';

function cookieVersion(req) {
  const cookies = String(req.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim().split('='))
    .filter(([name]) => name);
  const value = cookies.find(([name]) => name === DEMO_COOKIE)?.[1];
  return isValidVersion(value) ? value : null;
}

function setDemoCookie(res, version) {
  res.setHeader(
    'set-cookie',
    `${DEMO_COOKIE}=${version}; Path=/; Max-Age=3600; SameSite=Lax; HttpOnly`
  );
}

function edgeConfigId() {
  return process.env.EDGE_CONFIG_ID || parseEdgeConfig(process.env.EDGE_CONFIG)?.id || null;
}

/** Why switching is unavailable, in words an operator can act on. */
function missingReason() {
  if (!process.env.EDGE_CONFIG) return 'EDGE_CONFIG is not set — connect an Edge Config store to this project';
  if (!edgeConfigId()) return 'EDGE_CONFIG is set but its id could not be parsed';
  if (!process.env.VERCEL_API_TOKEN) return 'VERCEL_API_TOKEN is not set — needed to write the pointer';
  if (!process.env.CONTROL_TOKEN) return 'CONTROL_TOKEN is not set — refusing to expose an unauthenticated switch';
  return null;
}

async function readVersion() {
  const edge = parseEdgeConfig(process.env.EDGE_CONFIG);
  if (!edge) return null;
  try {
    const res = await fetch(edge.itemUrl(KEY), { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function writeVersion(version) {
  const id = edgeConfigId();
  const team = process.env.VERCEL_TEAM_ID ? `?teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}` : '';
  const res = await fetch(`https://api.vercel.com/v1/edge-config/${id}/items${team}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${process.env.VERCEL_API_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ items: [{ operation: 'upsert', key: KEY, value: version }] }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Edge Config write failed (${res.status}) ${detail.slice(0, 200)}`);
  }
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  const reason = missingReason();

  if (req.method === 'GET') {
    const browserVersion = cookieVersion(req);
    return res.status(200).json({
      configured: reason === null || (Boolean(process.env.CONTROL_TOKEN) && !process.env.EDGE_CONFIG),
      version: browserVersion ?? (await readVersion()) ?? null,
      reason: browserVersion ? 'Using the browser demo switch' : reason,
      versions: VERSION_IDS,
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  // The cookie fallback keeps the hackathon demo usable when Edge Config or the
  // Vercel API token is unavailable. It is still protected by CONTROL_TOKEN and
  // only affects this browser for one hour; production deployments use Edge Config.
  if (!process.env.CONTROL_TOKEN) {
    return res.status(503).json({ error: reason ?? 'CONTROL_TOKEN is not set' });
  }

  // Constant-ish time compare is overkill for a demo switch, but a plain !== leaks
  // nothing useful here either — the token is single-purpose and rotatable.
  if (req.headers['x-control-token'] !== process.env.CONTROL_TOKEN) {
    return res.status(401).json({ error: 'bad or missing x-control-token' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {});
  } catch {
    return res.status(400).json({ error: 'request body must be valid JSON' });
  }
  if (!isValidVersion(body.version)) {
    return res.status(400).json({ error: `version must be one of ${VERSION_IDS.join(', ')}` });
  }

  try {
    if (reason) throw new Error(reason);
    await writeVersion(body.version);
    res.setHeader('x-mend-activation-mode', 'edge-config');
  } catch (err) {
    setDemoCookie(res, body.version);
    res.setHeader('x-mend-activation-mode', 'browser-cookie');
    return res.status(200).json({
      configured: true,
      version: body.version,
      reason: `Edge Config unavailable; using the browser demo switch (${err.message})`,
      versions: VERSION_IDS,
      mode: 'browser-cookie',
    });
  }

  return res.status(200).json({ configured: true, version: body.version, reason: null, versions: VERSION_IDS });
}
