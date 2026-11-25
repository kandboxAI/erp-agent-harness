import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { expect, it, vi } from 'vitest'
import { ErpDesktopTools, installErpDesktopTools } from '../src/erp-desktop-tools.ts'

const enabledHarnessPlugins = ['erp.data', 'erp.navigation']
const capabilitiesBody = (enabled: string[]): string => JSON.stringify({
  code: 0, data: { protocol_version: 1, capabilities: enabled },
})

it('registers navigation and data as separate built-in plugins with independent lifecycles', async () => {
  const ctx = new Context()
  const enabled = enabledHarnessPlugins
  const bridge: ErpDesktopTools = new ErpDesktopTools('http://127.0.0.1:8000', (message) => {
    const row = message as { requestId: string; path?: string }
    queueMicrotask(() =>{  bridge.accept({ type: 'erp-tool-result', requestId: row.requestId, status: 200,
      body: capabilitiesBody(row.path === '/api/plugins/ai-capabilities' ? enabled : []) }) })
  })
  try {
    await ctx.plugin(Loader)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)
    await installErpDesktopTools(ctx, bridge, [], 15_000)
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual(expect.arrayContaining([
      'education_erp_api', 'education_erp_query', 'education_erp_discover', 'education_erp_open_page',
      'erp_knowledge_create_document', 'erp_knowledge_list_bases', 'erp_knowledge_search', 'erp_knowledge_read_document', 'erp_knowledge_update_document', 'erp_knowledge_version_status', 'erp_knowledge_submit_version',
    ]))
    const entries = [...ctx.loader.entries()]
    const data = entries.find(entry => entry.options.name === 'cordis:education-erp-data')
    const navigation = entries.find(entry => entry.options.name === 'cordis:education-erp-navigation')
    expect(data).toBeDefined()
    expect(navigation).toBeDefined()
    await ctx.loader.update(data!.id, { disabled: true })
    expect(ctx.tools.schemas().map(tool => tool.name)).not.toContain('education_erp_api')
    expect(ctx.tools.schemas().map(tool => tool.name)).not.toContain('education_erp_query')
    expect(ctx.tools.schemas().map(tool => tool.name)).not.toContain('education_erp_discover')
    expect(ctx.tools.schemas().map(tool => tool.name)).not.toContain('erp_knowledge_create_document')
    expect(ctx.tools.schemas().map(tool => tool.name)).not.toContain('erp_knowledge_list_bases')
    expect(ctx.tools.schemas().map(tool => tool.name)).not.toContain('erp_knowledge_search')
    expect(ctx.tools.schemas().map(tool => tool.name)).not.toContain('erp_knowledge_read_document')
    expect(ctx.tools.schemas().map(tool => tool.name)).not.toContain('erp_knowledge_update_document')
    expect(ctx.tools.schemas().map(tool => tool.name)).toContain('education_erp_open_page')
    await ctx.loader.update(data!.id, { disabled: false })
    await ctx.loader.update(navigation!.id, { disabled: true })
    expect(ctx.tools.schemas().map(tool => tool.name)).toContain('education_erp_api')
    expect(ctx.tools.schemas().map(tool => tool.name)).not.toContain('education_erp_open_page')
  } finally { await ctx.fiber.dispose() }
})

it('enables and disables ERP built-in plugins as the tenant plugin catalog changes', async () => {
  const ctx = new Context()
  const knowledgeInjections = (): IndexInjection[] => {
    const rows: IndexInjection[] = []
    ctx.emit('webserver/index-inject', rows, { principal: { kind: 'owner' } } as Parameters<Context['webServer']['collectIndexInjections']>[0])
    return rows.filter(row => row.kind === 'global' && row.name === '__DSH_KNOWLEDGE_BASES_PATH__')
  }
  const pickerInjection = [{ kind: 'global', name: '__DSH_KNOWLEDGE_BASES_PATH__', value: '/api/education/knowledge-bases' }]
  let enabled: string[] = []
  const bridge: ErpDesktopTools = new ErpDesktopTools('http://127.0.0.1:8000', (message) => {
    const row = message as { requestId: string; path?: string }
    queueMicrotask(() =>{  bridge.accept({ type: 'erp-tool-result', requestId: row.requestId, status: 200,
      body: capabilitiesBody(row.path === '/api/plugins/ai-capabilities' ? enabled : []) }) })
  })
  try {
    await ctx.plugin(Loader)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)
    await installErpDesktopTools(ctx, bridge, [], 1_000)
    expect(ctx.tools.get('education_erp_api')).toBeUndefined()
    expect(ctx.tools.get('education_erp_open_page')).toBeUndefined()
    expect(knowledgeInjections()).toEqual(pickerInjection)

    enabled = enabledHarnessPlugins
    await vi.waitFor(() => {
      expect(ctx.tools.get('education_erp_api')).toBeDefined()
      expect(ctx.tools.get('education_erp_open_page')).toBeDefined()
    }, { interval: 10, timeout: 2_000 })
    expect(knowledgeInjections()).toEqual(pickerInjection)

    enabled = []
    await vi.waitFor(() => {
      expect(ctx.tools.get('education_erp_api')).toBeUndefined()
      expect(ctx.tools.get('education_erp_open_page')).toBeUndefined()
    }, { interval: 10, timeout: 2_000 })
    expect(knowledgeInjections()).toEqual(pickerInjection)
  } finally { await ctx.fiber.dispose() }
  expect(knowledgeInjections()).toEqual([])
})

