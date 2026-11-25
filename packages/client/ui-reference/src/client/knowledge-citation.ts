/** Knowledge source navigation; document access remains authoritative in ERP. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { KnowledgeCitation } from './KnowledgeCitation.tsx'
import { NS } from './locales.ts'

import { citationSource } from './knowledge-source.ts'

/**
 * Register the governed source preview when this Host offers knowledge access.
 * @param ctx - Client registration owner; all contributions unwind on disposal.
 */
export function registerKnowledgeCitations(ctx: Context): void {
  if ((globalThis as { __DSH_KNOWLEDGE_BASES_PATH__?: string }).__DSH_KNOWLEDGE_BASES_PATH__ === undefined) return
  ctx.inject(['sidebarRightTabs', 'slots'], (scope) => {
    const id = '@deepseek-ai/dsh-client-ui-reference/knowledge'
    const t = scope.locale.bind(NS)
    scope.effect(() => scope.sidebarRightTabs.register({
      id, kind: 'knowledge', patterns: ['dsh-resource://knowledge/**'], priority: 'builtin',
      canOpen: address => citationSource(address) !== undefined, title: () => t('citation.title'),
    }), 'ui-reference: knowledge citation type')
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab', key: id, locale: NS,
      inject: sessionId => ({
        async loadCitation(address: string, whole: boolean, page: number, signal: AbortSignal) {
          const source = citationSource(address)
          if (source === undefined) throw new Error(t('citation.failed'))
          const response = await fetch('/api/erp/knowledge-citation', {
            method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, document_id: source.document_id, source_hash_snapshot: source.source_hash_snapshot,
              ...whole ? { page } : { chunk_no: source.chunk_no } }),
          })
          if (!response.ok) throw new Error(t(response.status === 409 ? 'citation.changed'
            : [401, 403, 404].includes(response.status) ? 'citation.denied' : 'citation.failed'))
          return response.json() as Promise<unknown>
        },
      }),
    }, KnowledgeCitation)), 'ui-reference: knowledge citation body')
  })
}
