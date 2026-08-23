export default async function handler(request, response) {
  response.setHeader('cache-control', 'no-store');
  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST');
    return response.status(405).json({ error: 'method not allowed' });
  }

  const factoryUrl = String(process.env.MEND_FACTORY_URL ?? '').replace(/\/$/, '');
  const factoryToken = process.env.MEND_FACTORY_TOKEN;
  if (!factoryUrl || !factoryToken) {
    return response.status(503).json({ error: 'MEND_FACTORY_URL or MEND_FACTORY_TOKEN is not configured' });
  }

  let body;
  try {
    body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body ?? {});
  } catch {
    return response.status(400).json({ error: 'request body must be valid JSON' });
  }

  try {
    const upstream = await fetch(`${factoryUrl}/mend/repair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mend-factory-token': factoryToken },
      body: JSON.stringify({
        healthyVersion: body.healthyVersion ?? 'v4',
        brokenVersion: body.brokenVersion ?? 'v2',
        versionedLive: body.versionedLive !== false,
        reset: body.reset !== false,
        approve: body.approve !== false,
        reviewer: body.reviewer ?? 'demo-operator',
      }),
    });
    const payload = await upstream.json().catch(() => ({ error: `factory returned HTTP ${upstream.status}` }));
    return response.status(upstream.status).json(payload);
  } catch (error) {
    return response.status(502).json({ error: `factory proxy failed: ${error.message}` });
  }
}
