const AXES = new Set(['X', 'Y', 'Z']);

function requiredText(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`evidence ${field} is required`);
  return text;
}

export function createEvidence(input) {
  const axis = requiredText(input?.axis, 'axis').toUpperCase();
  if (!AXES.has(axis)) throw new Error('evidence axis must be X, Y, or Z');

  const sourceUrl = requiredText(input?.source_url ?? input?.sourceUrl, 'source_url');
  let parsedUrl;
  try {
    parsedUrl = new URL(sourceUrl);
  } catch {
    throw new Error('evidence source_url must be an absolute URL');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('evidence source_url must use http or https');
  }

  const retrievedAt = input?.retrieved_at ?? input?.retrievedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(retrievedAt))) throw new Error('evidence retrieved_at must be an ISO timestamp');

  return Object.freeze({
    axis,
    subject: requiredText(input?.subject, 'subject'),
    value: requiredText(input?.value, 'value'),
    source_url: parsedUrl.toString(),
    retrieved_at: new Date(retrievedAt).toISOString(),
    evidence: requiredText(input?.evidence, 'evidence'),
  });
}

export function validateEvidenceRecords(records, expectedAxis) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`${expectedAxis} returned no evidence records`);
  }
  return records.map((record) => {
    const claim = record?.evidence && typeof record.evidence === 'object' ? record.evidence : record;
    const evidence = createEvidence(claim);
    if (evidence.axis !== expectedAxis) {
      throw new Error(`expected ${expectedAxis} evidence but received ${evidence.axis}`);
    }
    return Object.freeze({ ...record, ...evidence, evidence: evidence.evidence });
  });
}
