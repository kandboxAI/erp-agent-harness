/** Knowledge picker references, message serialization, and reversible registrations. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { CommandContribution } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { registerKnowledgeReferences } from '../src/client/knowledge.ts'
import { NS, zh, en } from '../src/client/locales.ts'

afterEach(() => { vi.unstubAllGlobals() })

it('inserts only the picked knowledge base and releases both registrations on disposal', async () => {
  const ctx = new Context()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  locale.register(NS, { zh, en })
  let source: InputTriggerSource | undefined
  let command: CommandContribution | undefined
  const toggleSource = vi.fn()
  let draftRev = 0
  ctx.on('slash/input-insert-text', () => { draftRev += 1; return true })
  ctx.provide('inputTriggers', { registerSource(value: InputTriggerSource) {
    source = value
    return () => { source = undefined }
  }, sessionOf: () => ({ toggleSource }) })
  ctx.provide('commandUi', { register(value: CommandContribution) {
    command = value
    return () => { command = undefined }
  } })
  ctx.provide('sessions', { binding: () => ({}), scope: () => ctx })
  ctx.provide('conversation', { input: { for: () => ({ state: { getSnapshot: () => ({ draftRev }) } }) } })
  const baseId = '01900000-0000-7000-8000-000000000001'
  vi.stubGlobal('__DSH_KNOWLEDGE_BASES_PATH__', '/api/education/knowledge-bases')
  vi.stubGlobal('location', { origin: 'http://localhost:19387' })
  const fetch = vi.fn((_url: URL, _init?: RequestInit) => Promise.resolve(Response.json({ bases: [
    { knowledge_base_id: baseId, knowledge_base_name: '员工制度' },
  ] })))
  vi.stubGlobal('fetch', fetch)
  const fiber = ctx.plugin({ apply: (scope: Context) => { registerKnowledgeReferences(scope) } })
  try {
    await fiber.await()
    expect(command?.label?.()).toBe('知识库')
    const registered = source!
    const session = { sessionId: 'session-knowledge' as SessionId }
    if (command?.ui.kind !== 'action') throw new Error('Knowledge command must be an action')
    command.ui.run(session)
    expect(toggleSource).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(toggleSource).toHaveBeenCalledWith('knowledge', expect.objectContaining({ span: { start: 0, end: 4, draftRev: 1 } }))
    const request = { query: 'kb:员工', quoted: false, position: 'inline' as const, drilled: false, signal: new AbortController().signal }
    const rows = await registered.candidates(session, request)
    const url = fetch.mock.calls[0]?.[0]
    expect(url?.searchParams.get('sessionId')).toBe('session-knowledge')
    expect(url?.searchParams.get('query')).toBe('员工')
    const selected = registered.onPick({ candidate: rows[0]!, session, position: 'inline', via: 'menu', action: 'pick',
      span: { start: 0, end: 6, draftRev: 1 } })
    const namedRef = `@[员工制度](knowledge-base:${baseId})`
    expect(selected).toEqual({ insert: { source: 'knowledge', ref: namedRef, label: '员工制度', clipboardText: namedRef } })
    await expect(registered.codec?.serialize(namedRef, request.signal)).resolves.toBe(namedRef)
    expect(registered.onPick({ candidate: { ...rows[0]!, value: JSON.stringify({ knowledge_base_id: baseId, knowledge_base_name: '制度] \\内审' }) }, session, position: 'inline', via: 'menu', action: 'pick',
      span: { start: 0, end: 6, draftRev: 1 } })).toMatchObject({ insert: { ref: `@[制度\\] \\\\内审](knowledge-base:${baseId})` } })
    expect(await registered.candidates(session, { ...request, query: 'ordinary-file' })).toEqual([])
    expect(fetch).toHaveBeenCalledOnce()
    fetch.mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 403 })))
    await expect(registered.candidates(session, request)).rejects.toThrow('读取权限')
    await fiber.dispose()
    expect(source).toBeUndefined()
    expect(command).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
  }
})

it('does not offer knowledge bases without an authenticated Host provider', async () => {
  const ctx = new Context()
  try {
    registerKnowledgeReferences(ctx)
    await ctx.fiber.await()
    expect(ctx.get('commandUi')).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
  }
})
