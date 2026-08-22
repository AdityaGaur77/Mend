// Node binding for the extraction core.
//
// This is the oracle the tests assert against and the reference the agent track
// checks a proposed heal with before spending a Bright Data collector run on it.
// It is NOT the production scraper — Bright Data does that.
//
// All logic lives in extract-core.mjs, shared verbatim with the browser control
// room. The only thing supplied here is Node's SHA-256.

import { createHash } from 'node:crypto';
import { extract as extractCore, hashInputs } from './extract-core.mjs';

export { CONFIGS, ROUTE, HARD_NEGATIVES, computeSignals, classify, hashInputs, eachRow } from './extract-core.mjs';

/** sha256(input) truncated to 16 hex chars, per contracts/record.schema.json. */
export function recordId(sourceUrl, label) {
  return createHash('sha256').update(`${sourceUrl}\0${label}`).digest('hex').slice(0, 16);
}

const sha16 = (input) => createHash('sha256').update(input).digest('hex').slice(0, 16);

export function extract(html, options = {}) {
  return extractCore(html, { ...options, hash: sha16 });
}

void hashInputs;
