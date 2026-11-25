import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { SkillCandidate, SkillDefinition, SkillLookupOptions, SkillProvider } from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider, type Config as FileSystemSkillConfig } from '@deepseek-ai/dsh-skill-filesystem'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { registerKnowledgeFiles } from './knowledge-files.ts'
import { withKnowledgeCitations } from './knowledge-citations.ts'

export const name = 'tool-erp'
export const inject = ['tools', 'connection', 'skills']

/** ERP endpoint and bounds shared by web and desktop tool registrations. */
export interface Config {
  /** HTTP(S) origin of the ERP backend. */
  baseUrl: string
  /** Maximum duration of one ERP HTTP request in milliseconds. */
  timeoutMs: number
  /** Maximum characters returned to the model from an ERP response. */
  maxResponseChars: number
  /** Time allowed for the user to review an ERP write. */
  writeApprovalTimeoutMs: number
  /** Skill roots owned by ERP capability packages; each package is gated by tenant activation. */
  skillSources: SkillSourceConfig[]
  /** Maximum delay before a tenant skill catalog is refreshed after an ERP-side activation change. */
  skillCatalogRefreshMs: number
  /** Enable associated Markdown file contributions when filesystem, questions and domain storage are mounted. */
  knowledgeFiles?: boolean
}

/** Filesystem roots owned by one ERP capability package. */
export interface SkillSourceConfig {
  /** ERP plugin key controlling tenant activation. */
  pluginKey: string
  /** Bundled skill root, when supplied by the composition. */
  bundledSkillDir?: string
  /** Customer skill roots, in lookup priority order. */
  customSkillDirs: string[]
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().default('http://127.0.0.1:8000/'),
  timeoutMs: z.number().default(30_000),
  maxResponseChars: z.number().default(50_000),
  writeApprovalTimeoutMs: z.number().default(300_000),
  skillSources: z.array(z.object({
    pluginKey: z.string().min(1),
    bundledSkillDir: z.string(),
    customSkillDirs: z.array(z.string()).default([]),
  })).default([]),
  skillCatalogRefreshMs: z.number().default(15_000),
  knowledgeFiles: z.boolean().default(false),
})

type JsonPrimitive = string | number | boolean | null
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

const CREDENTIAL_PATH = '/api/erp/credential'
const CREDENTIAL_LEASE_MS = 5 * 60_000
const PLUGIN_SKILLS_PATH = '/api/plugins/skills'
interface BoundCredential { accessToken: string; expiresAt: number }

function sessionIdFromLookup(options: SkillLookupOptions): string | undefined {
  const sessionId = options.sessionId
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function knowledgeWriteSummary(method: string, path: string, body: JsonValue | undefined) {
  if (!path.startsWith('/api/knowledge/')) return undefined
  if (method === 'POST' && /^\/api\/knowledge\/versions\/[^/]+\/submit\/?$/.test(path)) {
    return {
      en: 'Submit this knowledge document draft for review?\nA reviewer will check it in ERP before it can be published.',
      zh: '提交这份知识文档草稿审核？\n提交后由审核人员在 ERP 中审核，通过后才会发布。',
    }
  }
  const creation = method === 'POST' && /^\/api\/knowledge\/bases\/[^/]+\/documents\/manual\/?$/.test(path)
  const edit = method === 'PUT' && /^\/api\/knowledge\/documents\/[^/]+\/edit\/?$/.test(path)
  if (method === 'POST' && /^\/api\/knowledge\/bases\/[^/]+\/documents\/upload\/?$/.test(path)
    && isRecord(body) && typeof body.file_name === 'string') {
    return { en: `Upload “${body.file_name}” as a knowledge document draft?`, zh: `将“${body.file_name}”上传为知识文档草稿？` }
  }
  if ((!creation && !edit) || !isRecord(body)) throw new Error('这项知识库操作请在 ERP 知识库页面核对并办理。')

  const en = [creation ? 'Create a knowledge document draft?' : 'Save changes to the knowledge document as a draft?']
  const zh = [creation ? '新建知识文档草稿？' : '将知识文档的修改保存为草稿？']
  if (typeof body.document_name === 'string') {
    en.push(`${creation ? 'Title' : 'New title'}: ${body.document_name}`)
    zh.push(`${creation ? '文档标题' : '新标题'}：${body.document_name}`)
  }
  if (typeof body.content === 'string') {
    en.push(`${creation ? 'Draft text' : 'Replace the entire document with'}:\n${body.content}`)
    zh.push(`${creation ? '草稿正文' : '将全文替换为'}：\n${body.content}`)
  }
  if (edit && Array.isArray(body.replacements)) {
    for (const item of body.replacements) {
      if (!isRecord(item) || typeof item.before !== 'string' || typeof item.after !== 'string') {
        throw new Error('请提供要替换的原文和改后的内容。')
      }
      en.push(`Original: ${item.before}\nNew text: ${item.after === '' ? '(delete this passage)' : item.after}`)
      zh.push(`原文：${item.before}\n改为：${item.after === '' ? '（删除这段文字）' : item.after}`)
    }
  }
  if (typeof body.change_reason === 'string' && body.change_reason) {
    en.push(`Reason: ${body.change_reason}`)
    zh.push(`修改原因：${body.change_reason}`)
  }
  return { en: en.join('\n'), zh: zh.join('\n') }
}

function ensureAllowedUrl(baseUrl: URL, path: string): URL {
  if (!path.startsWith('/')) throw new Error('path 必须以 / 开头')
  const url = new URL(path, baseUrl)
  if (url.origin !== baseUrl.origin) throw new Error('只允许调用已配置的ERP API origin')
  const allowed = url.pathname.startsWith('/api/')
  if (!allowed) throw new Error('只允许调用 /api/ 下的接口')
  return url
}

function appendQuery(url: URL, query: Record<string, JsonValue> | undefined): void {
  if (!query) return
  for (const [key, value] of Object.entries(query)) {
    if (value === null) continue
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, item !== null && typeof item === 'object' ? JSON.stringify(item) : String(item))
      }
    } else if (typeof value !== 'object') {
      url.searchParams.set(key, String(value))
    } else {
      url.searchParams.set(key, JSON.stringify(value))
    }
  }
}

/**
 * Recover structured JSON when the tool transport delivers a JSON object or
 * array as text. Plain string bodies remain strings.
 * @param body - Model-supplied ERP body.
 * @returns Parsed object or array, or the original value when it is not JSON.
 */
