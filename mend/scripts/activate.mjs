#!/usr/bin/env node
// Publishes one version: versions/<v> -> public/
//
// This is how the break ships. The canonical URL /pipeline never changes and the
// scraper config never learns that versions exist — activating v2 simply replaces
// the bytes served at the same address, exactly as a real redesign would.
//
//   npm run site:activate v2 && git commit -am "redesign: merge phase into status" && git push
//
// Reverting is the same command with v1.
//
// public/ also carries two things that are NOT the canonical site:
//
//   _v/v1, _v/v2, _v/v3   every version, always deployed. The Edge Middleware rewrites
//                         /pipeline to one of these, which is what lets the control room
//                         flip the live version in under a second instead of waiting for a
//                         redeploy. They are unlinked and noindex like everything else.
//   control/              the operator's control room, plus the extraction modules it runs
//                         in the browser.
//
// Note what this means for the deployed tree: every *Meridian* page is still static HTML
// with no JavaScript, so the scrape target has no runtime that can fail. /control does ship
// JS. Those are different surfaces and the distinction is worth keeping straight.

import { cpSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VERSIONS } from '../templates/layout.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];

if (!version || !VERSIONS[version]) {
  console.error(`usage: npm run site:activate -- <${Object.keys(VERSIONS).join('|')}>`);
  process.exit(1);
}

const source = join(root, 'versions', version);
if (!existsSync(source)) {
  console.error(`versions/${version} does not exist — run "npm run site:build" first.`);
  process.exit(1);
}

const target = join(root, 'public');
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

// 1. The canonical site — what /pipeline serves with no middleware in play, and the
//    fallback the middleware falls back TO if Edge Config is unset or throws.
cpSync(source, target, { recursive: true });

// 2. Every version at a stable path, so the middleware has somewhere to rewrite to.
for (const v of Object.keys(VERSIONS)) {
  cpSync(join(root, 'versions', v), join(target, '_v', v), { recursive: true });
}

// 3. The control room, and the extraction modules it runs in the browser. These are
//    copied rather than duplicated so the cockpit and the oracle stay the same code.
const control = join(target, 'control');
cpSync(join(root, 'control'), control, { recursive: true });
mkdirSync(join(control, 'lib'), { recursive: true });
for (const file of ['extract-core.mjs', 'extract-web.mjs', 'validate.mjs']) {
  cpSync(join(root, 'src', file), join(control, 'lib', file));
}
cpSync(join(root, 'contracts/record.schema.json'), join(control, 'lib/record.schema.json'));

// Deterministic on purpose: no timestamp, so re-activating the same version is a no-op in git.
writeFileSync(join(target, 'VERSION'), `${version}\n${VERSIONS[version].generator}\n`);

console.log(`public/ now serves ${version} (${VERSIONS[version].generator})`);
console.log(`  canonical   /pipeline           -> ${version}`);
console.log(`  all versions /_v/{${Object.keys(VERSIONS).join(',')}}/pipeline  (middleware rewrite targets)`);
console.log('  control room /control');
console.log('commit and push to deploy — the canonical /pipeline URL is unchanged');
