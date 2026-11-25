/** Citation addresses derived only from ERP-filtered knowledge results. */
const DOCUMENT_ID = /^[0-9a-f-]{36}$/
const SNAPSHOT = /^[0-9a-f]{64}$/
const CHUNK_NO = /^[a-zA-Z0-9_-]{1,128}$/

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Add stable source addresses without replacing the ERP document identity or body.
 * @param value - Knowledge search or read data returned by the authenticated ERP.
 * @returns A copy with addresses on identifiable chunks; other data stays unchanged.
 */
export function withKnowledgeCitations<T>(value: T): T {
  if (!record(value)) return value
  const cite = (chunk: unknown, document: Record<string, unknown>): unknown => {
    if (!record(chunk) || typeof document.document_id !== 'string' || !DOCUMENT_ID.test(document.document_id)
      || typeof document.source_hash_snapshot !== 'string' || !SNAPSHOT.test(document.source_hash_snapshot)
      || typeof chunk.chunk_no !== 'string' || !CHUNK_NO.test(chunk.chunk_no)) return chunk
    return { ...chunk, citation_url: `dsh-resource://knowledge/${document.document_id}/${document.source_hash_snapshot}/${chunk.chunk_no}` }
  }
  if (Array.isArray(value.results)) return { ...value, results: value.results.map((row: unknown) => record(row) ? cite(row, row) : row) }
  if (Array.isArray(value.chunks)) return { ...value, chunks: value.chunks.map(row => cite(row, value)) }
  return value
}