it('rechecks tenant plugin access before data requests and page navigation', async () => {
  const tools = new Map<string, ToolDefinition>()
  const requests: string[] = []
  const bridge: ErpDesktopTools = new ErpDesktopTools('http://127.0.0.1:8000', (message) => {
    const row = message as { requestId: string; path?: string }
    requests.push(row.path ?? '')
    queueMicrotask(() =>{  bridge.accept({ type: 'erp-tool-result', requestId: row.requestId, status: 200,
      body: capabilitiesBody([]) }) })
  })
  const ctx = {
    inject() { return () => {} },
    on() { return () => {} },
    get() { return undefined },
    effect(callback: () => () => void) { callback() },
    tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => { tools.delete(tool.name) } } },
  } as unknown as Context
  bridge.dataPlugin().apply(ctx)
  bridge.navigationPlugin().apply(ctx)
  const exec = { signal: new AbortController().signal, agent: { session: { id: 'session-1' } } } as never

  await expect(tools.get('education_erp_api')!.execute({ method: 'GET', path: '/api/users' }, exec))
    .rejects.toThrow('当前 ERP 连接未开放此通用能力')
  await expect(tools.get('education_erp_open_page')!.execute({ path: '/students/list' }, exec))
    .rejects.toThrow('当前 ERP 连接未开放此通用能力')
  expect(requests).toEqual(['/api/plugins/ai-capabilities', '/api/plugins/ai-capabilities'])
})

it('rejects an invalid tenant plugin-state refresh interval before creating Loader entries', async () => {
  const ctx = new Context()
  const bridge = new ErpDesktopTools('http://127.0.0.1:8000', () => {})
  await expect(installErpDesktopTools(ctx, bridge, [], 999)).rejects.toThrow(
    'pluginStateRefreshMs must be an integer of at least 1000',
  )
})

it('restores the ERP API, query, and page navigation tools through desktop IPC', async () => {
  const tools = new Map<string, ToolDefinition>()
  const messages: object[] = []
  const bridge = new ErpDesktopTools('https://erp.example.com', (message) => {
    messages.push(message)
    const row = message as { requestId: string; kind: string }
    queueMicrotask(() =>{  bridge.accept((message as { path?: string }).path === '/api/plugins/ai-capabilities'
      ? { type: 'erp-tool-result', requestId: row.requestId, status: 200, body: capabilitiesBody(enabledHarnessPlugins) }
      : row.kind === 'navigate'
        ? { type: 'erp-tool-result', requestId: row.requestId, ok: true, actualPath: '/students/list' }
        : { type: 'erp-tool-result', requestId: row.requestId, status: 200,
          body: row.kind === 'api' && (message as { path?: string }).path === '/api/harness/api'
            ? '{"code":0,"data":{"status":200,"ok":true,"data":{"resources":[]}}}'
            : (message as { path?: string }).path === '/api/harness/navigation'
              ? '{"code":0,"data":{"menu_key":"Students","path":"/students/list","query":{}}}'
              : (message as { path?: string }).path === '/api/harness/discovery'
                ? '{"code":0,"data":{"discovery_contract_version":1,"catalog_revision":"sha256:test","candidates":[]}}'
                : '{"code":0,"data":{"policy_version":1,"resources":[]}}' }) })
  })
  const ctx = {
    inject() { return () => {} },
    on() { return () => {} },
    get() { return undefined },
    effect(callback: () => () => void) { callback() },
    tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => { tools.delete(tool.name) } } },
  } as unknown as Context
  bridge.dataPlugin().apply(ctx)
  bridge.navigationPlugin().apply(ctx)
  expect([...tools.keys()].sort()).toEqual(['education_erp_api', 'education_erp_discover', 'education_erp_open_page', 'education_erp_query', 'erp_knowledge_create_document', 'erp_knowledge_list_bases', 'erp_knowledge_read_document', 'erp_knowledge_search', 'erp_knowledge_submit_version', 'erp_knowledge_update_document', 'erp_knowledge_version_status', 'erp_position_memory_read', 'erp_position_memory_update'])
  const exec = { signal: new AbortController().signal, agent: { session: { id: 'session-1' } } } as never
  const api = await tools.get('education_erp_api')!.execute({ method: 'GET', path: '/api/users' }, exec)
  expect(api).toMatchObject({ ok: true, status: 200 })
  const catalog = await tools.get('education_erp_query')!.execute({ operation: 'catalog' }, exec)
  expect(catalog).toMatchObject({ code: 0, data: { resources: [] } })
  const discovered = await tools.get('education_erp_discover')!.execute({ action: 'search', question: '教师人数' }, exec)
  expect(discovered).toMatchObject({ code: 0, data: { catalog_revision: 'sha256:test' } })
  const opened = await tools.get('education_erp_open_page')!.execute({ path: '/students/list' }, exec)
  expect(opened).toMatchObject({ ok: true, actualPath: '/students/list' })
  expect(messages.filter(message => (message as { path?: string }).path !== '/api/plugins/ai-capabilities')).toMatchObject([
    { kind: 'api', path: '/api/harness/api' },
    { kind: 'api', path: '/api/harness/query' },
    { kind: 'api', path: '/api/harness/discovery' },
    { kind: 'api', path: '/api/harness/navigation' },
    { kind: 'navigate', path: '/students/list' },
  ])
  expect(messages.filter(message => (message as { path?: string }).path === '/api/plugins/ai-capabilities')).toHaveLength(4)
})

it('rejects an unsupported ERP protocol version before exposing capabilities', async () => {
  const bridge = new ErpDesktopTools('https://erp.example.com', (message) => {
    const row = message as { requestId: string }
    queueMicrotask(() =>{  bridge.accept({ type: 'erp-tool-result', requestId: row.requestId, status: 200,
      body: JSON.stringify({ code: 0, data: { protocol_version: 2, capabilities: enabledHarnessPlugins } }) }) })
  })
  await expect(bridge.enabledErpCapabilities(new AbortController().signal)).rejects.toThrow('目录响应无效')
})
