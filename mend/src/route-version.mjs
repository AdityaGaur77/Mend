// Which file /pipeline should serve, given the active version pointer.
//
// Pure on purpose. The Edge Middleware at the repo root is a thin binding around this,
// so the decision — including every fallback path — is unit-testable in Node without a
// Vercel deployment. See test/route-version.test.mjs.
//
// The governing rule: /pipeline is the URL Bright Data scrapes, and it must never fail.
// Every uncertain input returns null, which means "fall through to the static file that
// is already deployed there". An unset pointer, a garbage pointer, an Edge Config outage,
// a typo in an env var — all of them serve the canonical version rather than erroring.

export const VERSION_IDS = ['v1', 'v2', 'v3', 'v4'];

export const isValidVersion = (v) => typeof v === 'string' && VERSION_IDS.includes(v);

/**
 * @returns {string|null} path to serve instead, or null to fall through to the static file.
 */
export function rewriteTarget(pathname, activeVersion) {
  if (!isValidVersion(activeVersion)) return null;
  if (typeof pathname !== 'string' || !pathname.startsWith('/pipeline')) return null;
  // Already pointing at a version tree — never rewrite twice, that is how you get a loop.
  if (pathname.startsWith('/_v/')) return null;
  return `/_v/${activeVersion}${pathname}`;
}

/**
 * Split a Vercel Edge Config connection string into the pieces needed to read an item.
 * Format: https://edge-config.vercel.com/<id>?token=<token>
 * @returns {{id: string, itemUrl: (key: string) => string}|null}
 */
export function parseEdgeConfig(connectionString) {
  if (!connectionString) return null;
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    return null;
  }
  const id = url.pathname.split('/').filter(Boolean)[0];
  if (!id) return null;
  return {
    id,
    itemUrl: (key) => `${url.origin}/${id}/item/${encodeURIComponent(key)}${url.search}`,
  };
}
