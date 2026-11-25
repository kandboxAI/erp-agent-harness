import { fileURLToPath } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { expect, it } from 'vitest'
import { ErpDesktopTools } from '../src/erp-desktop-tools.ts'

const capabilitiesBody = JSON.stringify({
  code: 0, data: { protocol_version: 1, capabilities: ['erp.data', 'erp.navigation'] },
})

it('executes a relational plan through the app Loader and renders bounded results without credentials', async () => {
  const path = fileURLToPath(new URL('./fixtures/erp-discovery.cordis.yml', import.meta.url))
  const calls: { requestId: string; path: string; body: string }[] = []
  const bridge = new ErpDesktopTools('https://erp.example.com', (message) => {
    const request = message as { requestId: string; path: string; body: string }
    calls.push(request)
    queueMicrotask(() => bridge.accept({ type: 'erp-tool-result', requestId: request.requestId, status: 200,
      body: request.path === '/api/plugins/ai-capabilities' ? capabilitiesBody
        : JSON.stringify({ code: 0, data: { policy_version: 1, plan_version: 1, rows: [{ department: '教务', n: 3 }],
          grain: 'root_records_per_group', group_totals_additive: true, next_offset: null } }) }))
  })
  const ctx = await boot('erp-plan-test', path, [], (ctx) => {
    ctx.loader.builtins['discovery-system-prompt'] = SystemPrompt
    ctx.loader.builtins['discovery-tools'] = ToolRuntime
    ctx.loader.builtins.skills = SkillRegistry
    ctx.loader.builtins['education-erp-data'] = bridge.dataPlugin()
  })
  const tools = ctx.tools
  try {
    const tool = tools.get('education_erp_query')
    if (!tool) throw new Error('Query tool not registered')
    const schema = JSON.stringify(tools.schemas().find(schema => schema.name === 'education_erp_query'))
    expect(schema).toContain('execution.max_joins')
    expect(schema).not.toContain('At most 3 joins')
    const args = { operation: 'plan', catalog_revision: 'sha256:current', plan: {
      root: { resource: 'public.edu_teachers', alias: 't' },
      joins: [
        { from_alias: 't', relation_id: 'relation:teacher_department', alias: 'd', kind: 'left' },
        { from_alias: 'd', relation_id: 'relation:department_teachers', alias: 't2', kind: 'left' },
        { from_alias: 't2', relation_id: 'relation:teacher_department', alias: 'd2', kind: 'left' },
        { from_alias: 'd2', relation_id: 'relation:department_teachers', alias: 't3', kind: 'left' },
      ],
      select: [{ field: 'd.name', as: 'department' }], group_by: ['d.name'], aggregates: [{ function: 'count', as: 'n' }],
    } }
    const result = await tool.execute(args, { signal: new AbortController().signal, agent: { session: { id: 'plan-session' } } } as never)
    expect(calls.filter(request => request.path === '/api/harness/query'))
      .toMatchObject([{ path: '/api/harness/query', body: JSON.stringify(args) }])
    expect(result).toMatchObject({ code: 0, data: { plan_version: 1, rows: [{ department: '教务', n: 3 }] } })
    const visible = { code: 0, data: { policy_version: 1, plan_version: 1, rows: [{ department: '教务', n: 3 }],
      grain: 'root_records_per_group', group_totals_additive: true, next_offset: null } }
    expect(result).toEqual(visible)
    expect(tool.output?.render?.(args, visible)).toEqual([{ type: 'text', text: JSON.stringify(visible, null, 2) }])
    expect(JSON.stringify(result)).not.toContain('Bearer')
  } finally {
    await ctx.fiber.dispose()
    expect(tools.get('education_erp_query')).toBeUndefined()
  }
})

it('keeps writes pending when the real Loader composition has no confirmation provider', async () => {
  const path = fileURLToPath(new URL('./fixtures/erp-discovery.cordis.yml', import.meta.url))
  const requests: string[] = []
  const bridge = new ErpDesktopTools('https://erp.example.com', (message) => {
    const request = message as { requestId: string; path: string }
    requests.push(request.path)
    queueMicrotask(() => bridge.accept({ type: 'erp-tool-result', requestId: request.requestId,
      status: request.path === '/api/plugins/ai-capabilities' ? 200 : 409,
      body: request.path === '/api/plugins/ai-capabilities' ? capabilitiesBody
        : JSON.stringify({ code: 0, data: { status: 409, ok: false, approval_required: true } }) }))
  })
  const ctx = await boot('erp-confirmation-test', path, [], (ctx) => {
    ctx.loader.builtins['discovery-system-prompt'] = SystemPrompt
    ctx.loader.builtins['discovery-tools'] = ToolRuntime
    ctx.loader.builtins.skills = SkillRegistry
    ctx.loader.builtins['education-erp-data'] = bridge.dataPlugin()
  })
  const tools = ctx.tools
  try {
    const tool = tools.get('education_erp_api')
    if (tool === undefined) throw new Error('API tool not registered')
    await expect(tool.execute({ method: 'POST', path: '/api/business/change', body: { enabled: true } }, {
      signal: new AbortController().signal, agent: { session: { id: 'session-write' } },
    } as never)).rejects.toThrow('确认界面')
    expect(requests.filter(path => path !== '/api/plugins/ai-capabilities')).toEqual(['/api/harness/api'])
  } finally {
    await ctx.fiber.dispose()
    expect(tools.get('education_erp_api')).toBeUndefined()
  }
})

