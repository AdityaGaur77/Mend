#!/usr/bin/env node
// Zero-dependency static server for local checks. Serves public/ by default.
//
//   npm run site:serve            -> http://localhost:4173  (whatever is activated)
//   node scripts/serve.mjs versions/v2 4174
//
// Directory requests resolve to index.html so the built tree behaves the way
// Vercel serves it.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isValidVersion, VERSION_IDS } from '../src/route-version.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, process.argv[2] ?? 'public');
const port = Number(process.argv[3] ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  // Required, not optional: browsers enforce strict MIME checking on ES modules and
  // refuse to execute one served as octet-stream. Without these the control room's
  // imports silently fail to load and its table never leaves "Reading…".
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function resolve(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  let candidate = join(dir, clean);
  try {
    if ((await stat(candidate)).isDirectory()) candidate = join(candidate, 'index.html');
    return candidate;
  } catch {
    // Bare path with no extension: try it as a directory index, the way cleanUrls does.
    if (!extname(candidate)) {
      const asIndex = join(candidate, 'index.html');
      try {
        await stat(asIndex);
        return asIndex;
      } catch {
        /* fall through */
      }
    }
    return candidate;
  }
}

/**
 * A local stand-in for the deployed /api/activate, so the control room and the whole
 * demo can be rehearsed offline with no Vercel, no Edge Config, and no tokens.
 *
 * It does the real thing rather than faking it: it runs scripts/activate.mjs, which
 * rewrites public/. Deployed, the equivalent flip is a pointer write that the Edge
 * Middleware reads. Different mechanism, same observable result at /pipeline.
 *
 * Dev only. No auth, because it is bound to localhost and can only choose between three
 * versions of a fictional biotech's pipeline page.
 */
async function handleActivate(req, res) {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const current = async () => {
    try {
      return (await readFile(join(dir, 'VERSION'), 'utf8')).split('\n')[0].trim() || null;
    } catch {
      return null;
    }
  };

  if (req.method === 'GET') {
    return send(200, { configured: true, version: await current(), reason: null, versions: VERSION_IDS, dev: true });
  }
  if (req.method !== 'POST') return send(405, { error: 'method not allowed' });

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let version;
  try {
    ({ version } = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
  } catch {
    return send(400, { error: 'invalid JSON' });
  }
  if (!isValidVersion(version)) return send(400, { error: `version must be one of ${VERSION_IDS.join(', ')}` });

  try {
    execFileSync(process.execPath, [join(root, 'scripts/activate.mjs'), version], { stdio: 'ignore' });
  } catch (err) {
    return send(500, { error: `activate failed: ${err.message}` });
  }
  return send(200, { configured: true, version, reason: null, versions: VERSION_IDS, dev: true });
}

createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/api/activate' || path === '/api/activate/') return handleActivate(req, res);

  const file = await resolve(req.url ?? '/');
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'x-robots-tag': 'noindex, nofollow',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404\n');
  }
}).listen(port, () => {
  console.log(`serving ${dir} on http://localhost:${port}`);
});
