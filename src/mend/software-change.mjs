import { randomUUID } from 'node:crypto';

function text(value, field) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${field} is required`);
  return result;
}

export function proposeSoftwareChange({
  brief,
  author,
  changedFiles,
  gitRef,
  verification,
  kind = 'BUILD',
  changeId = randomUUID(),
  createdAt = new Date().toISOString(),
}) {
  if (!['BUILD', 'REPAIR'].includes(kind)) throw new Error('kind must be BUILD or REPAIR');
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) throw new Error('changedFiles must not be empty');
  if (verification?.status !== 'PASS') throw new Error('software change verification must pass before review');
  return Object.freeze({
    changeId,
    kind,
    brief: text(brief, 'brief'),
    author: text(author, 'author'),
    changedFiles: [...changedFiles],
    gitRef: text(gitRef, 'gitRef'),
    verification: structuredClone(verification),
    state: 'AWAITING_APPROVAL',
    createdAt,
    decision: null,
    deployment: null,
  });
}

export function decideSoftwareChange(change, { decision, actor, reason, decidedAt = new Date().toISOString() }) {
  if (change?.state !== 'AWAITING_APPROVAL') throw new Error('software change is not awaiting approval');
  const reviewer = text(actor, 'actor');
  if (reviewer === change.author) throw new Error('software change author cannot approve or reject their own change');
  if (!['APPROVE', 'REJECT'].includes(decision)) throw new Error('decision must be APPROVE or REJECT');
  return Object.freeze({
    ...change,
    state: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
    decision: Object.freeze({ decision, actor: reviewer, reason: text(reason, 'reason'), decidedAt }),
  });
}

export function deploySoftwareChange(change, { factoryVersion, deployedAt = new Date().toISOString() }) {
  if (change?.state !== 'APPROVED') throw new Error('only an approved software change can deploy');
  return Object.freeze({
    ...change,
    state: 'DEPLOYED',
    deployment: Object.freeze({ factoryVersion: text(factoryVersion, 'factoryVersion'), deployedAt, gitRef: change.gitRef }),
  });
}

export function repairBriefFromFailure({ run, validation, activeIntegration }) {
  if (!run?.runId || !run?.factoryVersion) throw new Error('failed run identity is required');
  if (validation?.status !== 'FAIL') throw new Error('repair requires a failed validation report');
  return Object.freeze({
    kind: 'REPAIR',
    affectedAxis: validation.axis ?? 'X',
    failedRunId: run.runId,
    activeFactoryVersion: run.factoryVersion,
    activeIntegration: text(activeIntegration, 'activeIntegration'),
    previousHealthyCount: Number(validation.previousCount ?? 0),
    currentCount: Number(validation.currentCount ?? 0),
    reason: text(validation.reason, 'validation reason'),
    requiredArtifacts: ['integration repair', 'regression test', 'verification report', 'Git diff'],
  });
}
