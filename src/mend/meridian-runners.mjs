// Axis runners that put Meridian behind X while Y and Z stay as they are.
//
// The value of running the whole X/Y/Z slice against the real page rather than testing
// the X axis on its own is the isolation claim: when the pipeline page is silently
// broken, structural readiness and IP activity are unaffected and must stay published.
// A factory that blanks all three when one source moves a selector has not isolated
// anything. createDemoAxisRunners already demonstrates that with fixtures; this shows it
// with a source that genuinely broke.
//
// One difference from the fixture runners, and it is the point of the exercise: there is
// no `repaired` snapshot to select. Every mode reads the deployed scraper config out of
// the registry, so a `repaired` run is a `broken` run that happens to occur after a heal
// was approved and deployed. If nothing was deployed, the repaired run is still broken —
// which is the correct behaviour, and something the fixture path could not express.

import { readFile } from 'node:fs/promises';

import { loadRecordSchema, readMeridian, runMeridianX } from '../axes/x-meridian.mjs';
import { runYAxis } from '../axes/y/structure.mjs';
import { runZAxis } from '../axes/z-ip-activity.mjs';
import { createScraperRegistry } from './scraper-registry.mjs';

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`../../fixtures/xyz/${name}`, import.meta.url), 'utf8'));
}

export async function createMeridianAxisRunners({
  registry = createScraperRegistry(),
  origin = null,
  healthyVersion = 'v4',
  brokenVersion = 'v2',
  schema,
  clock = () => new Date('2026-08-22T18:00:00.000Z'),
  fetchImpl,
} = {}) {
  const recordSchema = schema ?? (await loadRecordSchema());
  const [yFixture, zFixture] = await Promise.all([
    fixture('y-structure-rcsb.json'),
    fixture('z-ip-serpina1.json'),
  ]);

  // The pre-break bar, remembered from the last run that passed. Held here rather than
  // recomputed because that is what a real deployment has: history, not a version name.
  let baseline = null;

  return {
    registry,
    X: async ({ mode }) => {
      const version = mode === 'normal' ? healthyVersion : brokenVersion;
      const page = await readMeridian({ origin, version, fetchImpl });
      const run = await runMeridianX({ page, plan: registry.deployed(), schema: recordSchema, baseline });
      if (run.validation.status === 'PASS') baseline = run.signals;
      return run;
    },
    Y: async () => runYAxis({ fixture: yFixture, retrievedAt: clock().toISOString() }),
    Z: async () => runZAxis({
      retrieve: async () => zFixture.records,
      sourceName: 'Mend deterministic patent activity fixture',
      clock,
    }),
  };
}
