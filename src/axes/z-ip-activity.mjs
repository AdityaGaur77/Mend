import { createHash } from 'node:crypto';

const FORBIDDEN_LEGAL_CONCLUSIONS = [
  /freedom\s+to\s+operate/i,
  /\bFTO\b/,
  /(?:is|appears|seems)\s+(?:legally\s+)?clear\b/i,
  /no\s+(?:blocking|relevant)\s+(?:patents?|claims?)\b/i,
];

function text(value) {
  const normalized = value == null ? '' : String(value).trim();
  return normalized || null;
}
function stringList(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  const normalized = text(value);
  return normalized ? [normalized] : [];
}

function validDateOrNull(value, field, index) {
  const normalized = text(value);
  if (!normalized) return null;
  if (Number.isNaN(Date.parse(normalized))) {
    throw new Error(`Z source record ${index} has an invalid ${field}`);
  }
  return normalized;
}

function publicationId(record) {
  return text(
    record.publication_identifier ??
      record.publicationIdentifier ??
      record.publication_number ??
      record.publicationNumber ??
      record.patent_publication ??
      record.id,
  );
}

/** Normalize one patent-source response into Mend's canonical Z evidence contract. */
export function normalizeIpActivityRecords(rawRecords, {
  sourceName = 'patent-data-source',
  retrievedAt = new Date().toISOString(),
  subject = 'SERPINA1 / Alpha-1 Antitrypsin Deficiency',
} = {}) {
  if (!Array.isArray(rawRecords) || rawRecords.length === 0) {
    throw new Error('Z patent source returned no records');
  }

  return rawRecords.map((raw, index) => {
    const identifier = publicationId(raw);
    const sourceUrl = text(raw.source_url ?? raw.sourceUrl ?? raw.url);
    const evidence = text(raw.evidence ?? raw.abstract_snippet ?? raw.abstractSnippet ?? raw.snippet);
    const assignee = text(raw.assignee ?? raw.applicant ?? raw.owner);
    const filingDate = validDateOrNull(raw.filing_date ?? raw.filingDate, 'filing date', index);
    const publicationDate = validDateOrNull(raw.publication_date ?? raw.publicationDate ?? raw.date, 'publication date', index);
    const targetTerms = stringList(raw.target_terms ?? raw.targetTerms ?? raw.terms);
    const id = createHash('sha256')
      .update(`Z\0${identifier ?? ''}\0${sourceUrl ?? ''}`)
      .digest('hex')
      .slice(0, 16);

    return {
      id,
      axis: 'Z',
      subject,
      value: identifier,
      source_url: sourceUrl,
      retrieved_at: retrievedAt,
      evidence,
      publication_identifier: identifier,
      assignee,
      filing_date: filingDate,
      publication_date: publicationDate,
      target_terms: targetTerms,
      status: text(raw.status),
      source_name: text(raw.source_name ?? raw.sourceName) ?? sourceName,
    };
  });
}

/** Validate only defensible publication metadata; assignee is deliberately optional. */
export function validateIpActivityRecords(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('Z validation requires at least one patent publication record');
  }

  const issues = [];
  records.forEach((record, index) => {
    if (record?.axis !== 'Z') issues.push(`record ${index}: axis must be Z`);
    if (!text(record?.publication_identifier)) issues.push(`record ${index}: publication identifier is required`);
    if (!text(record?.source_url)) issues.push(`record ${index}: source URL is required`);
    if (!text(record?.source_name)) issues.push(`record ${index}: source name is required`);
    if (!text(record?.evidence)) issues.push(`record ${index}: evidence is required`);
    if (record?.assignee != null && !text(record.assignee)) issues.push(`record ${index}: assignee must be non-empty when supplied`);
  });

  if (issues.length) throw new Error(`Z IP Activity validation failed: ${issues.join('; ')}`);
  return { status: 'PASS', record_count: records.length, issues: [] };
}

export function assertNoUnsupportedFtoClaim(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  const matched = FORBIDDEN_LEGAL_CONCLUSIONS.find((pattern) => pattern.test(serialized));
  if (matched) throw new Error('unsupported legal/FTO conclusion is not allowed in Z IP Activity output');
  return value;
}

/** Produce activity indicators only. This intentionally does not assess patent claims or legal clearance. */
export function summarizeIpActivity(records, { now = new Date(), recentYears = 3 } = {}) {
  validateIpActivityRecords(records);
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - recentYears);

  const knownAssignees = [...new Set(records.map((record) => record.assignee).filter(Boolean))].sort();
  const recentRecords = records.filter((record) => {
    const date = record.publication_date ?? record.filing_date;
    return date && new Date(date) >= cutoff && new Date(date) <= now;
  });

  const summary = {
    label: 'Z — IP ACTIVITY',
    relevant_records: records.length,
    known_assignees: knownAssignees.length,
    assignees: knownAssignees,
    recent_activity: recentRecords.length,
    recent_window_years: recentYears,
    evidence_record_ids: records.map((record) => record.id),
    recent_evidence_record_ids: recentRecords.map((record) => record.id),
    analysis_scope: 'Visible patent publication activity matching the configured target/program terms.',
    legal_conclusion: null,
    disclaimer: 'Intelligence signal only; not legal advice or a patent-claim analysis.',
  };

  return assertNoUnsupportedFtoClaim(summary);
}

export async function retrieveIpActivity(retrieve, query) {
  if (typeof retrieve !== 'function') throw new TypeError('Z axis requires an injected retrieval function');
  const response = await retrieve(query);
  const records = Array.isArray(response) ? response : response?.records;
  if (!Array.isArray(records)) throw new Error('Z retrieval must return an array or { records: [] }');
  return records;
}

/** Source-agnostic Z-axis runner. Inject a live source client or a deterministic fixture reader. */
export async function runZAxis({
  retrieve,
  query = { disease: 'Alpha-1 Antitrypsin Deficiency', target: 'SERPINA1' },
  sourceName,
  clock = () => new Date(),
  recentYears = 3,
} = {}) {
  const rawRecords = await retrieveIpActivity(retrieve, query);
  const now = clock();
  const records = normalizeIpActivityRecords(rawRecords, {
    sourceName,
    retrievedAt: now.toISOString(),
    subject: `${query.target} / ${query.disease}`,
  });
  const validation = validateIpActivityRecords(records);
  const summary = summarizeIpActivity(records, { now, recentYears });
  return { axis: 'Z', records, summary, validation };
}
