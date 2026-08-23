export default function handler(request, response) {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', 'application/json');
  response.status(200).json({
    factoryEnabled: Boolean(process.env.MEND_FACTORY_URL && process.env.MEND_FACTORY_TOKEN),
    publicDemo: process.env.MEND_PUBLIC_DEMO === 'true',
  });
}
