// What scraper config is deployed right now, and every config that was deployed before.
//
// The repair loop needs somewhere for a heal to actually land. Without this the factory
// can derive a repair, approve it, and then re-run against the same config it started
// with, which reads as a successful heal in the logs and changes nothing about what gets
// scraped tomorrow. Deploying means replacing the deployed plan, and a deployment that
// leaves no history is not auditable.
//
// Deliberately a plain JSON document: a plan is data (see selector-plan.mjs), so the
// registry serializes whole. That is what lets a deployment survive a process restart,
// be written to an artifact for a run record, or be pushed into a Port entity without a
// second representation being invented for each.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { BASELINE_PLAN } from './selector-plan.mjs';

const DEFAULT_PATH = 'artifacts/mend/scraper-registry.json';

/**
 * `deployed` is accepted as well as `plan` so the registry can be reconstructed from its
 * own toJSON() output without a second shape being invented for the round trip.
 */
export function createScraperRegistry({ plan, deployed: restored, history = [] } = {}) {
  let deployed = plan ?? restored ?? BASELINE_PLAN;
  const log = [...history];

  return {
    /** The config a scrape run should use. */
    deployed: () => deployed,

    /**
     * Replace the deployed config.
     *
     * `changeId` is required because a deployment with no approved software change
     * behind it is exactly the thing the interlock exists to prevent — a repair that
     * reached production without anyone agreeing to it.
     */
    deploy(next, { changeId, actor, reason, deployedAt = new Date().toISOString() }) {
      if (!next?.version) throw new Error('a deployed plan needs a version');
      if (!changeId) throw new Error('deploying a scraper config requires an approved change id');
      if (next.version === deployed.version) {
        throw new Error(`config version ${next.version} is already deployed — a repair must bump it`);
      }
      log.push({
        from: deployed.version,
        to: next.version,
        changeId,
        actor: actor ?? null,
        reason: reason ?? null,
        deployedAt,
      });
      deployed = next;
      return deployed;
    },

    history: () => [...log],
    toJSON: () => ({ deployed, history: [...log] }),
  };
}

export async function loadScraperRegistry(path = DEFAULT_PATH) {
  try {
    const stored = JSON.parse(await readFile(path, 'utf8'));
    return createScraperRegistry({ plan: stored.deployed, history: stored.history });
  } catch {
    // No registry yet: the baseline config is what shipped against the healthy page.
    return createScraperRegistry();
  }
}

export async function saveScraperRegistry(registry, path = DEFAULT_PATH) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(registry.toJSON(), null, 2)}\n`, 'utf8');
  return path;
}
