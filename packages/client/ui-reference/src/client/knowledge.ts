/** Optional knowledge-base references supplied by the authenticated Host. */
import type { Context } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { IconDatabaseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from './locales.ts'

interface BaseOption {
  knowledge_base_id: Branded<'ErpKnowledgeBaseId'>
  knowledge_base_name: string
}

function baseOf(row: unknown): BaseOption {
  if (row === null || typeof row !== 'object'
      || !('knowledge_base_id' in row) || typeof row.knowledge_base_id !== 'string'
      || !/^[0-9a-f-]{36}$/.test(row.knowledge_base_id)
      || !('knowledge_base_name' in row) || typeof row.knowledge_base_name !== 'string') {
    throw new Error('Invalid knowledge base option')
  }
  return { knowledge_base_id: row.knowledge_base_id as BaseOption['knowledge_base_id'], knowledge_base_name: row.knowledge_base_name }
}

function basesOf(value: unknown): BaseOption[] {
  if (value === null || typeof value !== 'object' || !('bases' in value) || !Array.isArray(value.bases)) {
    throw new Error('Invalid knowledge base response')
  }
  return value.bases.map(baseOf)
}

/**
 * Register knowledge picking when the Host publishes its authenticated endpoint.
 * @param ctx - Reference plugin context owning menu and source disposal.
 * @returns Whether the Host offers knowledge-base discovery.
 */
export function registerKnowledgeReferences(ctx: Context): boolean {
  const path = (globalThis as { __DSH_KNOWLEDGE_BASES_PATH__?: string }).__DSH_KNOWLEDGE_BASES_PATH__
  if (path === undefined) return false
  if (!path.startsWith('/api/') || path.startsWith('//')) throw new Error('Invalid knowledge base endpoint')
  ctx.inject(['commandUi', 'conversation'], (scope) => {
    const t = scope.locale.bind(NS)
    const sessions = scope.get('sessions') as ISessions
    const source: InputTriggerSource = {
      trigger: '@', name: 'knowledge', showGroupTitle: false,
      async candidates(session, { query, quoted, signal }) {
        if (quoted === true || !query.startsWith('kb:')) return []
        const url = new URL(path, globalThis.location.origin)
        url.searchParams.set('sessionId', session.sessionId)
        url.searchParams.set('query', query.slice(3))
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal })
        if (!response.ok) throw new Error(t('knowledge.loadFailed'))
        const bases = basesOf(await response.json())
        return bases.map(base => ({
          name: base.knowledge_base_name, label: base.knowledge_base_name,
          section: t('knowledge.label'), icon: IconDatabaseOutlineRegular,
          value: JSON.stringify(base),
        }))
      },
      header(_session, { query }) {
        return query.startsWith('kb:') ? [{ label: t('knowledge.searchHint'), value: '', current: true }] : undefined
      },
      onPick({ candidate }) {
        const base = baseOf(JSON.parse(candidate.value ?? 'null'))
        const label = base.knowledge_base_name.replace(/[\r\n]/g, ' ').replace(/[\\\]]/g, '\\$&')
        const ref = `@[${label}](knowledge-base:${base.knowledge_base_id})`
        return { insert: { source: 'knowledge', ref, label: base.knowledge_base_name, clipboardText: ref } }
      },
      codec: { clipboardText: ref => ref, serialize: ref => Promise.resolve(ref) },
    }
    scope.effect(() => scope.inputTriggers.registerSource(source), 'ui-reference: knowledge source')
    scope.effect(() => scope.commandUi.register({
      name: 'knowledge', label: () => t('knowledge.label'),
      description: () => t('knowledge.description'), icon: IconDatabaseOutlineRegular,
      available: session => sessions.binding(session.sessionId) !== undefined,
      ui: {
        kind: 'action',
        run(session) {
          // 指令选中后仍会关闭旧菜单；下一微任务再打开知识库列表。
          queueMicrotask(() => {
            const actx = sessions.scope(session.sessionId)
            if (actx === undefined) return
            const input = scope.conversation.input.for(actx)
            const applied = actx.bail('slash/input-insert-text', {
              text: '@kb:', span: { start: 0, end: 0, draftRev: input.state.getSnapshot().draftRev },
            })
            if (applied !== true) return
            scope.inputTriggers.sessionOf(actx).toggleSource('knowledge', {
              trigger: '@', query: 'kb:', quoted: false, position: 'inline',
              span: { start: 0, end: 4, draftRev: input.state.getSnapshot().draftRev },
            })
          })
        },
      },
    }), 'ui-reference: knowledge command')
  })
  return true
}
