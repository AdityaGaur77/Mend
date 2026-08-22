const DEFAULT_ENDPOINT = 'https://data.epo.org/linked-data/query';

function sparqlString(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

export function buildEpoIpActivityQuery({ target = 'SERPINA1', disease = 'Alpha-1 Antitrypsin Deficiency', limit = 25 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('EPO result limit must be between 1 and 50');
  const terms = [target, disease, 'alpha-1 antitrypsin', 'antitrypsin'].map((term) => sparqlString(term.toLowerCase()));
  return `PREFIX patent: <http://data.epo.org/linked-data/def/patent/>
SELECT DISTINCT ?publication ?title ?date WHERE {
  ?publication patent:titleOfInvention ?title .
  OPTIONAL { ?publication patent:publicationDate ?date }
  FILTER(LANG(?title) = "" || LANGMATCHES(LANG(?title), "en"))
  FILTER(
    CONTAINS(LCASE(STR(?title)), "${terms[0]}") ||
    CONTAINS(LCASE(STR(?title)), "${terms[1]}") ||
    CONTAINS(LCASE(STR(?title)), "${terms[2]}") ||
    CONTAINS(LCASE(STR(?title)), "${terms[3]}")
  )
}
LIMIT ${limit}`;
}

function bindingValue(binding, key) {
  const value = binding?.[key]?.value;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function publicationIdentifier(uri) {
  const parts = String(uri ?? '').split('/').filter(Boolean);
  const publicationIndex = parts.lastIndexOf('publication');
  const tail = publicationIndex >= 0 ? parts.slice(publicationIndex + 1) : parts.slice(-4);
  return tail.filter((part) => part !== '-').join('') || null;
}

export function normalizeEpoBindings(payload, query) {
  const bindings = payload?.results?.bindings;
  if (!Array.isArray(bindings)) throw new Error('EPO SPARQL response is missing results.bindings');
  return bindings.map((binding) => {
    const uri = bindingValue(binding, 'publication');
    const title = bindingValue(binding, 'title');
    const abstract = bindingValue(binding, 'abstract');
    return {
      publication_identifier: publicationIdentifier(uri),
      assignee: bindingValue(binding, 'applicant'),
      publication_date: bindingValue(binding, 'date'),
      target_terms: [query.target, query.disease],
      status: null,
      source_name: 'European Patent Office Linked Open EP Data',
      source_url: uri?.replace(/^http:\/\/data\.epo\.org/, 'https://data.epo.org'),
      evidence: [title, abstract].filter(Boolean).join(' — '),
    };
  });
}

export function createEpoLinkedDataRetriever({
  fetchImpl = globalThis.fetch,
  endpoint = DEFAULT_ENDPOINT,
  limit = 25,
  timeoutMs = 20_000,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl is required');
  return async (query = {}) => {
    const sparql = buildEpoIpActivityQuery({ ...query, limit });
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { accept: 'application/sparql-results+json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ query: sparql, format: 'application/sparql-results+json' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response?.ok) throw new Error(`EPO Linked Open Data request failed with HTTP ${response?.status ?? 'unknown'}`);
    return normalizeEpoBindings(await response.json(), query);
  };
}
