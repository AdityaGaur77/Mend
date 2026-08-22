// Invariants of the four page versions.
//
// The break has to be exactly what the pitch says it is. If someone edits a template
// and the row count moves, or the archived row stops emitting class="phase", or a page
// loses its noindex tag, that has to fail here — in CI, in advance — and not on stage.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VERSIONS } from '../templates/layout.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(join(root, 'data/programs.json'), 'utf8'));
const PROGRAMS = data.programs.length;

const read = (version, rel) => readFileSync(join(root, 'versions', version, rel), 'utf8');
const pipelineOf = (version) => read(version, 'pipeline/index.html');
const count = (haystack, re) => (haystack.match(re) || []).length;

const ROWS = /<tr\b[^>]*\bdata-program="/g;
const PHASE_CLASS = /class="phase"/g;
const STAGE_PILL = /pill--stage/g;
const TARGET = /data-target="/g;

function everyPage(version) {
  const dir = join(root, 'versions', version);
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.html')) out.push([full.slice(dir.length + 1), readFileSync(full, 'utf8')]);
    }
  };
  walk(dir);
  return out;
}

describe('build output', () => {
  for (const version of Object.keys(VERSIONS)) {
    test(`${version} renders home, pipeline and one page per programme`, () => {
      assert.ok(existsSync(join(root, 'versions', version, 'index.html')));
      assert.ok(existsSync(join(root, 'versions', version, 'pipeline/index.html')));
      for (const p of data.programs) {
        assert.ok(
          existsSync(join(root, 'versions', version, 'pipeline', p.slug, 'index.html')),
          `${version} missing detail page for ${p.slug}`
        );
      }
      assert.equal(everyPage(version).length, PROGRAMS + 3);
    });
  }
});

describe('the deliberate failure shapes', () => {
  test('v1 visibly returns no programme rows', () => {
    assert.equal(count(pipelineOf('v1'), ROWS), 0);
    assert.match(pipelineOf('v1'), /Pipeline unavailable/);
    assert.match(pipelineOf('v1'), /Data feed interrupted/);
  });

  for (const version of ['v2', 'v3', 'v4']) {
    test(`${version} returns ${PROGRAMS} rows`, () => {
      assert.equal(count(pipelineOf(version), ROWS), PROGRAMS);
    });
  }
});

describe('the phase field', () => {
  test('v4 publishes the original phase column on every row', () => {
    assert.equal(count(pipelineOf('v4'), PHASE_CLASS), PROGRAMS);
    assert.equal(count(pipelineOf('v4'), STAGE_PILL), 0);
  });

  test('v2 leaves phase readable on exactly one archived row', () => {
    // 19/20 null = 0.95. The one row that survives is MRD-2210, which is discontinued —
    // so the only phase value a stale scraper can still read belongs to a dead programme.
    assert.equal(count(pipelineOf('v2'), PHASE_CLASS), 1);
    assert.equal(count(pipelineOf('v2'), STAGE_PILL), PROGRAMS - 1);
    const legacyRow = pipelineOf('v2').match(/<tr[^>]*data-program="MRD-2210"[\s\S]*?<\/tr>/)[0];
    assert.match(legacyRow, /class="phase"/);
  });

  test('v3 keeps the redesign but removes the machine-readable disease field', () => {
    assert.equal(count(pipelineOf('v3'), PHASE_CLASS), 1);
    assert.equal(count(pipelineOf('v3'), STAGE_PILL), PROGRAMS - 1);
    assert.equal(count(pipelineOf('v3'), /data-disease="/g), PROGRAMS);
    assert.equal(count(pipelineOf('v3'), /data-indication="/g), 0);
  });

  test('the healed union selector reads every row in the row-bearing versions', () => {
    for (const version of ['v2', 'v3', 'v4']) {
      const html = pipelineOf(version);
      assert.equal(count(html, PHASE_CLASS) + count(html, STAGE_PILL), PROGRAMS, `${version}: phase coverage`);
    }
  });
});

describe('the target field — EVOLVE', () => {
  test('v1, v2 and v4 do not publish targets', () => {
    assert.equal(count(pipelineOf('v1'), TARGET), 0);
    assert.equal(count(pipelineOf('v2'), TARGET), 0);
    assert.equal(count(pipelineOf('v4'), TARGET), 0);
  });

  test('v3 publishes a target on every row, including the archived one', () => {
    assert.equal(count(pipelineOf('v3'), TARGET), PROGRAMS);
  });

  test('target reaches the detail pages only in v3', () => {
    assert.equal(count(read('v1', 'pipeline/mrd-4471/index.html'), /class="target"/g), 0);
    assert.equal(count(read('v4', 'pipeline/mrd-4471/index.html'), /class="target"/g), 0);
    assert.equal(count(read('v3', 'pipeline/mrd-4471/index.html'), /class="target"/g), 1);
  });
});

describe('mapped fields survive the redesign', () => {
  // Real redesigns preserve the data attributes their own JS depends on. That is why
  // rows keep parsing and the failure is silent rather than loud.
  for (const attr of ['data-compound', 'data-modality', 'data-status', 'data-partner', 'data-updated']) {
    test(`${attr} is present on every row in every version`, () => {
      for (const version of ['v2', 'v3', 'v4']) {
        assert.equal(count(pipelineOf(version), new RegExp(attr + '="', 'g')), PROGRAMS, `${version}/${attr}`);
      }
    });
  }
});

describe('the redesign is a redesign, not just a deleted column', () => {
  test('v2 moves Partner ahead of Indication', () => {
    const heads = [...pipelineOf('v2').matchAll(/<th scope="col">([^<]*)<\/th>/g)].map((m) => m[1]);
    assert.ok(heads.indexOf('Partner') < heads.indexOf('Indication'), heads.join(' | '));
    // v4 restores the original order — index-based extraction still has a known baseline.
    const v4Heads = [...pipelineOf('v4').matchAll(/<th scope="col">([^<]*)<\/th>/g)].map((m) => m[1]);
    assert.ok(v4Heads.indexOf('Indication') < v4Heads.indexOf('Partner'));
  });

  test('v2 merges Phase and Status into one column', () => {
    const heads = [...pipelineOf('v2').matchAll(/<th scope="col">([^<]*)<\/th>/g)].map((m) => m[1]);
    assert.ok(!heads.includes('Phase'));
    assert.ok(heads.includes('Development status'));
  });

  test('each version advertises a different generator', () => {
    const seen = Object.keys(VERSIONS).map((v) => pipelineOf(v).match(/name="generator" content="([^"]*)"/)[1]);
    assert.equal(new Set(seen).size, 4, seen.join(', '));
  });
});

describe('disclosure — non-negotiable', () => {
  for (const version of Object.keys(VERSIONS)) {
    test(`${version}: every page carries noindex and says the company is fictional`, () => {
      for (const [rel, html] of everyPage(version)) {
        assert.match(html, /name="robots" content="noindex, nofollow"/, `${version}/${rel} missing noindex`);
        assert.match(html, /fictional company created to test data pipelines/, `${version}/${rel} missing disclosure`);
      }
    });

    test(`${version}: robots.txt disallows everything`, () => {
      assert.match(read(version, 'robots.txt'), /User-agent: \*\nDisallow: \/$/m);
    });
  }
});