it('loads the ERP data plugin in the app Loader and renders discovered resources for the model', async () => {
  const path = fileURLToPath(new URL('./fixtures/erp-discovery.cordis.yml', import.meta.url))
  const bridge = new ErpDesktopTools('https://erp.example.com', (message) => {
    if (!('requestId' in message) || typeof message.requestId !== 'string') throw new Error('Missing IPC request id')
    const request = message as { path?: string }
    queueMicrotask(() => bridge.accept({ type: 'erp-tool-result', requestId: message.requestId, status: 200,
      body: request.path === '/api/plugins/ai-capabilities' ? capabilitiesBody
        : JSON.stringify({ code: 0, data: { discovery_contract_version: 1, catalog_revision: 'sha256:test',
          candidates: [{ id: 'resource:education.instructor', label: '教师', summary: '教师类型、学历、职称' }] } }) }))
  })
  const ctx = await boot('erp-discovery-test', path, [], (ctx) => {
    ctx.loader.builtins['discovery-system-prompt'] = SystemPrompt
    ctx.loader.builtins['discovery-tools'] = ToolRuntime
    ctx.loader.builtins.skills = SkillRegistry
    ctx.loader.builtins['education-erp-data'] = bridge.dataPlugin()
  })
  const tools = ctx.tools
  try {
    expect(ctx.tools.schemas().some(schema => schema.name === 'education_erp_discover')).toBe(true)
    const tool = ctx.tools.get('education_erp_discover')
    if (!tool) throw new Error('Discovery tool not registered')
    const result = await tool.execute({ action: 'search', question: '教师学历结构' }, {
      signal: new AbortController().signal, agent: { session: { id: 'session-discovery' } },
    } as never)
    expect(result).toEqual({ code: 0, data: { discovery_contract_version: 1, catalog_revision: 'sha256:test',
      candidates: [{ id: 'resource:education.instructor', label: '教师', summary: '教师类型、学历、职称' }] } })
  } finally {
    await ctx.fiber.dispose()
    expect(tools.get('education_erp_discover')).toBeUndefined()
  }
})