export function normalizeRequestBody(body: JsonValue): JsonValue {
  if (typeof body !== 'string') return body
  const trimmed = body.trim()
  if (!(trimmed.startsWith('{') && trimmed.endsWith('}'))
    && !(trimmed.startsWith('[') && trimmed.endsWith(']'))) return body
  try {
    return JSON.parse(trimmed) as JsonValue
  } catch {
    return body
  }
}

async function readResponse(response: Response, maxChars: number): Promise<{ data: JsonValue; truncated: boolean }> {
  const raw = await response.text()
  const truncated = raw.length > maxChars
  const visible = truncated ? raw.slice(0, maxChars) : raw
  try {
    return { data: JSON.parse(visible) as JsonValue, truncated }
  } catch {
    return { data: visible, truncated }
  }
}

function apiFailure(status: number, reason: JsonValue | undefined): { error_code: string; message: string } {
  if (reason === 'plugin_not_enabled') return { error_code: reason,
    message: '当前请求对应的功能未向这个 ERP 租户会话开通。请检查能力包的启用、升级或失败状态；这不代表服务端没有部署知识模块。' }
  if (reason === 'route_not_found') return { error_code: reason,
    message: '当前 ERP 服务未注册该请求的方法和路径。请检查服务版本和地址，并使用已提供的知识工具；不要猜测 health 或管理接口，也不能据此断言整个知识库未部署。' }
  if (reason === 'write_result_unconfirmed') return { error_code: reason,
    message: '新建结果未确认，可能已保存草稿。请到 ERP 核对，不能自动重复创建；本地文件不代表已入库。' }
  if (status === 404) return { error_code: 'erp_request_unavailable',
    message: 'ERP 请求返回 HTTP 404，尚不能确认安全入口或目标功能是否可用。请核对 ERP 地址、服务版本、当前租户开通状态及账号权限；菜单或资源检索为空也不能证明模块未部署。' }
  if (status === 403) return { error_code: 'erp_access_denied',
    message: '当前 ERP 操作未获授权，或接口未向模型开放。请核对账号权限并使用受控知识工具，不能据此断言知识库未部署。' }
  if (status === 409) return { error_code: 'erp_state_conflict',
    message: 'ERP 操作条件或版本已变化，请检查功能升级状态或刷新文档版本；新建结果不明确时不要自动重复创建。' }
  return { error_code: 'erp_request_failed', message: `ERP 请求失败（HTTP ${status}），未确认业务成功。` }
}

function selectedKnowledgeBases(exec: Pick<ToolRunContext, 'agent'>): string[] {
  const messages = exec.agent?.session.deriveMessages() ?? []
  const message = messages.findLast(row => row.role === 'user' && row.source.kind === 'user')
  if (message === undefined) return []
  const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  const ids = [...text.matchAll(/(?:\[knowledge-base:([0-9a-f-]{36})\]|@\[(?:\\[\\\]]|[^\]\\\n])+\]\(knowledge-base:([0-9a-f-]{36})\))/g)]
    .map(match => match[1] ?? match[2]).filter(id => id !== undefined)
  return [...new Set(ids)]
}

/** Electron-owned channel that supplies ERP authentication without model-visible credentials. */
export interface DesktopErpBridge {
  request(url: URL, init: RequestInit, signal: AbortSignal): Promise<Response>
}

/**
 * Register ERP tools with an Electron-owned authenticated request channel.
 * @param ctx - Plugin context owning registration and disposal.
 * @param config - ERP endpoint and response bounds.
 * @param bridge - Main-process request channel honoring cancellation.
 */
export function registerDesktopErp(ctx: Context, config: Config, bridge: DesktopErpBridge): void {
  registerTools(ctx, config, bridge)
}

export function apply(ctx: Context, config: Config): void {
  registerTools(ctx, config)
}

