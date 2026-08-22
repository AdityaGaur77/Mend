// Edge Middleware: serves whichever Meridian version the control room has selected.
//
// Thin binding only. Every decision lives in mend/src/route-version.mjs, which is pure
// and unit-tested, because this file cannot be tested without a deployment.
//
// /pipeline is the URL Bright Data scrapes. It must never fail. So:
//   - the matcher is scoped to /pipeline/:path* and nothing else
//   - the whole body is wrapped in try/catch
//   - every failure path returns undefined, which continues to the static file already
//     deployed at that URL
//   - the Edge Config read has a hard timeout, so a slow store cannot slow the scrape
//
// With no EDGE_CONFIG set this is a no-op and the site behaves exactly as it did before
// the middleware existed. That is deliberate: the demo must not depend on it.

import { rewriteTarget, parseEdgeConfig } from './mend/src/route-version.mjs';

export const config = { matcher: '/pipeline/:path*' };

const EDGE_CONFIG_TIMEOUT_MS = 1500;

async function readActiveVersion() {
  const edge = parseEdgeConfig(process.env.EDGE_CONFIG);
  if (!edge) return null;
  const res = await fetch(edge.itemUrl('activeVersion'), {
    cache: 'no-store',
    signal: AbortSignal.timeout(EDGE_CONFIG_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  return await res.json();
}

function readDemoVersion(request) {
  const header = request.headers.get('cookie') ?? '';
  const match = header.match(/(?:^|;\s*)mend_active_version=([^;]+)/);
  const value = match?.[1];
  return value === 'v1' || value === 'v2' || value === 'v3' || value === 'v4' ? value : null;
}

export default async function middleware(request) {
  try {
    const active = readDemoVersion(request) ?? await readActiveVersion();
    const url = new URL(request.url);
    const target = rewriteTarget(url.pathname, active);
    if (!target) return; // fall through to the deployed static file

    url.pathname = target;
    // /_v/* does not match this middleware, so there is no recursion.
    const upstream = await fetch(url, { headers: request.headers });
    if (!upstream.ok) return; // rewrite target missing — fall through rather than 404

    const headers = new Headers(upstream.headers);
    headers.set('x-mend-version', active);
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch {
    return; // any failure at all: serve the static fallback
  }
}
