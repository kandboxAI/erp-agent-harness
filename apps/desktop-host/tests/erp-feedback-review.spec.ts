/** The desktop Host uses plugin-owned review policy and withdraws its routes on disposal. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { expect, it } from 'vitest'
import { ErpDesktopTools, installErpDesktopTools } from '../src/erp-desktop-tools.ts'

it('routes one review over dedicated IPC and parses grounded output without submitting feedback', async () => {
  const ctx = new Context()
  const routes = new Map<string, ConnectionFetchRoute>()
  ctx.provide('connection', { fetch: { register(route: ConnectionFetchRoute) {
    routes.set(route.path, route)
    return () => { routes.delete(route.path) }
  } } })
  const sent: { kind?: string; body?: string }[] = []
  let reviewStatus = 200
  const bridge: ErpDesktopTools = new ErpDesktopTools('https://erp.example.com', (message) => {
    const row = message as { requestId: string; kind?: string; body?: string }
    sent.push(row)
    queueMicrotask(() => bridge.accept({ type: 'erp-tool-result', requestId: row.requestId, status: row.kind === 'feedback-review' ? reviewStatus : 200,
      body: row.kind === 'feedback-review'
        ? JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ verdict: 'incomplete', reason: '未提交', evidence: '没有权限' }) }] })
        : JSON.stringify({ code: 0, data: { protocol_version: 1, capabilities: [] } }) }))
  })
  try {
    await ctx.plugin(Loader)
    await installErpDesktopTools(ctx, bridge, [], 15000)
    const route = routes.get('/api/erp-ai-control/review')
    expect(route).toBeDefined()
    const result = await route!.fetch(new Request('https://dsh.example/api/erp-ai-control/review', { method: 'POST',
      body: JSON.stringify({ question_snapshot: '提交申请', answer_snapshot: '没有权限，未提交。' }), headers: { 'content-type': 'application/json' } }))
    expect(await result.json()).toMatchObject({ code: 0, data: { verdict: 'incomplete', reason: '未提交' } })
    const reviews = sent.filter(row => row.kind === 'feedback-review')
    expect(reviews).toHaveLength(1)
    const body = JSON.parse(reviews[0]!.body!) as { messages: { content: string }[] }
    expect(JSON.parse(body.messages[0]!.content)).toEqual({ question_snapshot: '提交申请', answer_snapshot: '没有权限，未提交。' })
    expect(sent.some(row => row.kind === 'api' && row.body?.includes('dsh_submission_no'))).toBe(false)
    reviewStatus = 404
    const unavailable = await route!.fetch(new Request('https://dsh.example/api/erp-ai-control/review', { method: 'POST',
      body: JSON.stringify({ question_snapshot: '提交申请', answer_snapshot: '没有权限，未提交。' }) }))
    expect(unavailable.status).toBe(404)
    expect(await unavailable.json()).toMatchObject({ error_code: 'service_unavailable' })

  } finally { await ctx.fiber.dispose() }
  expect(routes.size).toBe(0)
})
