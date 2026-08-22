// The factory API.
//
// Five surfaces, and the split between them is the point:
//
//   POST /mend/runs      run the X/Y/Z slice against Meridian. When the page breaks, X
//                        degrades and Y/Z stay published — one source moving a selector
//                        must not take the other two down with it.
//   POST /mend/repair    the whole loop: detect, diagnose, derive, gate, approve, deploy,
//                        re-scrape, verify.
//   GET  /mend/repair    that loop as a page, including the candidates the gates rejected.
//   GET  /mend/scraper   the deployed scraper config and every deployment behind it.
//   GET  /mend           the target view for the latest slice run.
//
// The scraper registry is created once per process, not per request. That is deliberate:
// a repair approved through /mend/repair has to be the config the next scrape actually
// uses, and a per-request registry would make every heal evaporate the moment it landed.

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { loadLocalEnv } from '../scripts/env.mjs';
import { createTelemetry } from './telemetry.mjs';
import { createMeridianAxisRunners } from './mend/meridian-runners.mjs';
import { runRepairLoop } from './mend/repair-loop.mjs';
import { createScraperRegistry } from './mend/scraper-registry.mjs';
import { healthySnapshot, runVerticalSlice } from './mend/vertical-slice.mjs';
import { renderRepairView, renderTargetView } from './mend/ui.mjs';

loadLocalEnv();

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function setCors(response) {
  response.setHeader('access-control-allow-origin', process.env.MEND_CONTROL_ORIGIN ?? '*');
  response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  response.setHeader('access-control-allow-headers', 'content-type,x-mend-factory-token');
  response.setHeader('access-control-max-age', '600');
}

function sendHtml(response, html) {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createApp({ telemetry = createTelemetry() } = {}) {
  let latestMendRun = null;
  let latestRepairLoop = null;
  let previousHealthy = {};
  let meridianRunners = null;
  const registry = createScraperRegistry();

  const server = createServer(async (request, response) => {
    setCors(response);
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    const url = new URL(request.url, 'http://localhost');
    const requestSpan = telemetry.startSpan(`api.${request.method.toLowerCase()} ${url.pathname}`, {
      'http.request.method': request.method,
      'url.path': url.pathname,
    });

    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, { ok: true, service: telemetry.serviceName });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/mend/runs') {
        const body = await readJson(request);
        const mode = body.mode ?? 'normal';
        if (!['normal', 'break-x', 'repaired'].includes(mode)) {
          throw new Error('mode must be normal, break-x, or repaired');
        }
        const runId = body.runId ?? randomUUID();
        requestSpan.setAttribute('run.id', runId);

        meridianRunners ??= await createMeridianAxisRunners({
          registry,
          origin: body.origin ?? process.env.MEND_MERIDIAN_URL ?? null,
        });
        latestMendRun = await runVerticalSlice({
          axisRunners: meridianRunners,
          mode,
          previousHealthy,
          factoryVersion: body.factoryVersion ?? registry.deployed().version,
          runId,
          telemetry,
          parentSpan: requestSpan,
        });
        if (latestMendRun.status === 'HEALTHY') previousHealthy = healthySnapshot(latestMendRun);
        sendJson(response, 200, latestMendRun);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/mend/target') {
        if (!latestMendRun) {
          sendJson(response, 404, { error: 'POST /mend/runs first' });
          return;
        }
        sendJson(response, 200, latestMendRun);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/mend') {
        if (!latestMendRun) {
          sendJson(response, 404, { error: 'POST /mend/runs before opening the target view' });
          return;
        }
        sendHtml(response, renderTargetView(latestMendRun));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/mend/repair') {
        const expectedToken = process.env.MEND_FACTORY_TOKEN;
        if (expectedToken && request.headers['x-mend-factory-token'] !== expectedToken) {
          sendJson(response, 401, { error: 'missing or invalid factory token' });
          return;
        }
        const body = await readJson(request);
        // approve:false exercises the interlock — the repair is still derived and gated,
        // and the reviewer turns it down, so nothing deploys and the dataset stays blocked.
        latestRepairLoop = await runRepairLoop({
          registry,
          origin: body.origin ?? process.env.MEND_MERIDIAN_URL ?? null,
          healthyVersion: body.healthyVersion ?? 'v4',
          brokenVersion: body.brokenVersion ?? 'v2',
          approve: body.approve !== false,
          reviewer: body.reviewer ?? 'human-reviewer',
          versionedLive: body.versionedLive === true,
          telemetry,
        });
        requestSpan.setAttribute('mend.repair.status', latestRepairLoop.status);
        sendJson(response, 200, {
          status: latestRepairLoop.status,
          publish: latestRepairLoop.publish,
          steps: latestRepairLoop.steps,
          changeRequest: latestRepairLoop.changeRequest,
          softwareChange: latestRepairLoop.softwareChange,
          scraper: latestRepairLoop.registry.toJSON(),
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/mend/repair') {
        if (!latestRepairLoop) {
          sendJson(response, 404, { error: 'POST /mend/repair before opening the repair view' });
          return;
        }
        sendHtml(response, renderRepairView(latestRepairLoop));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/mend/scraper') {
        sendJson(response, 200, registry.toJSON());
        return;
      }

      sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      telemetry.failSpan(requestSpan, error);
      // A malformed body or a bad enum value is the caller's fault, not the server's —
      // answering 500 for those would page someone over a typo.
      const clientError = error instanceof SyntaxError || /must be|required/.test(error.message);
      sendJson(response, clientError ? 400 : 500, { error: error.message });
    } finally {
      requestSpan.end();
    }
  });

  return { server, telemetry };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createApp();
  const port = Number(process.env.PORT ?? 3000);
  app.server.listen(port, () => {
    console.log(`mend factory listening on http://localhost:${port}`);
    console.log('  POST /mend/repair   run the loop      GET /mend/repair   see it');
    console.log('  POST /mend/runs     X/Y/Z slice       GET /mend/scraper  deployed config');
  });
  const stop = () => app.server.close(async () => {
    await app.telemetry.shutdown();
    process.exit(0);
  });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
