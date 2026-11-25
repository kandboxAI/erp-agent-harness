import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply, normalizeRequestBody, type Config } from '../src/index.ts'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
  })))
})

async function serverFor(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`
}

function mount(baseUrl: string, decision?: 'allowed-once' | 'rejected'): {
  api: ToolDefinition
  tools: Map<string, ToolDefinition>
  query: ToolDefinition
  discover: ToolDefinition
  bind: (sessionId: string, accessToken: string | null) => Promise<Response>
  bindRaw: (body: string) => Promise<Response>
  approvalReasons: string[]
  picker: (sessionId: string, query: string) => Promise<Response>
  citation: (body: object) => Promise<Response>
} {
  const tools = new Map<string, ToolDefinition>()
  const approvalReasons: string[] = []
  let credentialRoute: ((request: Request) => Promise<Response>) | undefined
  let pickerRoute: ((request: Request) => Promise<Response>) | undefined
  let citationRoute: ((request: Request) => Promise<Response>) | undefined
  const ctx = {
    on() { return () => {} },
    get(name: string) { return name === 'approval' && decision !== undefined ? { request: async (request: { displayReason: { en: string } }) => {
      approvalReasons.push(request.displayReason.en)
      return decision
    } } : undefined },
    effect(callback: () => () => void | Promise<void>) { callback() },
    connection: { fetch: { register(route: { path: string; fetch: (request: Request) => Promise<Response> }) {
      if (route.path === '/api/education/knowledge-bases') {
        pickerRoute = route.fetch
        return () => { pickerRoute = undefined }
      }
      if (route.path === '/api/education/knowledge-citation') {
        citationRoute = route.fetch
        return () => { citationRoute = undefined }
      }
      credentialRoute = route.fetch
      return () => { credentialRoute = undefined }
    } } },
    tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); return () => { tools.delete(tool.name) } } },
  } as unknown as Context
  const config: Config = {
    baseUrl, timeoutMs: 5_000, maxResponseChars: 10_000, writeApprovalTimeoutMs: 5_000,
    skillSources: [], skillCatalogRefreshMs: 15_000,
  }
  apply(ctx, config)
  const api = tools.get('education_erp_api')
  const query = tools.get('education_erp_query')
  const discover = tools.get('education_erp_discover')
  if (api === undefined || query === undefined || discover === undefined || credentialRoute === undefined) throw new Error('ERP tools not mounted')
  const route = credentialRoute
  return {
    api,
    tools,
    query,
    discover,
    approvalReasons,
    picker: (sessionId, query) => {
      if (pickerRoute === undefined) throw new Error('Knowledge picker not mounted')
      return pickerRoute(new Request(`http://dsh.invalid/api/education/knowledge-bases?${new URLSearchParams({ sessionId, query })}`))
    },
    bind: (sessionId, accessToken) => route(new Request('http://dsh.invalid/api/education/erp-credential', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, accessToken }),
    })),
    citation: (body) => {
      if (citationRoute === undefined) throw new Error('Citation route not mounted')
      return citationRoute(new Request('http://dsh.invalid/api/education/knowledge-citation', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }))
    },
    bindRaw: body => route(new Request('http://dsh.invalid/api/education/erp-credential', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    })),
  }
}

function execution(sessionId: string): never {
  return { signal: AbortSignal.timeout(10_000), agent: { session: { id: sessionId, deriveMessages: () => [] } } } as never
}

