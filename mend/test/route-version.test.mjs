// The scrape target must never fail. These assertions are that promise, in code.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteTarget, parseEdgeConfig, isValidVersion, VERSION_IDS } from '../src/route-version.mjs';

describe('rewriteTarget', () => {
  test('routes /pipeline to the active version tree', () => {
    assert.equal(rewriteTarget('/pipeline/', 'v2'), '/_v/v2/pipeline/');
    assert.equal(rewriteTarget('/pipeline/mrd-4471/', 'v3'), '/_v/v3/pipeline/mrd-4471/');
    assert.equal(rewriteTarget('/pipeline/index.html', 'v1'), '/_v/v1/pipeline/index.html');
  });

  test('every uncertain pointer falls through to the deployed static file', () => {
    for (const bad of [null, undefined, '', 'v5', 'V2', 'latest', 42, {}, [], 'v2; rm -rf /', '../v2']) {
      assert.equal(rewriteTarget('/pipeline/', bad), null, `pointer ${JSON.stringify(bad)} must fall through`);
    }
  });

  test('paths outside /pipeline are never touched', () => {
    for (const p of ['/', '/index.html', '/control/', '/robots.txt', '/assets/site.css']) {
      assert.equal(rewriteTarget(p, 'v2'), null);
    }
  });

  test('a version tree is never rewritten again — no loop', () => {
    assert.equal(rewriteTarget('/_v/v2/pipeline/', 'v2'), null);
  });

  test('a non-string pathname cannot throw', () => {
    for (const p of [null, undefined, 7, {}]) assert.equal(rewriteTarget(p, 'v2'), null);
  });

  test('isValidVersion matches the shipped set', () => {
    assert.deepEqual(VERSION_IDS, ['v1', 'v2', 'v3', 'v4']);
    assert.ok(VERSION_IDS.every(isValidVersion));
    assert.equal(isValidVersion('v9'), false);
  });
});

describe('parseEdgeConfig', () => {
  test('splits a real connection string', () => {
    const parsed = parseEdgeConfig('https://edge-config.vercel.com/ecfg_abc123?token=tok_xyz');
    assert.equal(parsed.id, 'ecfg_abc123');
    assert.equal(parsed.itemUrl('activeVersion'), 'https://edge-config.vercel.com/ecfg_abc123/item/activeVersion?token=tok_xyz');
  });

  test('returns null rather than throwing on anything malformed', () => {
    for (const bad of [undefined, null, '', 'not a url', 'https://edge-config.vercel.com/']) {
      assert.equal(parseEdgeConfig(bad), null, `${JSON.stringify(bad)} must return null`);
    }
  });
});