function registerTools(ctx: Context, config: Config, desktopBridge?: DesktopErpBridge): void {
  const baseUrl = new URL(config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`)
  if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error('ERP baseUrl 必须使用 http 或 https')
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 1_000) throw new Error('timeoutMs 必须至少为 1000')
  if (!Number.isFinite(config.writeApprovalTimeoutMs) || config.writeApprovalTimeoutMs < 1_000) throw new Error('writeApprovalTimeoutMs 必须至少为 1000')
  if (!Number.isSafeInteger(config.maxResponseChars) || config.maxResponseChars < 1_000) {
    throw new Error('maxResponseChars 必须是至少 1000 的整数')
  }
  if (!Number.isSafeInteger(config.skillCatalogRefreshMs) || config.skillCatalogRefreshMs < 1_000) {
    throw new Error('skillCatalogRefreshMs 必须是至少 1000 的整数')
  }
  const skillSourceKeys = new Set<string>()
  for (const source of config.skillSources) {
    if (skillSourceKeys.has(source.pluginKey)) throw new Error(`ERP 技能来源重复：${source.pluginKey}`)
    skillSourceKeys.add(source.pluginKey)
  }

  const credentials = new Map<string, BoundCredential>()
  const invalidateSkillCatalogs = new Set<() => void>()

  if (desktopBridge === undefined) ctx.effect(() => ctx.connection.fetch.register({
    path: CREDENTIAL_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      let value: unknown
      try {
        value = await request.json() as unknown
      } catch {
        return new Response(null, { status: 400 })
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return new Response(null, { status: 400 })
      }
      const row = value as Record<string, unknown>
      if (typeof row.sessionId !== 'string' || row.sessionId.length < 1 || row.sessionId.length > 256
        || /[\u0000-\u001f\u007f]/.test(row.sessionId)) return new Response(null, { status: 400 })
      if (row.accessToken === null) {
        credentials.delete(row.sessionId)
        for (const invalidate of invalidateSkillCatalogs) invalidate()
        return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
      }
      if (typeof row.accessToken !== 'string' || row.accessToken.length < 1 || row.accessToken.length > 8192
        || /[\r\n]/.test(row.accessToken)) return new Response(null, { status: 400 })
      credentials.set(row.sessionId, { accessToken: row.accessToken, expiresAt: Date.now() + CREDENTIAL_LEASE_MS })
      for (const invalidate of invalidateSkillCatalogs) invalidate()
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
    },
  }), 'tool-erp: browser credential binding')

  const fetchApi = async (url: URL, init: RequestInit, signal: AbortSignal): Promise<Response> => {
    if (desktopBridge !== undefined) return desktopBridge.request(url, init, signal)
    const timeout = AbortSignal.timeout(config.timeoutMs)
    return fetch(url, { ...init, signal: AbortSignal.any([signal, timeout]) })
  }

  const token = (sessionId: string | undefined): string => {
    if (sessionId === undefined) throw new Error('ERP 工具需要关联当前 Harness 会话')
    if (desktopBridge !== undefined) return ''
    const bound = credentials.get(sessionId)
    if (bound === undefined || bound.expiresAt <= Date.now()) {
      credentials.delete(sessionId)
      throw new Error('请先在嵌入的 ERP 系统登录并绑定当前 DSH 会话，再发起 ERP 操作')
    }
    return bound.accessToken
  }

  const connection = desktopBridge === undefined ? ctx.connection : ctx.get('connection')
  if (connection !== undefined) {
    ctx.effect(() => connection.fetch.register({
      path: '/api/erp/knowledge-bases', methods: ['GET'], requestBody: 'buffered',
      async fetch(request) {
        const url = new URL(request.url)
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const query = url.searchParams.get('query') ?? ''
        if (sessionId.length < 1 || sessionId.length > 256 || query.length > 256) return new Response(null, { status: 400 })
        let accessToken: string
        try {
          accessToken = token(sessionId)
        } catch (_error) {
          return new Response(null, { status: 401 })
        }
        try {
          const response = await fetchApi(new URL('/api/harness/api', baseUrl), {
            method: 'POST', redirect: 'error',
            headers: { 'content-type': 'application/json',
              ...desktopBridge === undefined ? { authorization: `Bearer ${accessToken}` } : {} },
            body: JSON.stringify({ method: 'POST', path: '/api/knowledge/readable-base-options', body: { query, limit: 50 } }),
          }, request.signal)
          const result = await readResponse(response, config.maxResponseChars)
          if (!response.ok || result.truncated || !isRecord(result.data) || result.data.code !== 0
            || !isRecord(result.data.data) || result.data.data.ok !== true
            || !isRecord(result.data.data.data) || !Array.isArray(result.data.data.data.bases)) {
            return new Response(null, { status: response.ok ? 502 : response.status })
          }
          const bases = result.data.data.data.bases.map((row) => {
            if (!isRecord(row) || typeof row.knowledge_base_id !== 'string' || typeof row.knowledge_base_name !== 'string') {
              throw new Error('Invalid knowledge base option')
            }
            return { knowledge_base_id: row.knowledge_base_id, knowledge_base_name: row.knowledge_base_name }
          })
          return Response.json({ bases }, { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
          if (request.signal.aborted) throw error
          return new Response(null, { status: 502 })
        }
      },
    }), 'tool-erp: knowledge base picker')
    ctx.effect(() => connection.fetch.register({
      path: '/api/erp/knowledge-citation', methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        let input: unknown
        try { input = await request.json() } catch (_error) { return new Response(null, { status: 400 }) }
        if (!isRecord(input) || typeof input.sessionId !== 'string' || input.sessionId.length < 1 || input.sessionId.length > 256
          || typeof input.document_id !== 'string' || !/^[0-9a-f-]{36}$/.test(input.document_id)
          || typeof input.source_hash_snapshot !== 'string' || !/^[0-9a-f]{64}$/.test(input.source_hash_snapshot)
          || (input.chunk_no !== undefined && (typeof input.chunk_no !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.chunk_no)))
          || (input.page !== undefined && (!Number.isInteger(input.page) || Number(input.page) < 1 || Number(input.page) > 10000))) {
          return new Response(null, { status: 400 })
        }
        let accessToken: string
        try { accessToken = token(input.sessionId) } catch (_error) { return new Response(null, { status: 401 }) }
        try {
          // 每次打开都回到 ERP 复核当前权限和来源，不用聊天记录中的片段充当原文。
          const response = await fetchApi(new URL('/api/harness/api', baseUrl), {
            method: 'POST', redirect: 'error',
            headers: { 'content-type': 'application/json',
              ...desktopBridge === undefined ? { authorization: `Bearer ${accessToken}` } : {} },
            body: JSON.stringify({ method: 'POST', path: '/api/knowledge/read', body: {
              document_id: input.document_id, source_hash_snapshot: input.source_hash_snapshot,
              ...input.chunk_no === undefined ? { page: input.page ?? 1, page_size: 10 } : { chunk_no: input.chunk_no },
            } }),
          }, request.signal)
          const result = await readResponse(response, config.maxResponseChars)
          if (!response.ok) return new Response(null, { status: response.status, headers: { 'cache-control': 'no-store' } })
          if (result.truncated || !isRecord(result.data) || result.data.code !== 0 || !isRecord(result.data.data)
            || result.data.data.ok !== true || result.data.data.status !== 200 || !isRecord(result.data.data.data)) {
            return new Response(null, { status: 502 })
          }
          const content = result.data.data.data
          if (content.document_id !== input.document_id || content.source_hash_snapshot !== input.source_hash_snapshot
            || !Array.isArray(content.chunks) || content.chunks.length > 20
            || (input.chunk_no !== undefined && (content.chunks.length !== 1 || !isRecord(content.chunks[0])
              || content.chunks[0].chunk_no !== input.chunk_no))) return new Response(null, { status: 502 })
          return Response.json(result.data.data.data, { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
          if (request.signal.aborted) throw error
          return new Response(null, { status: 502 })
        }
      },
    }), 'tool-erp: knowledge citation preview')
    if (desktopBridge === undefined) {
      ctx.on('webserver/index-inject', (table) => {
        table.push({ kind: 'global', name: '__DSH_KNOWLEDGE_BASES_PATH__', value: '/api/erp/knowledge-bases' })
      })
    }
  }

  const enabledSkillKeys = async (pluginKey: string, options: SkillLookupOptions): Promise<Set<string> | undefined> => {
    const sessionId = sessionIdFromLookup(options)
    if (sessionId === undefined) return undefined
    const accessToken = token(sessionId)
    const response = await fetchApi(new URL(PLUGIN_SKILLS_PATH, baseUrl), {
      method: 'GET', redirect: 'error', headers: {
        accept: 'application/json',
        ...desktopBridge === undefined ? { authorization: `Bearer ${accessToken}` } : {},
      },
      cache: 'no-store',
    }, options.signal ?? AbortSignal.timeout(config.timeoutMs))
    if (response.status === 401) {
      if (desktopBridge === undefined && credentials.get(sessionId)?.accessToken === accessToken) {
        credentials.delete(sessionId)
      }
      throw new Error('ERP 登录已失效，请重新登录后刷新技能目录')
    }
    const result = await readResponse(response, config.maxResponseChars)
    if (result.truncated || !response.ok || !isRecord(result.data)
      || result.data.code !== 0 || !isRecord(result.data.data)
      || !isRecord(result.data.data.enabled_skill_keys_by_plugin)) {
      throw new Error(`ERP 技能目录读取失败（HTTP ${response.status}）`)
    }
    const rawKeys = result.data.data.enabled_skill_keys_by_plugin[pluginKey]
    if (rawKeys === undefined) return undefined
    if (!Array.isArray(rawKeys) || rawKeys.some(key => typeof key !== 'string')) {
      throw new Error('ERP 返回的技能目录格式无效')
    }
    return new Set(rawKeys as string[])
  }

  for (const source of config.skillSources) {
    if (!/^[a-z][a-z0-9_]*$/u.test(source.pluginKey)) throw new Error(`无效的 ERP 能力包标识：${source.pluginKey}`)
    const providerName = `erp-skills-${source.pluginKey}`
    ctx.skills.registerProvider((control) => {
      invalidateSkillCatalogs.add(control.invalidate)
      const refreshTimer = setInterval(control.invalidate, config.skillCatalogRefreshMs)
      refreshTimer.unref()
      control.signal.addEventListener('abort', () => {
        clearInterval(refreshTimer)
        invalidateSkillCatalogs.delete(control.invalidate)
      }, { once: true })
      const fileProvider = new FileSystemSkillProvider(ctx, control, {
        providerName,
        includeDefaultRoots: false,
        customSkillDirs: source.customSkillDirs,
        ...(source.bundledSkillDir === undefined ? {} : { bundledSkillDir: source.bundledSkillDir }),
      } satisfies FileSystemSkillConfig)
      const isAllowed = async (candidate: SkillCandidate, options: SkillLookupOptions): Promise<boolean> => {
        const declared = await enabledSkillKeys(source.pluginKey, options)
        if (declared === undefined) return false
        return candidate.source === 'bundled' ? declared.has(candidate.name) : true
      }
      const provider: SkillProvider = {
        name: providerName,
        list: async (options) => {
          const declared = await enabledSkillKeys(source.pluginKey, options)
          if (declared === undefined) return []
          const observation = await fileProvider.list(options)
          const candidates = Array.isArray(observation) ? observation : observation.candidates
          const filtered = candidates.filter(candidate => candidate.source !== 'bundled' || declared.has(candidate.name))
          return Array.isArray(observation) ? filtered : { candidates: filtered, complete: observation.complete }
        },
        get: async (candidate, options): Promise<SkillDefinition | undefined> => {
          if (!await isAllowed(candidate, options)) return undefined
          return await fileProvider.get(candidate, options)
        },
      }
      return provider
    })
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'erp_discover',
    description: 'Discover approved ERP data and operations for the current question. Use search with the user question, then describe selected IDs using the returned catalog_revision. Read definitions, grain and metric scope before querying. You may search again with narrower keywords if resources are missing. Never guess tables, parameters or statistical definitions. For multi-table reads, describe related resources and use only relation IDs with join_supported=true in erp_query operation plan. Use metric for a reviewed business metric, or validate to check a proposed structured query or plan without executing it. Menu navigation still uses GET /api/auth/menus with erp_api.',
    parameters: {
      action: { type: 'string', required: true, enum: ['domains', 'search', 'describe', 'validate', 'metric'] },
      question: { type: 'string', description: 'Business question for search; do not include actual personal identifiers.' },
      ids: { type: 'array', items: { type: 'string' }, description: 'Up to six IDs returned by search; required for describe.' },
      domain_ids: { type: 'array', items: { type: 'string' }, description: 'Preferred domains, not a restriction on cross-domain search.' },
      kinds: { type: 'array', items: { type: 'string', enum: ['resource', 'operation', 'metric'] } },
      limit: { type: 'integer', description: 'Search candidates, at most twelve.' },
      catalog_revision: { type: 'string', description: 'Returned catalog revision; required for describe, validate and metric. Search again if stale.' },
      query: { type: 'json', description: 'Structured erp_query arguments for validate.' },
      metric_id: { type: 'string', description: 'Reviewed metric ID returned by search/describe.' },
      filters: { type: 'json', description: 'Optional metric filters using the described resource fields.' },
      group_by: { type: 'array', items: { type: 'string' }, description: 'Metric dimensions from its definition.' },
      offset: { type: 'integer', description: 'Metric group pagination offset, use next_offset when truncated.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    timeoutMs: config.timeoutMs + 2_000,
    async execute(args, exec) {
      const accessToken = token(exec.agent?.session.id)
      const response = await fetchApi(new URL('/api/harness/discovery', baseUrl), {
        method: 'POST', redirect: 'error', body: JSON.stringify(args),
        headers: { accept: 'application/json', 'content-type': 'application/json',
          ...desktopBridge === undefined ? { authorization: `Bearer ${accessToken}` } : {} },
      }, exec.signal)
      if (response.status === 401) {
        if (exec.agent !== undefined && credentials.get(exec.agent.session.id)?.accessToken === accessToken) {
          credentials.delete(exec.agent.session.id)
        }
        throw new Error('ERP 登录已失效，请重新登录后继续当前会话')
      }
      if (response.status === 409) throw new Error('ERP 资源目录已更新，请重新 search 后再使用新目录版本')
      const result = await readResponse(response, config.maxResponseChars)
      if (result.truncated) throw new Error('ERP 资源定义过大，请减少 describe 的资源数量')
      if (!response.ok) throw new Error(`ERP 资源发现失败（HTTP ${response.status}），请核实资源和参数；不要猜测接口`)
      if (result.data === null || typeof result.data !== 'object' || Array.isArray(result.data)
        || result.data.code !== 0 || result.data.data === null || typeof result.data.data !== 'object'
        || Array.isArray(result.data.data) || result.data.data.discovery_contract_version !== 1
        || typeof result.data.data.catalog_revision !== 'string') throw new Error('ERP 后端未提供兼容的资源发现接口，请更新后端')
      return result.data
    },
    presentCall: args => ({ card: 'generic', title: `Discover ERP ${args.action}`, kind: 'read', rawInput: args }),
  })))

  const executeApi = async (args: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; query?: Record<string, JsonValue>; body?: JsonValue }, exec: Pick<ToolRunContext, 'agent' | 'callId' | 'signal'>, confirmed = false): Promise<JsonValue> => {
    const url = ensureAllowedUrl(baseUrl, args.path)
    appendQuery(url, args.query)
    const accessToken = token(exec.agent?.session.id)
    const headers: Record<string, string> = {
      accept: 'application/json', 'content-type': 'application/json',
      ...desktopBridge === undefined ? { authorization: `Bearer ${accessToken}` } : {},
    }
    let body = args.body === undefined ? undefined : normalizeRequestBody(args.body)
    if (args.method === 'POST' && url.pathname === '/api/knowledge/search') {
      const selected = selectedKnowledgeBases(exec)
      // 用户本条消息的选择优先于模型参数，通用 API 工具同样不能扩大检索范围。
      if (selected.length > 0 && isRecord(body)) body = { ...body, knowledge_base_ids: selected }
    }
    const requestBody = JSON.stringify({
      method: args.method,
      path: `${url.pathname}${url.search}`,
      ...body === undefined ? {} : { body },
    })
    let response = await fetchApi(new URL('/api/harness/api', baseUrl), {
      method: 'POST', headers, body: requestBody, redirect: 'error',
    }, exec.signal)
    if (response.status === 401 && exec.agent !== undefined) {
      if (credentials.get(exec.agent.session.id)?.accessToken === accessToken) credentials.delete(exec.agent.session.id)
      throw new Error('ERP 登录已失效，请在 ERP 客户端重新登录或刷新登录状态')
    }
    let result = await readResponse(response, config.maxResponseChars)
    const pending = result.data
    if (response.status === 409 && pending !== null && typeof pending === 'object' && !Array.isArray(pending)
      && pending.code === 0 && pending.data !== null && typeof pending.data === 'object' && !Array.isArray(pending.data)
      && pending.data.approval_required === true) {
      if (!confirmed) {
        const approval = ctx.get('approval')
        if (exec.agent === undefined || approval === undefined) throw new Error('ERP 写操作需要用户确认，当前没有可用的确认界面')
        const displayReason = knowledgeWriteSummary(args.method, url.pathname, body)
          ?? { en: `Confirm this ERP data change:\n${args.method} ${url.pathname}${url.search}\n${JSON.stringify({ body }, null, 2)}`,
            zh: `请确认这次 ERP 数据修改：\n${args.method} ${url.pathname}${url.search}\n${JSON.stringify({ body }, null, 2)}` }
        const approved = await approval.request({ agent: exec.agent, toolName: 'erp_api', callId: exec.callId,
          reason: 'ERP write requires confirmation',
          displayReason,
          signal: AbortSignal.any([exec.signal, AbortSignal.timeout(config.writeApprovalTimeoutMs)]),
        })
        if (approved !== 'allowed-once' || exec.signal.aborted) throw new Error('ERP 写操作未获确认，未修改业务数据')
      }
      exec.signal.throwIfAborted()
      // Never publish the grant to tool output, parameters or session events.
      const grantResponse = await fetchApi(new URL('/api/harness/write-approval', baseUrl), {
        method: 'POST', headers, body: requestBody, redirect: 'error',
      }, exec.signal)
      const grant = await readResponse(grantResponse, config.maxResponseChars)
      if (!grantResponse.ok || grant.truncated || grant.data === null || typeof grant.data !== 'object' || Array.isArray(grant.data)
        || grant.data.code !== 0 || grant.data.data === null || typeof grant.data.data !== 'object' || Array.isArray(grant.data.data)
        || typeof grant.data.data.write_approval !== 'string') throw new Error('ERP 写操作确认已失效，请重新确认')
      response = await fetchApi(new URL('/api/harness/api', baseUrl), { method: 'POST', headers,
        body: JSON.stringify({ ...JSON.parse(requestBody) as object, write_approval: grant.data.data.write_approval }), redirect: 'error',
      }, exec.signal)
      result = await readResponse(response, config.maxResponseChars)
    }
    if (result.truncated) throw new Error('ERP 接口结果超过已配置的最大响应长度')
    const envelope = result.data
    if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)
      || envelope.code !== 0 || envelope.data === null || typeof envelope.data !== 'object'
      || Array.isArray(envelope.data)) {
      if (!response.ok) throw new Error(apiFailure(response.status, undefined).message)
      throw new Error(`ERP 安全接口不可用（HTTP ${response.status}），请检查 ERP 服务版本与地址，不要据此推断知识模块未部署`)
    }
    const safe = envelope.data
    if (typeof safe.status !== 'number' || typeof safe.ok !== 'boolean'
      || safe.status !== response.status || safe.ok !== response.ok) {
      throw new Error('ERP 安全接口响应格式错误')
    }
    const data = safe.ok && ['/api/knowledge/search', '/api/knowledge/read'].includes(url.pathname)
      ? withKnowledgeCitations(safe.data ?? null) : safe.data ?? null
    if (JSON.stringify(data).length > config.maxResponseChars) throw new Error('ERP 接口结果超过已配置的最大响应长度')
    return {
      ok: safe.ok,
      status: safe.status,
      method: args.method,
      data,
      ...safe.ok ? {} : apiFailure(safe.status, safe.error_code),
      ...safe.privacy === undefined ? {} : { privacy: safe.privacy },
    }
  }

  // 岗位共同记忆由 ERP 专用入口核验成员并自动发布，不放宽通用写入确认。
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'erp_position_memory_read',
    description: 'Read the current published 岗位工作.md for one of your current ERP positions before doing related work or remembering shared experience. Use position_id from the current ERP position context. An absent 岗位工作.md has document_id=null; this says nothing about other drafts in the library. If can_update=true and this turn retrieved verified formal duties or a shared agreement, initialize the document with erp_position_memory_update. can_update=false means do not write. Only published text is shared; a queued revision is not yet effective.',
    parameters: { position_id: { type: 'string', required: true, description: 'Current ERP position_id; never infer from a role name.' } },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    timeoutMs: config.timeoutMs + 2_000,
    execute: (args, exec) => executeApi({ method: 'POST', path: '/api/knowledge/position-memory/read', body: { position_id: args.position_id } }, exec),
    presentCall: args => ({ card: 'generic', title: '读取岗位共同记忆', kind: 'read', rawInput: args }),
  })))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'erp_position_memory_update',
    description: 'Automatically consolidate verified reusable methods, workflows and agreements into the current position’s shared 岗位工作.md. No per-write user confirmation or human review is required for this dedicated tool. Read first, deduplicate and preserve other members’ content. For a missing document supply content; for an existing document supply source_hash_snapshot and exact before/after replacements only. Never store personal preferences, temporary task progress, private/person/student/financial details, credentials or unverified inferences. When document_id=null and can_update=true, initialize from verified formal duties or shared agreements retrieved in this turn; completed practical work or a new experience is not a prerequisite. Include a concise duty summary, source document names and document_id values, and an experience section marked pending when empty. Preserve formal sources as authoritative rather than copying whole policies. For an existing document with no new content, or without reliable sources, skip silently; do not issue a no-write report. ERP rechecks membership and versions and queues publication. Creation, submission, normal queueing/indexing, successful publication and no-op maintenance are silent: do not append a memory-maintenance report to the business answer. After successful submission let the background publisher finish; do not poll merely to report progress or ask the user to wait or follow up. Only report a real failure requiring user action, briefly describing the impact and next step. If the user asks for status, distinguish queued from published truthfully. On conflict reread; on uncertain writes do not blindly retry. Other ERP tools still require confirmation.',
    parameters: {
      position_id: { type: 'string', required: true, description: 'Current position_id returned in ERP context.' },
      source_hash_snapshot: { type: 'string', description: 'Exact current token returned by erp_position_memory_read; omit for first creation.' },
      content: { type: 'string', description: 'Initial shared Markdown only when document_id is null.' },
      replacements: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        before: { type: 'string', required: true, description: 'Exact unique existing passage, including whitespace.' },
        after: { type: 'string', required: true, description: 'Merged replacement preserving other shared knowledge.' },
      } }, description: 'Up to 20 exact fragment changes for an existing document.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    timeoutMs: config.timeoutMs + 2_000,
    execute: (args, exec) => executeApi({ method: 'POST', path: '/api/knowledge/position-memory/update', body: {
      position_id: args.position_id,
      ...args.source_hash_snapshot === undefined ? {} : { source_hash_snapshot: args.source_hash_snapshot },
      ...args.content === undefined ? {} : { content: args.content },
      ...args.replacements === undefined ? {} : { replacements: args.replacements },
    } }, exec),
    presentCall: args => ({ card: 'generic', title: '自动更新岗位共同记忆', kind: 'edit', rawInput: args }),
  })))

  if (config.knowledgeFiles === true) registerKnowledgeFiles(ctx, executeApi)

  const apiTool = defineTool({
    name: 'erp_api',
    description: 'Call an ERP business HTTP operation as the logged-in user. Discover operations with erp_discover search then describe. For menu navigation use GET /api/auth/menus directly. The backend filters protected personal data and unknown text; hidden fields do not mean empty or zero. Writes require user confirmation and return status; knowledge document creation also returns document_id, version_id and draft status. Authentication and credential endpoints are isolated. Never pass passwords, access tokens or redacted placeholders. Use erp_query for structured reads.',
    parameters: {
      method: { type: 'string', required: true, enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      path: { type: 'string', required: true, description: 'ERP path beginning with /, normally /api/....' },
      query: { type: 'object', additionalProperties: true, description: 'Optional query-string values.' },
      body: { type: 'json', description: 'Optional JSON request body for POST, PUT, or PATCH.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: config.writeApprovalTimeoutMs + 3 * config.timeoutMs + 2_000,
    execute: executeApi,
    presentCall: args => ({
      card: 'generic',
      title: `${args.method} ERP ${args.path}`,
      kind: args.method === 'GET' ? 'read' : 'other',
      rawInput: args,
    }),
  })
  ctx.effect(() => ctx.tools.register(apiTool))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'erp_knowledge_list_bases',
    description: 'List or search the registered knowledge bases that the current ERP user may manage before creating a document. This is a read operation and does not require searching published documents first. Use the returned knowledge_base_id, never guess it. If several bases match and the destination is unclear, ask the user to choose. An empty list means no matching base is visible to this account, not that the module is absent. Respect has_more and next_offset. Do not probe guessed health or administrative paths when a request fails; use the returned error code to distinguish tenant enablement, missing routes and permissions.',
    parameters: {
      query: { type: 'string', description: 'Optional knowledge base name or keywords, up to 256 characters.' },
      offset: { type: 'integer', description: 'Pagination offset; use next_offset when has_more is true.' },
      limit: { type: 'integer', description: 'Bases per page, 1 to 50; default 20.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    timeoutMs: config.timeoutMs + 2_000,
    execute: (args, exec) => executeApi({ method: 'POST', path: '/api/knowledge/base-options', body: {
      query: args.query ?? '', offset: args.offset ?? 0, limit: args.limit ?? 20,
    } }, exec),
    presentCall: args => ({ card: 'generic', title: '选择目标知识库', kind: 'read', rawInput: args }),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'erp_knowledge_create_document',
    description: 'Create a new online Markdown draft in a chosen ERP knowledge base after explicit user confirmation. Use erp_knowledge_list_bases to select a real knowledge_base_id; no existing document or edit_token is required. Requires knowledge contribution permission and access to the target library. Success returns document_id, version_id and status_code=draft. Then use erp_knowledge_version_status to obtain the exact hash for erp_knowledge_submit_version. Humans review in ERP and approval queues verified publication; creating a draft does not make it searchable or grant read access. Do not use the update tool for creation. A local Markdown file is not a knowledge-base write. If the result is unclear or no document_id is returned, do not claim success or automatically retry creation; ask the user to check ERP for a possible existing draft.',
    parameters: {
      knowledge_base_id: { type: 'string', required: true, description: 'ERP knowledge_base_id returned by erp_knowledge_list_bases and selected by the user.' },
      document_name: { type: 'string', required: true, description: 'Title of the new knowledge document, 1 to 256 characters.' },
      content: { type: 'string', required: true, description: 'Complete Markdown body for the new draft, 1 to 200000 characters.' },
      change_reason: { type: 'string', description: 'Optional purpose or reason for this new document.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    timeoutMs: config.writeApprovalTimeoutMs + 3 * config.timeoutMs + 2_000,
    execute: (args, exec) => executeApi({ method: 'POST', path: `/api/knowledge/bases/${encodeURIComponent(args.knowledge_base_id)}/documents/manual`, body: {
      document_name: args.document_name, content: args.content,
      ...args.change_reason === undefined ? {} : { change_reason: args.change_reason },
    } }, exec),
    presentCall: args => ({ card: 'generic', title: '新建知识文档草稿', kind: 'edit', rawInput: args }),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'erp_knowledge_search',
    description: 'Search internal company knowledge, policies and manuals allowed for the current ERP user. Use this tool for questions requiring internal documents. Results include document_id, document_name, chunk_index, content, source_hash_snapshot and rerank diagnostics. Cite the document name and chunk index when answering. For each supported claim append a numbered Markdown link using the returned citation_url unchanged, for example `[1](citation_url)`. Reuse its number for the same source; never invent a citation URL. Include the document name in the link title. Read longer context with erp_knowledge_read_document. If the authorized scope is empty or evidence is insufficient, say so; do not invent a policy. To add a new document, use erp_knowledge_list_bases and erp_knowledge_create_document; finding a published document first is unnecessary.',
    parameters: {
      query: { type: 'string', required: true, description: 'Question or keywords to find in authorized internal documents.' },
      limit: { type: 'integer', description: 'Maximum search hits, 1 to 12; default 5.' },
      document_ids: { type: 'array', items: { type: 'string' }, description: 'Optional document_id values returned by knowledge search to narrow its scope.' },
      knowledge_base_ids: { type: 'array', items: { type: 'string' }, description: 'Optional ERP knowledge base IDs to restrict retrieval. Knowledge-base references in the current user message restrict searches to their IDs. This filter intersects document_ids and current read permissions; an empty list searches nothing.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    timeoutMs: config.timeoutMs + 2_000,
    async execute(args, exec) {
      return executeApi({ method: 'POST', path: '/api/knowledge/search', body: {
        query: args.query, limit: args.limit ?? 5,
        ...args.document_ids === undefined ? {} : { document_ids: args.document_ids },
        ...args.knowledge_base_ids === undefined ? {} : { knowledge_base_ids: args.knowledge_base_ids },
      } }, exec)
    },
    presentCall: args => ({ card: 'generic', title: '检索企业知识库', kind: 'read', rawInput: args }),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'erp_knowledge_read_document',
    description: 'Read a page of an authorized internal document using document_id returned by erp_knowledge_search. Access is checked again on every read. Cite document_name and chunk_index, and respect truncated markers. Use returned citation_url values unchanged for numbered Markdown source links beside supported claims; never invent source links. Use page and total_chunks to request more context when needed. If access has been revoked or the source changed, do not answer from an older excerpt as if it were current.',
    parameters: {
      document_id: { type: 'string', required: true, description: 'document_id returned by erp_knowledge_search.' },
      page: { type: 'integer', description: 'Page number starting at 1; default 1.' },
      page_size: { type: 'integer', description: 'Chunks per page, 1 to 20; default 10.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    timeoutMs: config.timeoutMs + 2_000,
    async execute(args, exec) {
      return executeApi({ method: 'POST', path: '/api/knowledge/read', body: {
        document_id: args.document_id, page: args.page ?? 1, page_size: args.page_size ?? 10,
      } }, exec)
    },
    presentCall: args => ({ card: 'generic', title: '读取知识文档正文', kind: 'read', rawInput: args }),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'erp_knowledge_update_document',
    description: 'Save a draft edit of an online Markdown document after explicit user confirmation. First query erp_knowledge_version_status and pass its root edit_token as source_hash_snapshot; a null token means editing is unavailable. For local changes, use replacements with exact before/after text: ERP reads the complete original and preserves all other content. Each before must match exactly once; missing, repeated or overlapping fragments reject the whole edit. Up to 20 replacements are allowed. Omit document_name to keep the title. Use content only for a complete replacement supplied by the user; never rebuild the document from truncated or redacted excerpts. Do not send content and replacements together. Uploaded files, including .md, and external sources are read-only. Frozen review or approved versions cannot be edited. Requires knowledge contribution permission and access to the target library. Saving does not change the published version or make the draft searchable. After saving, query version status and use erp_knowledge_submit_version for review; human approval in ERP queues publication and engine verification.',
    parameters: {
      document_id: { type: 'string', required: true, description: 'ERP document_id returned by knowledge search or read.' },
      source_hash_snapshot: { type: 'string', required: true, description: 'Root edit_token returned by version status; before any draft exists, the current published source_hash_snapshot is also valid. Never guess a token or edit when the token is null.' },
      document_name: { type: 'string', description: 'Optional new document title, 1 to 256 characters; omit to keep the current title.' },
      content: { type: 'string', description: 'Complete replacement Markdown supplied by the user, 1 to 200000 characters. Mutually exclusive with replacements.' },
      replacements: { type: 'array', description: 'Up to 20 exact non-overlapping replacements against the same original document; omit content when using these.', items: {
        type: 'object', additionalProperties: false, properties: {
          before: { type: 'string', required: true, description: 'Exact original text, including indentation and newlines; must occur exactly once.' },
          after: { type: 'string', required: true, description: 'Replacement Markdown; an empty string deletes the matched fragment.' },
        },
      } },
      change_reason: { type: 'string', description: 'Optional reason for this draft change, shown to the human reviewer.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    timeoutMs: config.writeApprovalTimeoutMs + 3 * config.timeoutMs + 2_000,
    async execute(args, exec) {
      if (args.content !== undefined && args.replacements !== undefined) throw new Error('完整正文与片段替换不能同时提交')
      if (args.document_name === undefined && args.content === undefined && args.replacements === undefined) throw new Error('请提供新标题、完整正文或待替换片段')
      return executeApi({ method: 'PUT', path: `/api/knowledge/documents/${encodeURIComponent(args.document_id)}/edit`, body: {
        source_hash_snapshot: args.source_hash_snapshot,
        ...args.document_name === undefined ? {} : { document_name: args.document_name },
        ...args.content === undefined ? {} : { content: args.content },
        ...args.replacements === undefined ? {} : { replacements: args.replacements },
        ...args.change_reason === undefined ? {} : { change_reason: args.change_reason },
      } }, exec)
    },
    presentCall: args => ({ card: 'generic', title: '保存知识文档草稿', kind: 'edit', rawInput: args }),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'erp_knowledge_version_status',
    description: 'Read ERP document version numbers, draft concurrency tokens, review states and publication progress. Requires knowledge contribution permission and access to the target library. This tool returns metadata only, without draft bodies or reviewer comments. Use the root edit_token as source_hash_snapshot when saving an edit, including a revision after rejection; a null token means editing is unavailable. Use the exact version_id and content_hash_snapshot when submitting review. Published content remains in use until a human-reviewed version is successfully published.',
    parameters: {
      document_id: { type: 'string', required: true, description: 'ERP logical document UUID, not a WeKnora document identifier.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    timeoutMs: config.timeoutMs + 2_000,
    execute: (args, exec) => executeApi({ method: 'POST', path: '/api/knowledge/version-status', body: { document_id: args.document_id } }, exec),
    presentCall: args => ({ card: 'generic', title: '查询知识版本状态', kind: 'read', rawInput: args }),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'erp_knowledge_submit_version',
    description: 'Submit one ERP draft for human review and freeze that exact version. Requires knowledge contribution permission and explicit user confirmation. Obtain version_id and content_hash_snapshot from erp_knowledge_version_status; never guess them. This does not approve, publish, change WeKnora, or replace the published version. A human reviewer completes approval in ERP; successful engine publication then activates the version. A configured workflow may require the user to select reviewers in ERP before submission.',
    parameters: {
      version_id: { type: 'string', required: true, description: 'Exact draft version UUID returned by ERP version status.' },
      content_hash_snapshot: { type: 'string', required: true, description: 'Exact draft content hash returned by ERP version status.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    timeoutMs: config.writeApprovalTimeoutMs + 3 * config.timeoutMs + 2_000,
    execute: (args, exec) => executeApi({
      method: 'POST', path: `/api/knowledge/versions/${encodeURIComponent(args.version_id)}/submit`,
      body: { content_hash_snapshot: args.content_hash_snapshot },
    }, exec),
    presentCall: args => ({ card: 'generic', title: '提交知识草稿审核', kind: 'edit', rawInput: args }),
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'erp_query',
    description: 'Read approved ERP data as the logged-in user. First search and describe relevant resources with erp_discover, then query only described fields with the returned catalog_revision. Use operation query for one resource, or plan for multi-table reads via described executable relation IDs. No SQL or guessed relationships. Plan aggregates count root records once per group, and aggregate fields must belong to the root; choose the entity being measured as root. Cross-group totals may overlap: respect group_totals_additive and never sum overlapping groups as a total. Use reviewed metric definitions when applicable. Never pass identity or tokens. Catalog is a legacy operation; use discovery for new tasks.',
    parameters: {
      operation: { type: 'string', required: true, enum: ['catalog', 'query', 'plan'] },
      plan: { type: 'json', description: 'Required for operation plan; put all query options inside this object, leaving only operation, plan and catalog_revision outside. Schema: {version:1, root:{resource:"table_from_describe",alias:"r"}, joins:[{from_alias:"r",relation_id:"relation:ID_FROM_DESCRIBE",alias:"d",kind:"left"}], select:[{field:"d.department_name",as:"department"}], group_by:["d.department_name"], aggregates:[{function:"count",as:"count"}], filters:[{field:"r.status",op:"eq",value:1}], order:[{field:"count",direction:"desc"}], limit:20,offset:0,include_count:false}. Use execution.max_joins returned by describe as the join limit; kind inner or left. Field references use alias.field; output aliases use ASCII letters, digits or underscores. Aggregates count/sum/avg/min/max, only root fields (count may omit field). For aggregation select exactly the group_by fields; for row reads omit aggregates/group_by. total counts result rows/groups, not root entities; follow next_offset if truncated. Use actual described table and field names, not this example placeholders.' },
      resource: { type: 'string', description: 'Resource name from the catalog; required for query.' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Columns to return. Omit for the resource default.' },
      filters: { type: 'array', items: {
        type: 'object', additionalProperties: false, properties: {
          field: { type: 'string', required: true },
          op: { type: 'string', required: true, enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'like', 'ilike', 'is_null'] },
          value: { type: 'json' },
        },
      } },
      order: { type: 'array', items: {
        type: 'object', additionalProperties: false, properties: {
          field: { type: 'string', required: true },
          direction: { type: 'string', required: true, enum: ['asc', 'desc'] },
        },
      } },
      limit: { type: 'integer', description: 'Maximum rows, capped by the ERP.' },
      offset: { type: 'integer' },
      include_count: { type: 'boolean' },
      catalog_revision: { type: 'string', description: 'Current revision from resource discovery; stale versions require a new search.' },
      group_by: { type: 'array', items: { type: 'string' }, description: 'Up to three approved dimensions. Requires aggregate; no row ordering. Follow next_offset if grouped results are truncated.' },
      aggregate: { type: 'object', additionalProperties: false, properties: {
        function: { type: 'string', required: true, enum: ['count', 'sum', 'avg', 'min', 'max'] },
        field: { type: 'string', description: 'Required except for counting rows.' },
      } },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: config.timeoutMs + 2_000,
    async execute(args, exec) {
      const url = new URL('/api/harness/query', baseUrl)
      const accessToken = token(exec.agent?.session.id)
      const headers: Record<string, string> = {
        accept: 'application/json',
        'content-type': 'application/json',
        ...desktopBridge === undefined ? { authorization: `Bearer ${accessToken}` } : {},
      }
      const body = JSON.stringify(args)
      const response = await fetchApi(url, { method: 'POST', headers, body, redirect: 'error' }, exec.signal)
      if (response.status === 409) throw new Error('ERP 资源目录已更新，请重新 search 和 describe 后重试')
      if (response.status === 401 && exec.agent !== undefined) {
        if (credentials.get(exec.agent.session.id)?.accessToken === accessToken) credentials.delete(exec.agent.session.id)
        throw new Error('ERP 登录已失效，请在嵌入页面重新登录或刷新登录状态')
      }
      const result = await readResponse(response, config.maxResponseChars)
      if (result.truncated) throw new Error('ERP 查询结果超过已配置的最大响应长度')
      if (!response.ok) throw new Error(`ERP 查询失败（HTTP ${response.status}）`)
      if (result.data === null || typeof result.data !== 'object' || Array.isArray(result.data)
        || result.data.code !== 0 || result.data.data === null || typeof result.data.data !== 'object'
        || Array.isArray(result.data.data) || result.data.data.policy_version !== 1) {
        throw new Error('ERP 后端未启用受控查询策略，请更新后端后重试')
      }
      if (args.operation === 'plan' && result.data.data.plan_version !== 1) {
        throw new Error('ERP 后端未提供兼容的关联查询，请更新后端')
      }
      return result.data
    },
    presentCall: args => ({
      card: 'generic', title: args.operation === 'catalog' ? 'ERP query catalog' : args.operation === 'plan' ? 'Query related ERP data' : `Query ERP ${args.resource ?? ''}`,
      kind: 'read', rawInput: args,
    }),
  })))
}