describe('education ERP tools', () => {
  it('limits both search entry points to the current message selection and lists only safe readable base fields', async () => {
    const selectedId = '01900000-0000-7000-8000-000000000001'
    const otherId = '01900000-0000-7000-8000-000000000002'
    const requests: Record<string, unknown>[] = []
    const baseUrl = await serverFor((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(chunk as Buffer)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        requests.push(body)
        response.setHeader('content-type', 'application/json')
        expect(request.url).toBe('/api/harness/api')
        response.end(JSON.stringify({ code: 0, data: body.path === '/api/knowledge/readable-base-options'
          ? { status: 200, ok: true, data: { bases: [{ knowledge_base_id: selectedId, knowledge_base_name: '员工制度', credential: 'hidden' }] } }
          : { status: 200, ok: true, data: { results: [], recall_state: 'empty_authorized_scope' } } }))
      })().catch(() => { response.statusCode = 500; response.end() })
    })
    const { tools, api, bind, picker } = mount(baseUrl)
    await bind('selected-session', 'alice-token')
    const response = await picker('selected-session', '员工')
    expect(await response.json()).toEqual({ bases: [{ knowledge_base_id: selectedId, knowledge_base_name: '员工制度' }] })
    expect(requests.shift()).toEqual({ method: 'POST', path: '/api/knowledge/readable-base-options', body: { query: '员工', limit: 50 } })
    const search = tools.get('erp_knowledge_search')!
    let text = `@[员工制度](knowledge-base:${selectedId}) 请查询制度`
    const exec = { signal: new AbortController().signal, agent: { session: {
      id: 'selected-session', deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }],
    } } } as never
    await search.execute({ query: '制度', knowledge_base_ids: [otherId] }, exec)
    await api.execute({ method: 'POST', path: '/api/knowledge/search', body: JSON.stringify({ query: '制度' }) }, exec)
    expect(requests.map(row => row.body)).toEqual([
      { query: '制度', limit: 5, knowledge_base_ids: [selectedId] },
      { query: '制度', knowledge_base_ids: [selectedId] },
    ])
    text = `@[参考 @[其他库\\](knowledge-base:${otherId})](knowledge-base:${selectedId}) 请查询制度`
    await search.execute({ query: '制度' }, exec)
    expect(requests.at(-1)?.body).toEqual({ query: '制度', limit: 5, knowledge_base_ids: [selectedId] })
    text = `[knowledge-base:${selectedId}] 请查询旧消息中的制度`
    await search.execute({ query: '旧制度' }, exec)
    expect(requests.at(-1)?.body).toEqual({ query: '旧制度', limit: 5, knowledge_base_ids: [selectedId] })
    text = '下一条消息不指定知识库'
    await search.execute({ query: '制度', knowledge_base_ids: [] }, exec)
    expect(requests.at(-1)?.body).toEqual({ query: '制度', limit: 5, knowledge_base_ids: [] })
    expect((await picker('unbound-session', '')).status).toBe(401)
  })
  it('selects a real knowledge base and creates only a confirmed draft with returned identifiers', async () => {
    const calls: { path: string | undefined; body: Record<string, unknown> }[] = []
    const baseId = '01900000-0000-7000-8000-000000000001'
    const created = { document_id: '01900000-0000-7000-8000-000000000002', version_id: '01900000-0000-7000-8000-000000000003', status_code: 'draft' }
    const baseUrl = await serverFor((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(chunk as Buffer)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        calls.push({ path: request.url, body })
        response.setHeader('content-type', 'application/json')
        if (body.path === '/api/knowledge/base-options') {
          response.end(JSON.stringify({ code: 0, data: { status: 200, ok: true, data: { bases: [{ knowledge_base_id: baseId, knowledge_base_name: '菜谱库' }], has_more: false, next_offset: null } } }))
        } else if (request.url === '/api/harness/write-approval') {
          response.end(JSON.stringify({ code: 0, data: { write_approval: 'create-grant' } }))
        } else if (body.write_approval === 'create-grant') {
          response.end(JSON.stringify({ code: 0, data: { status: 200, ok: true, data: created } }))
        } else {
          response.statusCode = 409
          response.end(JSON.stringify({ code: 0, data: { status: 409, ok: false, approval_required: true } }))
        }
      })().catch(() => { response.statusCode = 500; response.end() })
    })
    const { tools, bind, approvalReasons } = mount(baseUrl, 'allowed-once')
    await bind('create-session', 'alice-token')
    await expect(tools.get('erp_knowledge_list_bases')!.execute({ query: '菜谱' }, execution('create-session'))).resolves.toMatchObject({ data: { bases: [{ knowledge_base_id: baseId }] } })
    const result = await tools.get('erp_knowledge_create_document')!.execute({ knowledge_base_id: baseId, document_name: '番茄炒蛋制作菜谱', content: '# 食材与做法' }, execution('create-session'))
    expect(result).toEqual({ status: 200, ok: true, method: 'POST', data: created })
    expect(approvalReasons).toEqual(['Create a knowledge document draft?\nTitle: 番茄炒蛋制作菜谱\nDraft text:\n# 食材与做法'])
    expect(calls.map(row => row.path)).toEqual(['/api/harness/api', '/api/harness/api', '/api/harness/write-approval', '/api/harness/api'])
    expect(calls[3]?.body.path).toBe(`/api/knowledge/bases/${baseId}/documents/manual`)
    expect(calls[3]?.body.body).toEqual({ document_name: '番茄炒蛋制作菜谱', content: '# 食材与做法' })
    expect(JSON.stringify(result)).not.toContain('create-grant')
  })

  it.each(['plugin_not_enabled', 'route_not_found', 'write_result_unconfirmed'])('preserves a safe actionable failure without exposing server text: %s', async (reason) => {
    const status = reason === 'write_result_unconfirmed' ? 502 : 404
    const baseUrl = await serverFor((_request, response) => {
      response.statusCode = status
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ code: 0, data: { status, ok: false, error_code: reason, message: 'private-server-text' } }))
    })
    const { tools, bind } = mount(baseUrl)
    await bind('failure-session', 'alice-token')
    const reply = await tools.get('erp_knowledge_list_bases')!.execute({}, execution('failure-session'))
    expect(reply).toMatchObject({ status, ok: false, error_code: reason })
    expect(JSON.stringify(reply)).not.toContain('private-server-text')
  })

  it('does not diagnose an absent knowledge module from an invalid 404 envelope', async () => {
    const baseUrl = await serverFor((_request, response) => { response.statusCode = 404; response.end('private-proxy-error') })
    const { tools, bind } = mount(baseUrl)
    await bind('missing-entry', 'alice-token')
    await expect(tools.get('erp_knowledge_list_bases')!.execute({}, execution('missing-entry'))).rejects.toThrow('不能证明模块未部署')
  })

  it('saves confirmed fragment edits without replacing the complete document or exposing the grant', async () => {
    const seen: { path: string | undefined; body: Record<string, unknown> }[] = []
    const baseUrl = await serverFor((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(chunk as Buffer)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        seen.push({ path: request.url, body })
        response.setHeader('content-type', 'application/json')
        if (request.url === '/api/harness/write-approval') {
          response.end(JSON.stringify({ code: 0, data: { write_approval: 'fragment-edit-grant' } }))
        } else if (body.write_approval === 'fragment-edit-grant') {
          response.end(JSON.stringify({ code: 0, data: { status: 200, ok: true } }))
        } else {
          response.statusCode = 409
          response.end(JSON.stringify({ code: 0, data: { status: 409, ok: false, approval_required: true } }))
        }
      })().catch(() => { response.statusCode = 500; response.end() })
    })
    const { tools, bind, approvalReasons } = mount(baseUrl, 'allowed-once')
    await bind('session-fragments', 'alice-token')
    const update = tools.get('erp_knowledge_update_document')!
    const args = { document_id: 'doc-1', source_hash_snapshot: 'a'.repeat(64),
      replacements: [{ before: '  原规定\n', after: '  新规定\n' }], change_reason: '调整规定' }
    const result = await update.execute(args, execution('session-fragments'))
    expect(approvalReasons).toEqual([
      'Save changes to the knowledge document as a draft?\nOriginal:   原规定\n\nNew text:   新规定\n\nReason: 调整规定',
    ])
    expect(seen.map(row => row.path)).toEqual(['/api/harness/api', '/api/harness/write-approval', '/api/harness/api'])
    const body = { source_hash_snapshot: args.source_hash_snapshot, replacements: args.replacements, change_reason: args.change_reason }
    expect(seen.map(row => row.body.body)).toEqual([body, body, body])
    expect(result).toEqual({ status: 200, ok: true, method: 'PUT', data: null })
    expect(JSON.stringify(result)).not.toContain('fragment-edit-grant')
    await expect(update.execute({ ...args, content: '整篇内容' }, execution('session-fragments'))).rejects.toThrow('不能同时提交')
    await expect(update.execute({ document_id: 'doc-1', source_hash_snapshot: args.source_hash_snapshot }, execution('session-fragments'))).rejects.toThrow('请提供')
    expect(seen).toHaveLength(3)
  })

  it('reads version metadata and submits only the confirmed ERP draft', async () => {
    const seen: { path: string | undefined; body: Record<string, unknown> }[] = []
    const baseUrl = await serverFor((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(chunk as Buffer)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        seen.push({ path: request.url, body })
        response.setHeader('content-type', 'application/json')
        if (body.path === '/api/knowledge/version-status') {
          response.end(JSON.stringify({ code: 0, data: { status: 200, ok: true, data: { document_id: 'doc-1', versions: [] } } }))
        } else if (request.url === '/api/harness/write-approval') {
          response.end(JSON.stringify({ code: 0, data: { write_approval: 'bound-grant' } }))
        } else if (body.write_approval === 'bound-grant') {
          response.end(JSON.stringify({ code: 0, data: { status: 200, ok: true } }))
        } else {
          response.statusCode = 409
          response.end(JSON.stringify({ code: 0, data: { status: 409, ok: false, approval_required: true } }))
        }
      })().catch(() => { response.statusCode = 500; response.end() })
    })
    const { api, tools, bind, approvalReasons } = mount(baseUrl, 'allowed-once')
    await bind('session-review', 'alice-token')
    const status = tools.get('erp_knowledge_version_status')!
    const submit = tools.get('erp_knowledge_submit_version')!
    await expect(status.execute({ document_id: 'doc-1' }, execution('session-review'))).resolves.toMatchObject({ data: { document_id: 'doc-1' } })
    await expect(submit.execute({ version_id: 'version-2', content_hash_snapshot: 'a'.repeat(64) }, execution('session-review'))).resolves.toMatchObject({ ok: true, data: null })
    expect(approvalReasons).toEqual([
      'Submit this knowledge document draft for review?\nA reviewer will check it in ERP before it can be published.',
    ])
    expect(seen.map(row => row.body.path)).toEqual(['/api/knowledge/version-status', '/api/knowledge/versions/version-2/submit', '/api/knowledge/versions/version-2/submit', '/api/knowledge/versions/version-2/submit'])
    expect(seen.filter(row => row.path === '/api/harness/write-approval')).toHaveLength(1)
    expect(seen[3]?.body.body).toEqual({ content_hash_snapshot: 'a'.repeat(64) })
    await expect(api.execute({
      method: 'POST', path: '/api/knowledge/versions/version-2/submit',
      body: { content_hash_snapshot: 'a'.repeat(64) },
    }, execution('session-review'))).resolves.toMatchObject({ ok: true })
    expect(approvalReasons[1]).toBe(approvalReasons[0])
  })

  it.each(['allowed-once', 'rejected', undefined] as const)('requires a human grant before retrying a write: %s', async (decision) => {
    const calls: { path: string | undefined; body: Record<string, unknown> }[] = []
    const baseUrl = await serverFor((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(chunk as Buffer)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        calls.push({ path: request.url, body })
        response.setHeader('content-type', 'application/json')
        if (request.url === '/api/harness/write-approval') {
          response.end(JSON.stringify({ code: 0, data: { write_approval: 'private-one-use-grant' } }))
        } else if (body.write_approval === 'private-one-use-grant') {
          response.end(JSON.stringify({ code: 0, data: { status: 200, ok: true } }))
        } else {
          response.statusCode = 409
          response.end(JSON.stringify({ code: 0, data: { status: 409, ok: false, approval_required: true } }))
        }
      })().catch(() => { response.statusCode = 500; response.end() })
    })
    const { api, bind, approvalReasons } = mount(baseUrl, decision)
    await bind('session-write', 'alice-token')
    const args = { method: 'POST' as const, path: '/api/business/change?source=portal', query: { year: 2026 }, body: { enabled: true } }
    if (decision === 'allowed-once') {
      const result = await api.execute(args, execution('session-write'))
      expect(result).toEqual({ ok: true, status: 200, method: 'POST', data: null })
      expect(JSON.stringify(result)).not.toContain('private-one-use-grant')
      expect(calls.map(call => call.path)).toEqual(['/api/harness/api', '/api/harness/write-approval', '/api/harness/api'])
      expect(calls[0]?.body).toEqual({ method: 'POST', path: '/api/business/change?source=portal&year=2026', body: { enabled: true } })
      expect(approvalReasons[0]).toContain('POST /api/business/change?source=portal&year=2026')
      expect(approvalReasons[0]).toContain('"enabled": true')
      expect(calls[1]?.body).toEqual(calls[0]?.body)
      expect(calls[2]?.body).toEqual({ ...calls[0]?.body, write_approval: 'private-one-use-grant' })
    } else {
      await expect(api.execute(args, execution('session-write'))).rejects.toThrow(decision === undefined ? '确认界面' : '未获确认')
      expect(calls).toHaveLength(1)
    }
  })

  it('discovers resources using the bound user and preserves the directory revision', async () => {
    let requestedPath: string | undefined
    let authorization: string | undefined
    const baseUrl = await serverFor((request, response) => {
      requestedPath = request.url
      authorization = request.headers.authorization
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ code: 0, data: { discovery_contract_version: 1, catalog_revision: 'sha256:test', candidates: [] } }))
    })
    const { discover, bind } = mount(baseUrl)
    await bind('session-a', 'alice-token')
    await expect(discover.execute({ action: 'search', question: '教师学历结构' }, execution('session-a')))
      .resolves.toMatchObject({ data: { catalog_revision: 'sha256:test' } })
    expect(requestedPath).toBe('/api/harness/discovery')
    expect(authorization).toBe('Bearer alice-token')
  })

  it('requests rediscovery for a stale catalog without returning backend error text', async () => {
    const baseUrl = await serverFor((_request, response) => {
      response.statusCode = 409
      response.end('private backend error')
    })
    const { discover, bind } = mount(baseUrl)
    await bind('session-a', 'alice-token')
    await expect(discover.execute({ action: 'describe', ids: ['resource:test'], catalog_revision: 'old' }, execution('session-a')))
      .rejects.toThrow('重新 search')
  })

  it('rejects a discovery response without the supported contract', async () => {
    const baseUrl = await serverFor((_request, response) => response.end('{"code":0,"data":{"resources":[]}}'))
    const { discover, bind } = mount(baseUrl)
    await bind('session-a', 'alice-token')
    await expect(discover.execute({ action: 'domains' }, execution('session-a'))).rejects.toThrow('兼容的资源发现接口')
  })

  it('normalizes JSON text bodies without changing ordinary strings', () => {
    expect(normalizeRequestBody('{"name":"测试角色"}')).toEqual({ name: '测试角色' })
    expect(normalizeRequestBody('[1,2,3]')).toEqual([1, 2, 3])
    expect(normalizeRequestBody('plain text')).toBe('plain text')
    expect(normalizeRequestBody('{not valid json}')).toBe('{not valid json}')
  })

  it('calls only the backend facade and accepts its projected read result', async () => {
    let requestedPath: string | undefined
    let requestedBody: unknown
    const baseUrl = await serverFor((request, response) => {
      requestedPath = request.url
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(chunk as Buffer)
        requestedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
      })().then(() => {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ code: 0, data: { status: 200, ok: true,
          data: { list: [{ id: 'teacher-1', student_count: 30 }] } } }))
      })
    })
    const { api, bind } = mount(baseUrl)
    await bind('session-a', 'alice-token')
    await expect(api.execute({ method: 'POST', path: '/api/education/list', body: { entity: 'studentGroup' } }, execution('session-a')))
      .resolves.toMatchObject({ data: { list: [{ id: 'teacher-1', student_count: 30 }] } })
    expect(requestedPath).toBe('/api/harness/api')
    expect(requestedBody).toEqual({ method: 'POST', path: '/api/education/list', body: { entity: 'studentGroup' } })
  })

  it('fails closed when the backend does not expose the safe facade', async () => {
    const baseUrl = await serverFor((_request, response) => {
      response.end(JSON.stringify({ code: 0, data: { rows: [{ instructor_name: '张三' }] } }))
    })
    const { api, bind } = mount(baseUrl)
    await bind('session-a', 'alice-token')
    await expect(api.execute({ method: 'GET', path: '/api/auth/me' }, execution('session-a')))
      .rejects.toThrow('ERP 安全接口')
  })

  it('uses the iframe user bound to each Session and no shared ERP account', async () => {
    const seen: string[] = []
    const baseUrl = await serverFor((request, response) => {
      seen.push(request.headers.authorization ?? '')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ code: 0, data: { status: 200, ok: true, data: { ok: true } } }))
    })
    const { api, bind } = mount(baseUrl)
    await expect(api.execute({ method: 'GET', path: '/api/auth/me' }, execution('session-a')))
      .rejects.toThrow('请先在嵌入的教育系统登录')
    expect((await bind('session-a', 'alice-token')).status).toBe(204)
    expect((await bind('session-b', 'bob-token')).status).toBe(204)
    await api.execute({ method: 'GET', path: '/api/auth/me' }, execution('session-a'))
    await api.execute({ method: 'GET', path: '/api/auth/me' }, execution('session-b'))
    expect(seen).toEqual(['Bearer alice-token', 'Bearer bob-token'])
    expect((await bind('session-a', null)).status).toBe(204)
    await expect(api.execute({ method: 'GET', path: '/api/auth/me' }, execution('session-a')))
      .rejects.toThrow('请先在嵌入的教育系统登录')
  })

  it('sends read-only queries with only the bound ERP bearer', async () => {
    let received: { authorization: string | undefined; key: string | undefined; body: unknown; path: string | undefined } = {
      authorization: undefined, key: undefined, body: undefined, path: undefined,
    }
    const baseUrl = await serverFor((request, response) => {
      void (async () => {
        const chunks: Uint8Array[] = []
        for await (const chunk of request) {
          if (!(chunk instanceof Buffer)) throw new TypeError('Expected a Buffer request chunk')
          chunks.push(chunk)
        }
        received = {
          path: request.url,
          authorization: request.headers.authorization,
          key: request.headers['x-harness-query-key'] as string | undefined,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
        }
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ code: 0, data: { policy_version: 1, rows: [{ id: 'row-1' }] } }))
      })().catch((error: unknown) => {
        response.statusCode = 500
        response.end(error instanceof Error ? error.message : String(error))
      })
    })
    const { query, bind } = mount(baseUrl)
    await bind('session-a', 'alice-token')
    const result = await query.execute({ operation: 'query', resource: 'education.studentGroup', fields: ['id'] }, execution('session-a'))
    expect(result).toEqual({ code: 0, data: { policy_version: 1, rows: [{ id: 'row-1' }] } })
    expect(received).toEqual({
      path: '/api/harness/query', authorization: 'Bearer alice-token', key: undefined,
      body: { operation: 'query', resource: 'education.studentGroup', fields: ['id'] },
    })
  })

  it('rejects an older query endpoint without the server policy marker', async () => {
    const baseUrl = await serverFor((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ code: 0, data: { rows: [{ phone: '13800138000' }] } }))
    })
    const { query, bind } = mount(baseUrl)
    await bind('session-a', 'alice-token')
    await expect(query.execute({ operation: 'query', resource: 'education.instructor' }, execution('session-a')))
      .rejects.toThrow('受控查询策略')
  })

  it('rejects ERP paths outside the configured origin and malformed bindings', async () => {
    const { api, bind, bindRaw } = mount('http://127.0.0.1:8000/')
    await expect(api.execute({ method: 'GET', path: '/private' }, execution('session-a')))
      .rejects.toThrow('只允许调用')
    expect((await bind('session\nother', 'token')).status).toBe(400)
    expect((await bind('session-a', 'bad\ntoken')).status).toBe(400)
    expect((await bindRaw('{invalid')).status).toBe(400)
  })

  it('does not remove a renewed credential after an older request gets 401', async () => {
    let rejectOld: (() => void) | undefined
    let oldRequest: (() => void) | undefined
    const started = new Promise<void>((resolve) => { oldRequest = resolve })
    const blocked = new Promise<void>((resolve) => { rejectOld = resolve })
    const baseUrl = await serverFor((request, response) => {
      if (request.headers.authorization === 'Bearer old-token') {
        oldRequest?.()
        void blocked.then(() => { response.writeHead(401); response.end() })
        return
      }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ code: 0, data: { status: 200, ok: true } }))
    })
    const { api, bind } = mount(baseUrl)
    await bind('session-a', 'old-token')
    const first = api.execute({ method: 'GET', path: '/api/auth/me' }, execution('session-a'))
    await started
    await bind('session-a', 'new-token')
    rejectOld?.()
    await expect(first).rejects.toThrow('ERP 登录已失效')
    await expect(api.execute({ method: 'GET', path: '/api/auth/me' }, execution('session-a')))
      .resolves.toMatchObject({ ok: true, status: 200 })
  })
})

