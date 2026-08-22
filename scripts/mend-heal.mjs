#!/usr/bin/env node
// The heal, on a terminal.
//
//   npm run mend:heal                    v4 -> v2, derive, gate, approve, deploy, verify
//   npm run mend:heal -- --reject        the same, with the reviewer turning it down
//   npm run mend:heal -- --broken v3     the ambiguous case, which must escalate
//   npm run mend:heal -- --broken v1     the outage, which a selector repair cannot fix
//   npm run mend:heal -- --live          against MEND_MERIDIAN_URL instead of the tree
//   npm run mend:heal -- --reset         forget the deployed repair and start from baseline
//
// A repair persists: once one is deployed, a second run finds nothing to fix, because the
// deployed config now reads the changed page correctly. That is the loop working rather
// than a bug, and --reset is how the demo is rehearsed twice.
//
// Credential-free by default: with no MEND_MERIDIAN_URL it reads the committed
// mend/versions/ tree, which is the same bytes the deployment is built from. Nothing
// here contacts Bright Data — this is the offline oracle the agent track checks a
// proposed heal against before spending a collector run on it.

import { createScraperRegistry, loadScraperRegistry, saveScraperRegistry } from '../src/mend/scraper-registry.mjs';
import { runRepairLoop } from '../src/mend/repair-loop.mjs';
import { loadLocalEnv } from './env.mjs';

loadLocalEnv();

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1] ?? true;
};

const healthyVersion = flag('healthy', 'v4');
const brokenVersion = flag('broken', 'v2');
const approve = !argv.includes('--reject');
const live = argv.includes('--live');
const origin = live ? process.env.MEND_MERIDIAN_URL : null;
const json = argv.includes('--json');

if (live && !origin) {
  console.error('--live needs MEND_MERIDIAN_URL set to the deployed Meridian origin (see .env.example).');
  process.exit(2);
}

const bold = (text) => `[1m${text}[0m`;
const dim = (text) => `[2m${text}[0m`;
const green = (text) => `[32m${text}[0m`;
const red = (text) => `[31m${text}[0m`;
const pad = (text, width) => String(text).padEnd(width);

function printSignals(label, signals) {
  const nulls = Object.entries(signals.field_null_rate)
    .filter(([, rate]) => rate > 0)
    .map(([field, rate]) => `${field}=${rate.toFixed(2)}`)
    .join(' ');
  console.log(
    `  ${pad(label, 12)} rows=${pad(signals.rows_returned, 3)} conformance=${signals.schema_conformance.toFixed(2)}  ` +
      `${pad(nulls || '-', 16)} ${signals.failure_class}`
  );
}

const registry = argv.includes('--reset') ? createScraperRegistry() : await loadScraperRegistry();

console.log(bold(`\nMend repair loop — meridian ${live ? `(live: ${origin})` : '(committed versions/ tree)'}`));
console.log(dim(`  scraper.config_version ${registry.deployed().version}  ·  ${healthyVersion} healthy -> ${brokenVersion} changed\n`));

const loop = await runRepairLoop({ registry, origin, healthyVersion, brokenVersion, approve });

if (json) {
  console.log(JSON.stringify(loop, null, 2));
  process.exit(loop.status === 'REPAIRED' || loop.status === 'HEALTHY' ? 0 : 1);
}

for (const step of loop.steps) {
  if (step.step === 'baseline') {
    console.log(bold('1. Healthy run') + dim('  — the bar, and the values the repair will be anchored to'));
    printSignals('baseline', step.signals);
  }

  if (step.step === 'detect') {
    console.log(bold('\n2. The page changes') + dim('  — same URL, same scraper config, HTTP 200, nothing thrown'));
    printSignals('after', step.signals);
    console.log(dim(`  route: ${step.route.toUpperCase()}`));
  }

  if (step.step === 'diagnose') {
    console.log(bold(`\n3. Diagnosis`) + dim(`  — field: ${step.field}`));
    for (const line of step.prose.match(/.{1,96}(\s|$)/g) ?? []) console.log(`  ${line.trim()}`);

    if (step.candidates.length) {
      console.log(bold('\n4. Candidate repairs, and what each gate said'));
      console.log(
        dim(`  ${pad('proposal', 34)}${pad('reads', 46)}${pad('conf', 6)}${pad('numeric', 9)}validator`)
      );
    }
    for (const candidate of step.candidates) {
      const name = candidate.label ?? (candidate.origin === 'synthesized' ? 'derived from the page' : candidate.origin);
      console.log(
        `  ${pad(name.slice(0, 32), 34)}${pad(candidate.selector.slice(0, 44), 46)}` +
          `${pad(candidate.conformance.toFixed(2), 6)}` +
          `${pad(candidate.numeric ? green('pass') : red('fail'), 9 + 9)}` +
          `${candidate.validator === 'accept' ? green('accept') : red('reject')}` +
          `${candidate.accepted ? bold('  <- accepted') : ''}`
      );
    }
    const wrong = step.candidates.filter((c) => c.conformance === 1 && c.validator === 'reject');
    if (wrong.length) {
      console.log(
        dim(
          `\n  ${wrong.length} proposal(s) reach conformance 1.00 and are wrong. Nothing that counts nulls\n` +
            '  can separate them from a real fix — only reading the values does.'
        )
      );
      for (const candidate of wrong) {
        console.log(dim(`    ${candidate.selector}`));
        console.log(dim(`      ${candidate.validatorReason.slice(0, 150)}`));
      }
    }
  }

  if (step.step === 'propose') console.log(bold('\n5. Proposal') + `  ${step.diff}`);
  if (step.step === 'reject') console.log(red(bold(`\n6. Reviewer rejected the repair`)) + dim(`  — ${step.actor}`));
  if (step.step === 'escalate') {
    console.log(red(bold('\n   ESCALATED')) + dim('  — no repair proposed'));
    for (const line of step.reason.match(/.{1,96}(\s|$)/g) ?? []) console.log(`   ${line.trim()}`);
  }
  if (step.step === 'deploy') {
    console.log(bold('\n6. Deployed') + dim(`  — scraper.config_version -> ${step.configVersion}, change ${step.changeId}`));
  }
  if (step.step === 'verify') {
    console.log(bold('\n7. Re-scrape') + dim('  — the same bytes, a different scraper. That is the difference.'));
    printSignals('verified', step.signals);
    console.log(`  verified=${step.verified ? green('true') : red('false')}  mttr=${step.mttrSeconds}s`);
  }
}

if (loop.status === 'HEALTHY') {
  console.log(
    dim(
      `\n  Nothing to repair: the deployed config (${loop.registry.deployed().version}) already reads this page.\n` +
        '  Re-run with --reset to start from the baseline config again.'
    )
  );
}

const request = loop.changeRequest;
console.log(bold('\nOutcome'));
console.log(`  factory        ${loop.status}`);
console.log(`  dataset        ${loop.publish}`);
if (request) console.log(`  ChangeRequest  ${request.type} · ${request.status}` + dim('  (opened by the conformance condition, not by a person)'));
if (loop.softwareChange) {
  const change = loop.softwareChange;
  console.log(`  SoftwareChange ${change.state}` + (change.decision ? ` · ${change.decision.decision} by ${change.decision.actor}` : ''));
}
console.log(`  scraper        ${loop.registry.deployed().version}`);

if (loop.status === 'REPAIRED') {
  const path = await saveScraperRegistry(loop.registry);
  console.log(dim(`\n  deployed config written to ${path}`));
}
console.log();

process.exit(loop.status === 'REPAIRED' || loop.status === 'HEALTHY' ? 0 : 1);
