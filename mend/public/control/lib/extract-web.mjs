// Browser binding for the extraction core, used by the control room.
//
// crypto.subtle is async-only, so rather than hand-rolling a second SHA-256 that
// could drift from Node's, this pre-hashes every input in one pass and hands the
// core a synchronous lookup. Same logic file, same numbers — test/parity.test.mjs
// asserts the two bindings agree, because the control room is shown on camera as
// the numbers and must not disagree with the thing the tests check.

import { extract as extractCore, hashInputs } from './extract-core.mjs';

export { CONFIGS, ROUTE, HARD_NEGATIVES, computeSignals, classify } from './extract-core.mjs';

const enc = new TextEncoder();

async function sha16(input) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/** Async in the browser, identical output to the Node binding. */
export async function extract(html, options = {}) {
  const inputs = hashInputs(html, options);
  const digests = await Promise.all(inputs.map(sha16));
  const table = new Map(inputs.map((input, i) => [input, digests[i]]));
  return extractCore(html, { ...options, hash: (input) => table.get(input) });
}