it('rechecks a source through the same ERP identity and preserves changed/revoked failures', async () => {
  const documentId = '01900000-0000-7000-8000-000000000001'
  let status = 200
  const seen: object[] = []
  const baseUrl = await serverFor((request, response) => {
    void (async () => {
      const parts: Buffer[] = []
      for await (const part of request) parts.push(part as Buffer)
      seen.push(JSON.parse(Buffer.concat(parts).toString('utf8')) as object)
      expect(request.headers.authorization).toBe('Bearer reader-token')
      response.statusCode = status
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ code: 0, data: { status, ok: status === 200, data: {
        document_id: documentId, source_hash_snapshot: 'a'.repeat(64), document_name: '规定',
        page: 1, page_size: 1, total_chunks: 1, chunks: [{ chunk_no: 'chunk-a', chunk_index: 12, content: '原文', truncated: false }],
      } } }))
    })().catch(() => { response.statusCode = 500; response.end() })
  })
  const { citation, bind } = mount(baseUrl)
  const source = { sessionId: 'source-session', document_id: documentId, source_hash_snapshot: 'a'.repeat(64), chunk_no: 'chunk-a' }
  expect((await citation(source)).status).toBe(401)
  expect(seen).toEqual([])
  await bind('source-session', 'reader-token')
  expect(await (await citation(source)).json()).toMatchObject({ document_id: documentId, chunks: [{ content: '原文' }] })
  expect(seen[0]).toEqual({ method: 'POST', path: '/api/knowledge/read', body: {
    document_id: documentId, source_hash_snapshot: 'a'.repeat(64), chunk_no: 'chunk-a',
  } })
  status = 409
  expect((await citation(source)).status).toBe(409)
  status = 403
  expect((await citation(source)).status).toBe(403)
  expect((await citation({ ...source, chunk_no: '../other' })).status).toBe(400)
  expect(seen).toHaveLength(3)
})


