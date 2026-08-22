export default function handler(request, response) {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', 'application/json');
  response.status(200).json({ factoryUrl: process.env.MEND_FACTORY_URL ?? '' });
}
