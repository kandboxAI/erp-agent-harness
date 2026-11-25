import { fileURLToPath } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, it } from 'vitest'
import { ErpDesktopTools } from '../src/erp-desktop-tools.ts'

it('opens a renamed MES menu through the generic Loader plugin and refuses revoked targets', async () => {
  const calls: { kind: string; path: string; body?: string }[] = []
  let allowed = true
  const bridge = new ErpDesktopTools('https://erp.example.com', (message) => {
    const request = message as { requestId: string; kind: string; path: string; body?: string }
    calls.push(request)
    let result: object
    if (request.path === '/api/plugins/ai-capabilities') {
      result = { status: 200, body: JSON.stringify({ code: 0, data: { protocol_version: 1, capabilities: ['erp.navigation'] } }) }
    } else if (request.kind === 'api') {
      expect(JSON.parse(request.body!)).toEqual({ menu_key: 'MesWorkOrders', query: { page: 2 } })
      result = { status: allowed ? 200 : 404, body: JSON.stringify({ code: allowed ? 0 : 404,
        data: allowed ? { menu_key: 'MesWorkOrders', path: '/factory/orders', query: { page: 2 } } : null }) }
    } else {
      result = { ok: true, actualPath: '/factory/orders?page=2' }
    }
    queueMicrotask(() => bridge.accept({ type: 'erp-tool-result', requestId: request.requestId, ...result }))
  })
  const path = fileURLToPath(new URL('./fixtures/erp-navigation.cordis.yml', import.meta.url))
  const ctx = await boot('erp-navigation-test', path, [], (ctx) => {
    Object.assign(ctx.loader.builtins, { 'system-prompt': SystemPrompt, tools: ToolRuntime,
      'erp-navigation': bridge.navigationPlugin() })
  })
  const tools = ctx.tools
  try {
    const tool = tools.get('erp_open_page')!
    const exec = { signal: new AbortController().signal } as never
    expect(await tool.execute({ menu_key: 'MesWorkOrders', query: { page: 2 } }, exec)).toMatchInlineSnapshot(`
      {
        "actualPath": "/factory/orders?page=2",
        "ok": true,
        "requestedPath": "/factory/orders",
      }
    `)
    expect(calls.filter(call => call.kind === 'navigate')).toMatchObject([{ path: '/factory/orders' }])
    allowed = false
    await expect(tool.execute({ menu_key: 'MesWorkOrders', query: { page: 2 } }, exec)).rejects.toThrow('无权访问')
    expect(calls.filter(call => call.kind === 'navigate')).toHaveLength(1)
  } finally {
    await ctx.fiber.dispose()
    expect(tools.get('erp_open_page')).toBeUndefined()
  }
})
