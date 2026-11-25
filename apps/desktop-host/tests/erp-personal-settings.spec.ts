import { readFile } from 'node:fs/promises'
import { load } from 'js-yaml'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import * as erpWeb from '../../../packages/client/ui-erp-web/src/index.ts'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { expect, it } from 'vitest'
import { ErpDesktopTools, installErpDesktopTools } from '../src/erp-desktop-tools.ts'

it('proxies only current-user preferences through fixed authenticated targets and disposes its route', async () => {
  const routes = new Map<string, ConnectionFetchRoute>()
  const forwarded: { method?: string; path?: string; body?: string | null }[] = []
  class Connection extends Service {
    fetch = { register: (route: ConnectionFetchRoute) => {
      routes.set(route.path, route)
      return () => { routes.delete(route.path) }
    } }
    constructor(ctx: Context) { super(ctx, 'connection') }
  }
  const ctx = new Context()
  const bridge = new ErpDesktopTools('https://erp.example.com', (message) => {
    const row = message as { requestId: string; method: string; path: string; body: string | null }
    const data = row.path === '/api/plugins/ai-capabilities' ? { protocol_version: 1, capabilities: [] } : { instructions: '简洁回答' }
    if (row.path !== '/api/plugins/ai-capabilities') forwarded.push(row)
    queueMicrotask(() => { bridge.accept({ type: 'erp-tool-result', requestId: row.requestId,
      status: 200, body: JSON.stringify({ code: 0, data }) }) })
  })
  try {
    await ctx.plugin(Loader)
    await ctx.plugin(Connection)
    await installErpDesktopTools(ctx, bridge, [], 15_000)
    const route = routes.get('/api/erp-user-context')!
    expect(route.methods).toEqual(['GET', 'POST'])
    expect((await route.fetch(new Request('https://dsh.local/api/erp-user-context'))).status).toBe(200)
    expect((await route.fetch(new Request('https://dsh.local/api/erp-user-context', {
      method: 'POST', body: JSON.stringify({ instructions: '简洁回答' }),
    }))).status).toBe(200)
    expect(forwarded.map(row => ({ method: row.method, path: row.path, body: row.body }))).toEqual([
      { method: 'GET', path: '/api/ai/context/mine', body: null },
      { method: 'PUT', path: '/api/ai/context/mine', body: '{"instructions":"简洁回答"}' },
    ])
    for (const body of [{ instructions: 'x', user_id: 'other' }, { role_id: 'other' }, { instructions: 'x'.repeat(2001) }]) {
      expect((await route.fetch(new Request('https://dsh.local/api/erp-user-context', {
        method: 'POST', body: JSON.stringify(body),
      }))).status).toBe(400)
    }
    expect(forwarded).toHaveLength(2)
  } finally { await ctx.fiber.dispose() }
  expect(routes.size).toBe(0)
})

it('loads the settings-only entry from the actual ERP Desktop patch without iframe navigation', async () => {
  const patch = load(await readFile(new URL('../erp-llm.patch.yml', import.meta.url), 'utf8')) as
    { insert?: { id: string; name: string; config?: { settingsOnly?: boolean } }[] }[]
  const entry = patch.flatMap(row => row.insert ?? []).find(row => row.id === 'erp-personal-settings')!
  expect(entry.name).toBe('@deepseek-ai/dsh-client-ui-erp-web')
  expect(entry.config).toEqual({ settingsOnly: true })
  class WebServer extends Service { constructor(ctx: Context) { super(ctx, 'webServer') } }
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    await ctx.plugin(WebServer)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.loader.builtins['erp-settings-fixture'] = erpWeb
    await ctx.loader.create({ name: 'cordis:erp-settings-fixture', config: entry.config })
    await ctx.loader.await()
    for (const item of ctx.loader.entries()) await item.fiber?.await()
    const injections: IndexInjection[] = []
    ctx.emit('webserver/index-inject', injections, { principal: { kind: 'owner' } } as Parameters<Context['webServer']['collectIndexInjections']>[0])
    const config = injections.find(row => row.kind === 'global' && row.name === '__DSH_ERP_WEB_CONFIG__')
    if (config?.kind !== 'global') throw new Error('Desktop settings config was not injected')
    expect(config.value).toMatchObject({ settingsOnly: true })
    expect(ctx.tools.schemas()).toEqual([])
  } finally { await ctx.fiber.dispose() }
})
