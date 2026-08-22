// The control room and the oracle must never disagree.
//
// The control room is shown on camera as "the numbers". The test suite asserts a
// different binding of the same logic. If those two ever diverged, the demo would be
// misreporting its own instrument — the exact failure mode Mend exists to catch.
//
// crypto.subtle exists in Node 18+, so the browser binding runs here for real rather
// than being mocked. Same code path the control room executes.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as node from '../src/extract.mjs';
import * as web from '../src/extract-web.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(readFileSync(join(root, 'contracts/record.schema.json'), 'utf8'));
const BASE = 'https://meridian.example/pipeline/';
const html = (v) => readFileSync(join(root, 'versions', v, 'pipeline/index.html'), 'utf8');

const VERSIONS = ['v1', 'v2', 'v3', 'v4'];
const CONFIG_NAMES = ['baseline', 'healed_naive', 'healed'];

describe('node and browser bindings agree', () => {
  for (const v of VERSIONS) {
    for (const name of CONFIG_NAMES) {
      test(`${v} / ${name}: identical records and signals`, async () => {
        const page = html(v);
        const opts = { baseUrl: BASE };

        const nodeOut = node.extract(page, { ...opts, config: node.CONFIGS[name] });
        const webOut = await web.extract(page, { ...opts, config: web.CONFIGS[name] });

        assert.deepEqual(webOut.records, nodeOut.records, 'records must match exactly, ids included');
        assert.deepEqual([...webOut.observedKeys].sort(), [...nodeOut.observedKeys].sort());

        assert.deepEqual(
          web.computeSignals(webOut, schema),
          node.computeSignals(nodeOut, schema),
          'signals must match exactly'
        );
      });
    }
  }

  test('the ids really are sha256-derived, not coincidentally equal empties', async () => {
    const page = html('v4');
    const out = await web.extract(page, { baseUrl: BASE, config: web.CONFIGS.baseline });
    assert.equal(out.records.length, 20);
    for (const r of out.records) assert.match(r.id, /^[0-9a-f]{16}$/);
    assert.equal(new Set(out.records.map((r) => r.id)).size, 20, 'ids must be distinct');
    assert.equal(out.records[0].id, node.recordId(out.records[0].sourceUrl, out.records[0].label));
  });
});
