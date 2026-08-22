#!/usr/bin/env node
// Switch the deployed Meridian site through its authenticated control endpoint.

import { loadLocalEnv } from './env.mjs';

loadLocalEnv();

const version = process.argv[2];
const origin = process.env.MEND_MERIDIAN_URL;
const token = process.env.CONTROL_TOKEN;

if (!['v1', 'v2', 'v3', 'v4'].includes(version)) {
  console.error('usage: npm run mend:activate -- <v1|v2|v3|v4>');
  process.exit(2);
}
if (!origin) {
  console.error('MEND_MERIDIAN_URL is required');
  process.exit(2);
}
if (!token) {
  console.error('CONTROL_TOKEN is required');
  process.exit(2);
}

const response = await fetch(new URL('/api/activate', origin), {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-control-token': token },
  body: JSON.stringify({ version }),
});
const body = await response.text();
if (!response.ok) {
  console.error(`Meridian activation failed (${response.status}): ${body}`);
  process.exit(1);
}
console.log(body);