it('searches and reads governed knowledge through the real Loader and removes its tools on disposal', async () => {
  const path = fileURLToPath(new URL('./fixtures/erp-discovery.cordis.yml', import.meta.url))
  const calls: object[] = []
  let status = 200
  let oversized = false
  const documentId = '01900000-0000-7000-8000-000000000001'
  const hit = { document_id: documentId, document_name: '报销制度', chunk_index: 2, chunk_no: 'chunk-a',
    source_hash_snapshot: 'a'.repeat(64), content: '住宿标准为每晚380元', truncated: false, score: 0.8 }
  const bridge = new ErpDesktopTools('https://erp.example.com', (message) => {
    const request = message as { requestId: string; path: string; body: string }
    if (request.path === '/api/plugins/ai-capabilities') {
      queueMicrotask(() => bridge.accept({ type: 'erp-tool-result', requestId: request.requestId,
        status: 200, body: capabilitiesBody }))
      return
    }
    const args = JSON.parse(request.body) as { method: string; path: string; body: object }
    expect(request.path).toBe('/api/harness/api')
    calls.push(args)
    const data = args.path === '/api/knowledge/search'
      ? { results: [hit], diagnostics: [{ applied: true, outcome: 'ok' }], recall_state: 'matched' }
      : { document_id: documentId, document_name: hit.document_name, source_hash_snapshot: hit.source_hash_snapshot,
        page: 1, page_size: 2, total_chunks: 4, chunks: [{ chunk_index: 2, content: hit.content, truncated: false }] }
    const body = oversized ? 'x'.repeat(50_001) : JSON.stringify({ code: 0, data: {
      status, ok: status === 200, ...(status === 200 ? { data } : {}),
    } })
    queueMicrotask(() => bridge.accept({ type: 'erp-tool-result', requestId: request.requestId, status, body }))
  })
  const ctx = await boot('erp-knowledge-test', path, [], (ctx) => {
    ctx.loader.builtins['discovery-system-prompt'] = SystemPrompt
    ctx.loader.builtins['discovery-tools'] = ToolRuntime
    ctx.loader.builtins.skills = SkillRegistry
    ctx.loader.builtins['education-erp-data'] = bridge.dataPlugin()
  })
  const tools = ctx.tools
  try {
    const search = tools.get('erp_knowledge_search')
    const read = tools.get('erp_knowledge_read_document')
    if (!search || !read) throw new Error('Knowledge tools not registered')
    const schemas = JSON.stringify(tools.schemas().filter(tool => tool.name.startsWith('erp_knowledge_')))
    expect(schemas).not.toContain('apiKey')
    expect(schemas).not.toContain('tenant_no')
    expect(schemas).toContain('Cite the document name and chunk index')
    const exec = { signal: new AbortController().signal, agent: { session: { id: 'knowledge-session', deriveMessages: () => [] } } } as never
    const result = await search.execute({ query: '住宿标准', document_ids: [documentId] }, exec)
    const visible = { status: 200, ok: true, method: 'POST', data: { results: [{ ...hit, citation_url: `dsh-resource://knowledge/${documentId}/${'a'.repeat(64)}/chunk-a` }],
      diagnostics: [{ applied: true, outcome: 'ok' }], recall_state: 'matched' } }
    expect(result).toEqual(visible)
    await expect(JSON.stringify(search.output?.render?.({ query: '住宿标准' }, visible), null, 2)).toMatchFileSnapshot('./fixtures/knowledge-citations.model.txt')
    expect(search.output?.render?.({ query: '住宿标准' }, visible)).toEqual([{ type: 'text', text: JSON.stringify(visible, null, 2) }])
    await read.execute({ document_id: documentId, page_size: 2 }, exec)
    expect(calls).toEqual([
      { path: '/api/knowledge/search', method: 'POST', body: { query: '住宿标准', limit: 5, document_ids: [documentId] } },
      { path: '/api/knowledge/read', method: 'POST', body: { document_id: documentId, page: 1, page_size: 2 } },
    ])
    status = 403
    await expect(read.execute({ document_id: documentId }, exec)).resolves.toMatchObject({ ok: false, status: 403, data: null })
    status = 404
    await expect(search.execute({ query: '住宿标准' }, exec)).resolves.toMatchObject({ ok: false, status: 404, data: null })
    status = 200
    oversized = true
    await expect(read.execute({ document_id: documentId }, exec)).rejects.toThrow('超过已配置的最大响应长度')
    expect(JSON.stringify(result)).not.toContain('Bearer')
  } finally {
    await ctx.fiber.dispose()
    expect(tools.get('erp_knowledge_search')).toBeUndefined()
    expect(tools.get('erp_knowledge_read_document')).toBeUndefined()
  }
})

it('requires confirmation before a knowledge update in the real Loader composition', async () => {
  const path = fileURLToPath(new URL('./fixtures/erp-discovery.cordis.yml', import.meta.url))
  const calls: object[] = []
  const bridge = new ErpDesktopTools('https://erp.example.com', (message) => {
    const request = message as { requestId: string; path: string; body: string }
    if (request.path === '/api/plugins/ai-capabilities') {
      queueMicrotask(() => bridge.accept({ type: 'erp-tool-result', requestId: request.requestId,
        status: 200, body: capabilitiesBody }))
      return
    }
    calls.push({ path: request.path, body: JSON.parse(request.body) })
    queueMicrotask(() => bridge.accept({ type: 'erp-tool-result', requestId: request.requestId, status: 409,
      body: JSON.stringify({ code: 0, data: { status: 409, ok: false, approval_required: true } }) }))
  })
  const ctx = await boot('erp-knowledge-update-test', path, [], (ctx) => {
    ctx.loader.builtins['discovery-system-prompt'] = SystemPrompt
    ctx.loader.builtins['discovery-tools'] = ToolRuntime
    ctx.loader.builtins.skills = SkillRegistry
    ctx.loader.builtins['education-erp-data'] = bridge.dataPlugin()
  })
  const tools = ctx.tools
  try {
    const update = tools.get('erp_knowledge_update_document')
    if (!update) throw new Error('Knowledge update tool not registered')
    const documentId = '01900000-0000-7000-8000-000000000001'
    await expect(update.execute({ document_id: documentId, replacements: [{ before: '原规定', after: '修订规定' }],
      source_hash_snapshot: 'a'.repeat(64) }, {
      signal: new AbortController().signal, agent: { session: { id: 'knowledge-update' } },
    } as never)).rejects.toThrow('确认界面')
    expect(calls).toEqual([{ path: '/api/harness/api', body: { method: 'PUT',
      path: `/api/knowledge/documents/${documentId}/edit`,
      body: { replacements: [{ before: '原规定', after: '修订规定' }], source_hash_snapshot: 'a'.repeat(64) },
    } }])
  } finally {
    await ctx.fiber.dispose()
    expect(tools.get('erp_knowledge_update_document')).toBeUndefined()
  }
})
