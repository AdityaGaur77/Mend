const DEFAULT_SEARCH_ENDPOINT = 'https://search.rcsb.org/rcsbsearch/v2/query';
const DEFAULT_DATA_ENDPOINT = 'https://data.rcsb.org/graphql';
const DEFAULT_ACCESSION = 'P01009';
const DEFAULT_SUBJECT = 'SERPINA1 / Alpha-1 antitrypsin';

const ENTRY_QUERY = `query StructureEntries($ids: [String!]!) {
  entries(entry_ids: $ids) {
    rcsb_id
    struct { title }
    exptl { method }
    rcsb_entry_info { resolution_combined }
    polymer_entities {
      rcsb_polymer_entity { pdbx_description }
      rcsb_polymer_entity_container_identifiers {
        reference_sequence_identifiers { database_name database_accession }
      }
      entity_src_gen { pdbx_gene_src_scientific_name }
      entity_src_nat { pdbx_organism_scientific }
    }
    nonpolymer_entities {
      pdbx_entity_nonpoly { comp_id name }
    }
  }
}`;

function requireOk(response, label) {
  if (!response?.ok) {
    throw new Error(`${label} failed with HTTP ${response?.status ?? 'unknown'}`);
  }
  return response;
}
/**
 * Perform a bounded RCSB lookup by UniProt accession, then retrieve entry data.
 * fetchImpl is injected so tests and normal demos remain deterministic.
 */
export async function retrieveRcsbStructures({
  accession = DEFAULT_ACCESSION,
  fetchImpl = globalThis.fetch,
  maxEntries = 25,
  searchEndpoint = DEFAULT_SEARCH_ENDPOINT,
  dataEndpoint = DEFAULT_DATA_ENDPOINT,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl is required');
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 100) {
    throw new Error('maxEntries must be an integer between 1 and 100');
  }

  const searchResponse = requireOk(await fetchImpl(searchEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: {
        type: 'terminal',
        service: 'text',
        parameters: {
          attribute: 'rcsb_polymer_entity_container_identifiers.reference_sequence_identifiers.database_accession',
          operator: 'exact_match',
          value: accession,
        },
      },
      return_type: 'entry',
      request_options: { paginate: { start: 0, rows: maxEntries } },
    }),
  }), 'RCSB search');
  const searchPayload = await searchResponse.json();
  const ids = [...new Set((searchPayload.result_set ?? []).map((item) => String(item.identifier ?? '').toUpperCase()).filter(Boolean))]
    .slice(0, maxEntries);
  if (ids.length === 0) return { data: { entries: [] } };

  const dataResponse = requireOk(await fetchImpl(dataEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: ENTRY_QUERY, variables: { ids } }),
  }), 'RCSB data retrieval');
  const payload = await dataResponse.json();
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(`RCSB data retrieval returned GraphQL errors: ${payload.errors[0]?.message ?? 'unknown error'}`);
  }
  return payload;
}

/** Perform a bounded disease-agnostic RCSB full-text search for a selected target. */
export async function retrieveRcsbStructuresByText({
  target,
  fetchImpl = globalThis.fetch,
  maxEntries = 25,
  searchEndpoint = DEFAULT_SEARCH_ENDPOINT,
  dataEndpoint = DEFAULT_DATA_ENDPOINT,
} = {}) {
  const normalizedTarget = String(target ?? '').trim();
  if (!normalizedTarget) throw new Error('target is required for RCSB full-text search');
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl is required');
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 100) {
    throw new Error('maxEntries must be an integer between 1 and 100');
  }
  const searchResponse = requireOk(await fetchImpl(searchEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: { type: 'terminal', service: 'full_text', parameters: { value: `\"${normalizedTarget}\"` } },
      return_type: 'entry',
      request_options: { paginate: { start: 0, rows: maxEntries } },
    }),
  }), 'RCSB full-text search');
  const searchPayload = await searchResponse.json();
  const ids = [...new Set((searchPayload.result_set ?? []).map((item) => String(item.identifier ?? '').toUpperCase()).filter(Boolean))]
    .slice(0, maxEntries);
  if (ids.length === 0) return { data: { entries: [] } };
  const dataResponse = requireOk(await fetchImpl(dataEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: ENTRY_QUERY, variables: { ids } }),
  }), 'RCSB target data retrieval');
  const payload = await dataResponse.json();
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(`RCSB target data retrieval returned GraphQL errors: ${payload.errors[0]?.message ?? 'unknown error'}`);
  }
  return payload;
}

function firstNonEmpty(values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() ?? null;
}

function organismsFor(entry) {
  return [...new Set((entry.polymer_entities ?? []).flatMap((entity) => [
    ...(entity.entity_src_gen ?? []).map((source) => source.pdbx_gene_src_scientific_name),
    ...(entity.entity_src_nat ?? []).map((source) => source.pdbx_organism_scientific),
  ]).filter(Boolean))];
}

