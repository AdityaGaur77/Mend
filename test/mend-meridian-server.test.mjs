// The Meridian surfaces on the API: the X/Y/Z slice running against the real page, and
// the repair loop as something you can POST to and then look at.

import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs';
import { AggregationTemporality, InMemoryMetricExporter } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';

import { createApp } from '../src/server.mjs';
import { createTelemetry } from '../src/telemetry.mjs';

async function serve(t) {
  const spanExporter = new InMemorySpanExporter();
  const telemetry = createTelemetry({
    spanExporter,
    logExporter: new InMemoryLogRecordExporter(),
    metricExporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    console: false,
  });
  const { server } = createApp({ telemetry });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await telemetry.shutdown();
  });
  return { base: `http://127.0.0.1:${server.address().port}`, spanExporter };
}

const post = (base, path, body) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('the X/Y/Z slice runs against Meridian and isolates the silent failure', async (t) => {
  const { base } = await serve(t);

  const healthy = await (await post(base, '/mend/runs', { mode: 'normal', runId: 'mer-healthy' })).json();
  assert.equal(healthy.status, 'HEALTHY');
  assert.equal(healthy.axes.X.records.length, 20);

  const broken = await (await post(base, '/mend/runs', { mode: 'break-x', runId: 'mer-broken' })).json();
  assert.equal(broken.status, 'DEGRADED');
  assert.deepEqual(broken.failedAxes, ['X']);
  // The claim the whole slice exists to make: one source moved a selector, and structural
  // readiness and IP activity are untouched rather than blanked alongside it.
  assert.equal(broken.axes.Y.status, 'HEALTHY');
  assert.equal(broken.axes.Z.status, 'HEALTHY');
  assert.equal(broken.axes.X.status, 'STALE_HEALTHY');
  assert.equal(broken.publishStatus, 'PRESERVED_PREVIOUS_HEALTHY');
});

test('an unknown mode is refused rather than silently defaulted', async (t) => {
  const { base } = await serve(t);
  const response = await post(base, '/mend/runs', { mode: 'sideways' });
  // 400, not 500: a bad enum value is the caller's typo, not a server fault, and a 500
  // here would page someone over it.
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /mode must be/);
});

test('POST /mend/repair drives the loop and GET /mend/repair shows it', async (t) => {
  const { base, spanExporter } = await serve(t);

  assert.equal((await fetch(`${base}/mend/repair`)).status, 404);
  assert.equal((await (await fetch(`${base}/mend/scraper`)).json()).deployed.version, '2026-05-02.1');

  const loop = await (await post(base, '/mend/repair', {})).json();
  assert.equal(loop.status, 'REPAIRED');
  assert.equal(loop.publish, 'PUBLISHED');
  assert.equal(loop.changeRequest.status, 'verified');
  assert.equal(loop.softwareChange.state, 'DEPLOYED');

  // The deployed config is process-wide, so the repair is what the next scrape uses.
  const registry = await (await fetch(`${base}/mend/scraper`)).json();
  assert.equal(registry.deployed.version, loop.scraper.deployed.version);
  assert.notEqual(registry.deployed.version, '2026-05-02.1');
  assert.equal(registry.history.length, 1);

  const view = await fetch(`${base}/mend/repair`);
  assert.equal(view.status, 200);
  const html = await view.text();
  assert.match(html, /Repair loop — meridian/);
  assert.match(html, /REPAIRED/);
  // The candidate table is the screen worth showing: the rejected near-misses are on it.
  assert.match(html, /pill--enroll/);
  assert.match(html, /data-stage/);
  assert.match(html, /noindex/);

  const spans = spanExporter.getFinishedSpans().filter((span) => span.name === 'mend.scrape');
  assert.equal(spans.length, 3, 'baseline, detect and verify each emit a scrape span');
  const detect = spans[1].attributes;
  assert.equal(detect['source.controlled'], true);
  assert.equal(detect.schema_conformance, 0.05);
  assert.equal(detect.failure_class, 'selector_drift');
  assert.equal(detect['mend.route'], 'repair');
});

test('a reviewer rejection over the API leaves the deployed config alone', async (t) => {
  const { base } = await serve(t);
  const loop = await (await post(base, '/mend/repair', { approve: false })).json();
  assert.equal(loop.status, 'REJECTED');
  assert.equal(loop.publish, 'BLOCKED');
  assert.equal((await (await fetch(`${base}/mend/scraper`)).json()).deployed.version, '2026-05-02.1');
});