it('uses server-enforced automatic position memory writes without requesting user approval', async () => {
  const requests: object[] = []
  const baseUrl = await serverFor((request, response) => {
    void (async () => {
      let raw = ''
      for await (const chunk of request) raw += String(chunk)
      const body = JSON.parse(raw) as { path: string }
      requests.push(body)
      expect(request.url).toBe('/api/harness/api')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ code: 0, data: { status: 200, ok: true, data:
        body.path.endsWith('/read') ? { document_id: null, can_update: true, content: '' }
          : { document_id: 'memory-doc', status_code: 'approved', publish_status_code: 'queued' },
      } }))
    })().catch(() => { response.statusCode = 500; response.end() })
  })
  const h = mount(baseUrl, 'rejected')
  await h.bind('memory-session', 'memory-token')
  const exec = { signal: new AbortController().signal, agent: { session: { id: 'memory-session' } } } as never
  await h.tools.get('erp_position_memory_read')!.execute({ position_id: 'current-position' }, exec)
  const result = await h.tools.get('erp_position_memory_update')!.execute({ position_id: 'current-position', content: '# 岗位工作' }, exec)
  expect(result).toMatchObject({ ok: true, data: { publish_status_code: 'queued' } })
  expect(h.approvalReasons).toEqual([])
  expect(requests).toEqual([
    { method: 'POST', path: '/api/knowledge/position-memory/read', body: { position_id: 'current-position' } },
    { method: 'POST', path: '/api/knowledge/position-memory/update', body: { position_id: 'current-position', content: '# 岗位工作' } },
  ])
})