function ligandsFor(entry) {
  return [...new Map((entry.nonpolymer_entities ?? []).map((entity) => {
    const ligand = entity.pdbx_entity_nonpoly ?? {};
    return [ligand.comp_id, { id: ligand.comp_id ?? null, name: ligand.name ?? null }];
  }).filter(([id]) => id)).values()];
}

/** Normalize an RCSB GraphQL response to Mend's canonical Y-axis evidence records. */
export function normalizeRcsbStructures(payload, {
  retrievedAt = new Date().toISOString(),
  subject = DEFAULT_SUBJECT,
} = {}) {
  const entries = payload?.data?.entries;
  if (!Array.isArray(entries)) throw new Error('RCSB payload is missing data.entries');

  return entries.map((entry) => {
    const structureId = String(entry?.rcsb_id ?? '').toUpperCase();
    const method = firstNonEmpty((entry?.exptl ?? []).map((experiment) => experiment.method));
    const resolutions = (entry?.rcsb_entry_info?.resolution_combined ?? [])
      .map(Number)
      .filter((value) => Number.isFinite(value) && value > 0);
    const resolution = resolutions.length > 0 ? Math.min(...resolutions) : null;
    const title = String(entry?.struct?.title ?? '').trim() || null;
    const sourceUrl = `https://www.rcsb.org/structure/${encodeURIComponent(structureId)}`;
    const evidenceParts = [
      `RCSB PDB entry ${structureId}`,
      method ? `reports experimental method ${method}` : 'does not report an experimental method',
      resolution == null ? 'with no reported resolution' : `at ${resolution} Å resolution`,
      title ? `titled “${title}”` : null,
    ].filter(Boolean);

    return {
      axis: 'Y',
      subject,
      value: structureId,
      source_url: sourceUrl,
      retrieved_at: retrievedAt,
      evidence: `${evidenceParts.join(', ')}.`,
      structure_id: structureId,
      target: subject,
      experimental_method: method,
      resolution_angstrom: resolution,
      organisms: organismsFor(entry),
      ligands: ligandsFor(entry),
      sample_state_description: title,
      disease_relevance: null,
    };
  });
}

/** Return all validation findings without discarding evidence from otherwise usable records. */
export function validateStructureRecords(records) {
  const errors = [];
  if (!Array.isArray(records) || records.length === 0) {
    errors.push({ index: null, field: 'records', message: 'at least one structure record is required' });
  }

  for (const [index, record] of (records ?? []).entries()) {
    if (!/^[0-9][A-Z0-9]{3}$/.test(record?.structure_id ?? '')) {
      errors.push({ index, field: 'structure_id', message: 'must be a valid four-character PDB identifier' });
    }
    if (!String(record?.experimental_method ?? '').trim()) {
      errors.push({ index, field: 'experimental_method', message: 'experimental method is required' });
    }
    if (record?.resolution_angstrom != null && (!Number.isFinite(record.resolution_angstrom) || record.resolution_angstrom <= 0)) {
      errors.push({ index, field: 'resolution_angstrom', message: 'resolution must be a positive number or null' });
    }
    if (!/^https:\/\/www\.rcsb\.org\/structure\/[0-9A-Z]{4}$/.test(record?.source_url ?? '')) {
      errors.push({ index, field: 'source_url', message: 'canonical RCSB source URL is required' });
    }
    if (!String(record?.evidence ?? '').trim()) {
      errors.push({ index, field: 'evidence', message: 'source evidence is required' });
    }
  }

  return { valid: errors.length === 0, record_count: records?.length ?? 0, errors };
}

export function summarizeStructureRecords(records) {
  const methodCounts = {};
  for (const record of records ?? []) {
    const method = record.experimental_method ?? 'UNKNOWN';
    methodCounts[method] = (methodCounts[method] ?? 0) + 1;
  }
  const resolutions = (records ?? []).map((record) => record.resolution_angstrom)
    .filter((value) => Number.isFinite(value) && value > 0);

  return {
    experimental_structures: records?.length ?? 0,
    methods: methodCounts,
    cryo_em_structures: Object.entries(methodCounts)
      .filter(([method]) => /ELECTRON MICROSCOPY/i.test(method))
      .reduce((total, [, count]) => total + count, 0),
    best_resolution_angstrom: resolutions.length > 0 ? Math.min(...resolutions) : null,
    disease_relevance: null,
    disease_relevance_note: 'Not inferred from target identity or structure availability.',
  };
}

/** Run the complete Y-axis integration from a fixture or a bounded live retrieval. */
export async function runYAxis({ fixture, retrievedAt, subject, target, ...retrieveOptions } = {}) {
  const payload = fixture ?? (target
    ? await retrieveRcsbStructuresByText({ target, ...retrieveOptions })
    : await retrieveRcsbStructures(retrieveOptions));
  const records = normalizeRcsbStructures(payload, { retrievedAt, subject });
  return {
    axis: 'Y',
    records,
    summary: summarizeStructureRecords(records),
    validation: validateStructureRecords(records),
  };
}
