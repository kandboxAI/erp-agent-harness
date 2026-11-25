import type { Branded } from '@deepseek-ai/dsh-brand'

interface CitationSource {
  document_id: Branded<'ErpKnowledgeDocumentId'>
  source_hash_snapshot: string
  chunk_no: Branded<'ErpKnowledgeChunkNo'>
}

/**
 * Decode only addresses issued from a document, snapshot, and engine chunk number.
 * @param address - Model-authored source destination.
 * @returns The source fields, or undefined for another or malformed destination.
 */
export function citationSource(address: string): CitationSource | undefined {
  const match = /^dsh-resource:\/\/knowledge\/([0-9a-f-]{36})\/([0-9a-f]{64})\/([a-zA-Z0-9_-]{1,128})$/u.exec(address)
  if (match === null) return undefined
  const [, documentId = '', snapshot = '', chunkNo = ''] = match
  return { document_id: documentId as CitationSource['document_id'], source_hash_snapshot: snapshot,
    chunk_no: chunkNo as CitationSource['chunk_no'] }
}
