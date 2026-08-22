// A scraper config as data rather than as closures.
//
// mend/src/extract-core.mjs defines its three configs as objects full of reader
// functions. That is the right shape for the oracle to run, and the wrong shape for
// everything the factory needs to do with a repair: a function cannot be diffed in a
// pull request, stored in a Port entity, written to an artifact, or shown to the human
// who has to approve it. `CONFIGS.healed` being hand-written is what let the previous
// heal be a branch that selected a pre-written answer.
//
// So a plan is a plain JSON object naming, per field, an ordered list of places to read
// from. compile() turns it into exactly the config shape extract() already takes, and
// test/selector-plan.test.mjs pins that the compiled baseline and the compiled healed
// plan are byte-identical in behaviour to CONFIGS.baseline and CONFIGS.healed. That
// equivalence is the whole basis for trusting a synthesized plan: it is the same
// machinery, with the answer derived instead of typed in.
//
// Two reader kinds, because the reference extractor only has two:
//
//   { kind: 'attr',  name: 'data-compound' }        -> the attribute's value
//   { kind: 'class', name: 'pill pill--stage' }     -> text of the first element whose
//                                                      class attribute is exactly that
//
// `class` matches the WHOLE class attribute literally, not a CSS class token, because
// that is what extract-core's regex does. Rendering it as `.pill--stage` would read
// nicely and describe a selector nobody runs, so a plan renders as
// [class="pill pill--stage"] instead. The contract prose writes the short form; this is
// the precise one.

/** Escape a literal for embedding in a RegExp source. */
function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The attribute's value, or null when the attribute is absent.
 * Mirrors extract-core's attr(): an empty attribute yields "", not null.
 */
function readAttr(name) {
  const re = new RegExp(`\\b${escapeRe(name)}="([^"]*)"`);
  return (row) => {
    const m = row.match(re);
    return m ? m[1] : null;
  };
}

/** Text of the first element whose class attribute is exactly `name`. */
function readClass(name) {
  const re = new RegExp(`class="${escapeRe(name)}"[^>]*>([^<]*)<`);
  return (row) => {
    const m = row.match(re);
    return m ? m[1].trim() || null : null;
  };
}

const READERS = { attr: readAttr, class: readClass };

/** First reader that returns non-null wins. An ordered fallback chain, not a merge. */
function firstOf(readers) {
  return (row) => {
    for (const read of readers) {
      const value = read(row);
      if (value != null) return value;
    }
    return null;
  };
}

export function compileReader(reader) {
  const build = READERS[reader?.kind];
  if (!build) throw new Error(`unknown reader kind: ${reader?.kind}`);
  if (!reader.name) throw new Error(`reader of kind ${reader.kind} needs a name`);
  return build(reader.name);
}

/** A plan -> the { version, fields } config shape mend's extract() already accepts. */
export function compilePlan(plan) {
  if (!plan?.version) throw new Error('a scraper plan needs a version');
  if (!Array.isArray(plan.fields) || plan.fields.length === 0) throw new Error('a scraper plan needs fields');
  return {
    version: plan.version,
    fields: Object.fromEntries(
      plan.fields.map((field) => {
        if (!field?.field) throw new Error('every plan entry needs a field name');
        if (!Array.isArray(field.readers) || field.readers.length === 0) {
          throw new Error(`field ${field.field} needs at least one reader`);
        }
        return [field.field, firstOf(field.readers.map(compileReader))];
      })
    ),
  };
}

/** How one reader is written in a diff a human reviews. */
export function renderReader(reader) {
  if (reader.kind === 'attr') return `[${reader.name}]`;
  if (reader.kind === 'class') return `[class="${reader.name}"]`;
  throw new Error(`unknown reader kind: ${reader.kind}`);
}

/** How one field is written: the fallback chain, in order. */
export function renderField(plan, field) {
  const entry = plan.fields.find((candidate) => candidate.field === field);
  return entry ? entry.readers.map(renderReader).join(', ') : '(unmapped)';
}

/** The one-line reviewable diff for a single field: `phase: <before> -> <after>`. */
export function renderDiff(before, after, field) {
  return `${field}: ${renderField(before, field)}  ->  ${renderField(after, field)}`;
}

export function planField(plan, field) {
  return plan.fields.find((entry) => entry.field === field) ?? null;
}

/** A copy of `plan` with `field` re-pointed at `readers`, and a new config version. */
export function withField(plan, field, readers, version) {
  const replaced = plan.fields.some((entry) => entry.field === field);
  return {
    ...plan,
    version,
    fields: replaced
      ? plan.fields.map((entry) => (entry.field === field ? { ...entry, readers } : entry))
      : [...plan.fields, { field, readers }],
  };
}

/**
 * The config that shipped against the healthy page — the declarative twin of
 * CONFIGS.baseline. Every field but `phase` reads a data attribute, which is why a
 * redesign that preserves data attributes breaks exactly one field and nothing else.
 */
export const BASELINE_PLAN = Object.freeze({
  id: 'meridian.program',
  version: '2026-05-02.1',
  fields: [
    { field: 'compound', readers: [{ kind: 'attr', name: 'data-compound' }] },
    { field: 'indication', readers: [{ kind: 'attr', name: 'data-indication' }] },
    { field: 'modality', readers: [{ kind: 'attr', name: 'data-modality' }] },
    { field: 'phase', readers: [{ kind: 'class', name: 'phase' }] },
    { field: 'status', readers: [{ kind: 'attr', name: 'data-status' }] },
    { field: 'partner', readers: [{ kind: 'attr', name: 'data-partner' }] },
    { field: 'updated', readers: [{ kind: 'attr', name: 'data-updated' }] },
  ],
});
