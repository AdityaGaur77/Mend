import { randomUUID } from 'node:crypto';
import { validateEvidenceRecords } from './evidence.mjs';

const AXES = ['X', 'Y', 'Z'];

function startSpan(telemetry, name, attributes, parent) {
  return telemetry?.startSpan?.(name, attributes, parent) ?? {
    addEvent() {},
    setAttribute() {},
    end() {},
  };
}

function failSpan(telemetry, span, error) {
  telemetry?.failSpan?.(span, error);
}

async function executeAxis({ axis, runner, mode, previousHealthy, runId, telemetry, parentSpan }) {
  const span = startSpan(telemetry, `axis.${axis.toLowerCase()}`, {
    'run.id': runId,
    axis,
    'axis.mode': mode,
  }, parentSpan);
  telemetry?.log?.('INFO', `${axis} axis started`, { 'run.id': runId, axis, 'axis.mode': mode }, span);
  try {
    const output = await runner({ mode, previousHealthy, runId, parentSpan: span });
    const records = validateEvidenceRecords(output?.records, axis);
    if (output?.validation?.status && output.validation.status !== 'PASS') {
      throw new Error(output.validation.reason ?? `${axis} validation failed`);
    }
    span.setAttribute('axis.records', records.length);
    span.setAttribute('validation.status', 'PASS');
    telemetry?.metrics?.axisRecords?.[axis]?.record(records.length, { axis, 'run.id': runId, outcome: 'success' });
    telemetry?.log?.('INFO', `${axis} axis healthy`, { 'run.id': runId, axis, 'record.count': records.length, 'validation.status': 'PASS' }, span);
    return {
      axis,
      status: 'HEALTHY',
      records,
      summary: output?.summary ?? {},
      validation: output?.validation ?? { status: 'PASS', checks: [] },
    };
  } catch (error) {
    failSpan(telemetry, span, error);
    span.setAttribute('validation.status', 'FAIL');
    telemetry?.metrics?.axisRecords?.[axis]?.record(0, { axis, 'run.id': runId, outcome: 'failure' });
    telemetry?.metrics?.validationFailures?.add(1, { axis, 'run.id': runId });
    telemetry?.log?.('ERROR', `${axis} axis validation failed: ${error.message}`, {
      'run.id': runId, axis, 'validation.status': 'FAIL', 'error.type': error.name,
    }, span);
    const healthy = previousHealthy?.records ?? [];
    return {
      axis,
      status: healthy.length ? 'STALE_HEALTHY' : 'UNAVAILABLE',
      records: healthy,
      summary: previousHealthy?.summary ?? {},
      validation: { status: 'FAIL', reason: error.message },
      quarantine: { reason: error.message, candidateRecords: [] },
    };
  } finally {
    span.end();
  }
}

export async function runVerticalSlice({
  axisRunners,
  mode = 'normal',
  previousHealthy = {},
  factoryVersion = 'v1',
  runId = randomUUID(),
  telemetry,
  parentSpan,
} = {}) {
  const startedAt = performance.now();
  for (const axis of AXES) {
    if (typeof axisRunners?.[axis] !== 'function') throw new Error(`axis runner ${axis} is required`);
  }
  if (!['normal', 'break-x', 'repaired'].includes(mode)) {
    throw new Error('mode must be normal, break-x, or repaired');
  }

  const root = startSpan(telemetry, 'factory.run', {
    'run.id': runId,
    'factory.version': factoryVersion,
    'run.mode': mode,
  }, parentSpan);
  if (mode === 'repaired') telemetry?.metrics?.repairAttempts?.add(1, { axis: 'X', 'run.id': runId });
  let finalStatus = 'ERROR';
  try {
    const outcomes = await Promise.all(AXES.map((axis) => executeAxis({
      axis,
      runner: axisRunners[axis],
      mode: axis === 'X' && mode === 'break-x' ? 'broken' : mode === 'repaired' ? 'repaired' : 'normal',
      previousHealthy: previousHealthy[axis],
      runId,
      telemetry,
      parentSpan: root,
    })));

    const axes = Object.fromEntries(outcomes.map((outcome) => [outcome.axis, outcome]));
    const failedAxes = outcomes.filter((outcome) => outcome.validation.status === 'FAIL').map((outcome) => outcome.axis);
    const status = failedAxes.length ? 'DEGRADED' : 'HEALTHY';
    finalStatus = status;
    const publishStatus = failedAxes.length
      ? failedAxes.every((axis) => axes[axis].status === 'STALE_HEALTHY')
        ? 'PRESERVED_PREVIOUS_HEALTHY'
        : 'BLOCKED'
      : 'PUBLISHED';

    root.setAttribute('factory.status', status);
    root.setAttribute('publish.status', publishStatus);
    root.setAttribute('failed.axes', failedAxes.join(','));
    if (mode === 'repaired' && status === 'HEALTHY') {
      telemetry?.metrics?.repairSuccess?.add(1, { axis: 'X', 'run.id': runId });
    }
    telemetry?.log?.(status === 'HEALTHY' ? 'INFO' : 'ERROR', `Mend factory run ${status.toLowerCase()}`, {
      'run.id': runId,
      'factory.version': factoryVersion,
      'factory.status': status,
      'publish.status': publishStatus,
      'failed.axes': failedAxes.join(','),
    }, root);
    return {
      runId,
      factoryVersion,
      mode,
      status,
      publishStatus,
      failedAxes,
      axes,
    };
  } finally {
    const duration = performance.now() - startedAt;
    telemetry?.metrics?.factoryRuns?.add(1, { outcome: finalStatus, 'run.id': runId });
    telemetry?.metrics?.factoryDuration?.record(duration, { outcome: finalStatus, 'run.id': runId });
    root.end();
  }
}

export function healthySnapshot(run) {
  return Object.fromEntries(AXES.flatMap((axis) => {
    const result = run?.axes?.[axis];
    return result?.status === 'HEALTHY'
      ? [[axis, { records: result.records, summary: result.summary }]]
      : [];
  }));
}
