/** ERP tools use Electron main as the authenticated API and navigation boundary. */
import { randomUUID } from 'node:crypto'
import { completionReviewRequest, parseCompletionReview } from '@deepseek-ai/dsh-client-ui-ai-control'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { registerDesktopErp, type SkillSourceConfig } from '@deepseek-ai/dsh-tool-erp'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'erp-position-memory': { kind: 'erp-position-memory' }
  }
}

type Primitive = string | number | boolean | null
interface ToolReply { type: 'erp-tool-result'; requestId: string; status?: number; body?: string; ok?: boolean; actualPath?: string; error?: string }
const DATA_PLUGIN_KEY = 'erp-data'
const NAVIGATION_PLUGIN_KEY = 'erp-navigation'
const DATA_CAPABILITY = 'erp.data'
const NAVIGATION_CAPABILITY = 'erp.navigation'
const AI_CAPABILITIES_PATH = '/api/plugins/ai-capabilities'

function silentPositionMemory(request: GenerateOptions): boolean {
  const lastInput = request.messages.findLastIndex(message => message.role === 'user')
  const input = request.messages[lastInput]
  if (input?.role !== 'user' || input.source?.kind !== 'erp-position-memory') return false
  return !request.messages.slice(lastInput + 1).some((message) => {
    if (message.role !== 'tool') return false
    if (message.isError) return true
    return message.content.some((block) => {
      if (block.type !== 'text') return false
      let value: unknown
      try { value = JSON.parse(block.text) } catch (_error) {
        // 无法判断工具结果时保留说明，避免隐藏维护失败。
        return true
      }
      return isRecord(value) && value.ok === false
    })
  })
}

function reviewFailure(status = 502, timeout = false): Response {
  const error_code = timeout ? 'timeout' : status === 404 ? 'service_unavailable' : status === 403 ? 'permission_denied'
    : status === 401 ? 'sign_in_required' : status === 429 ? 'rate_limited' : 'model_unavailable'
  return Response.json({ code: status, error_code, message: 'Completion review unavailable' },
    { status: [401, 403, 404, 429].includes(status) ? status : 502, headers: { 'cache-control': 'no-store' } })
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safePath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || path.length > 2048 || /[\\?#\u0000-\u001f\u007f]/u.test(path)) return false
  try {
    const decoded = decodeURIComponent(path)
    return decoded.startsWith('/') && !decoded.startsWith('//') && !/[\\?#\u0000-\u001f\u007f]/u.test(decoded)
  } catch { return false }
}

function queryOf(input: unknown): Record<string, Primitive> {
  if (input === undefined) return {}
  if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 32) throw new Error('ERP 路由查询参数无效')
  const result: Record<string, Primitive> = {}
  for (const [key, value] of Object.entries(input)) {
    if (key.length > 64 || (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
      || typeof value === 'string' && value.length > 512) throw new Error('ERP 路由查询参数无效')
    result[key] = value as Primitive
  }
  return result
}

export class ErpDesktopTools {
  private readonly pending = new Map<string, {
    resolve: (value: ToolReply) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  constructor(private readonly apiOrigin: string, private readonly send: (message: object) => void) {}

  accept(message: unknown): void {
    if (message === null || typeof message !== 'object' || !('type' in message) || message.type !== 'erp-tool-result'
      || !('requestId' in message) || typeof message.requestId !== 'string') return
    const pending = this.pending.get(message.requestId)
    if (!pending) return
    this.pending.delete(message.requestId)
    clearTimeout(pending.timer)
    pending.resolve(message as ToolReply)
  }

  /**
   * Send an authenticated request through main, which validates the allowed ERP target.
   * @param payload - fixed-target API or authorized navigation request.
   * @param signal - cancellation for this pending desktop request.
   * @returns the main-process response, or a rejection on cancellation or timeout.
   */
  request(payload: object, signal: AbortSignal): Promise<ToolReply> {
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('ERP 操作已取消')); return }
      const cleanup = (): void => { signal.removeEventListener('abort', abort); clearTimeout(timer); this.pending.delete(requestId) }
      const abort = (): void => { cleanup(); reject(new Error('ERP 操作已取消')) }
      const timer = setTimeout(() => { cleanup(); reject(new Error('ERP 客户端未及时响应')) }, 32_000)
      signal.addEventListener('abort', abort, { once: true })
      this.pending.set(requestId, { resolve: (value) => { cleanup(); resolve(value) }, reject, timer })
      this.send({ type: 'erp-tool-request', requestId, ...payload })
    })
  }

  /**
   * Read the generic ERP protocol capabilities for the current authenticated connection.
   * @param signal - Abort signal for the authenticated IPC request.
   * @returns The ERP protocol capabilities supported by this connection.
   */
  async enabledErpCapabilities(signal: AbortSignal): Promise<Set<string>> {
    const reply = await this.request({ kind: 'api', method: 'GET', path: AI_CAPABILITIES_PATH, body: null }, signal)
    if (reply.error) throw new Error(reply.error)
    if (reply.status !== 200 || typeof reply.body !== 'string') throw new Error('ERP 插件能力目录读取失败')
    let value: unknown
    try { value = JSON.parse(reply.body) } catch { throw new Error('ERP 插件能力目录响应无效') }
    if (!isRecord(value) || value.code !== 0 || !isRecord(value.data) || value.data.protocol_version !== 1) {
      throw new Error('ERP 插件能力目录响应无效')
    }
    const keys = value.data.capabilities
    if (!Array.isArray(keys) || !keys.every((key): key is string => typeof key === 'string')) {
      throw new Error('ERP 插件能力目录响应无效')
    }
    return new Set(keys)
  }

  private async requireErpCapability(pluginKey: string, signal: AbortSignal): Promise<void> {
    const enabled = await this.enabledErpCapabilities(signal)
    if (!enabled.has(pluginKey)) throw new Error('当前 ERP 连接未开放此通用能力')
  }

  /**
   * Build the Loader entry for ERP data tools, tenant-gated skills and current-user system prompts.
   * Agent assemblies read fresh protected ERP context; failed reads reject the model request.
   * @param skillSources - Filesystem roots for bundled and customer skills.
   * @param skillCatalogRefreshMs - Maximum delay before refreshing tenant skill access.
   * @returns The Cordis plugin registered by the Host Loader.
   */
  dataPlugin(skillSources: SkillSourceConfig[] = [], skillCatalogRefreshMs = 15_000) {
    return {
      name: 'erp-data',
      inject: ['tools', 'skills'],
      apply: (ctx: Context): void => {
        const memoryEnabled = new WeakSet<object>()
        const memoryTurn = new WeakMap<object, number>()
        ctx.on('llm/stream', async function* (request, next): AsyncIterable<StreamChunk> {
          const silent = silentPositionMemory(request)
          for await (const chunk of next()) {
            // 同时清除增量和完整正文，确保实时显示与日志回放一致；工具调用不变。
            if (silent && chunk.type === 'text-delta') yield { ...chunk, text: '' }
            else if (silent && chunk.type === 'block-end' && chunk.block.type === 'text') {
              yield { ...chunk, block: { ...chunk.block, text: '' } }
            } else yield chunk
          }
        })
        ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
          if (signal.aborted || agent.session.header.parentSession !== undefined
            || !memoryEnabled.has(agent) || memoryTurn.get(agent) === turn) return
          // 每轮最多补一次整理，避免记忆更新再次触发自己。
          memoryTurn.set(agent, turn)
          agent.steer(createUserMessage({ source: { kind: 'erp-position-memory' }, content: [{ type: 'text', text:
            '本轮工作已结束，请整理岗位共同记忆：仅从本轮已核实的工作中识别同岗位需要共同记住的通用流程、约定和经验。按当前 ERP 岗位选择归属，先用 erp_position_memory_read 查重，有新增或纠正时用 erp_position_memory_update 自动合并发布，不需要询问确认。首次读取 document_id=null 且 can_update=true 时，本轮若已检索到可读的正式岗位职责、制度或已核实约定，应调用 erp_position_memory_update 创建初始文档；不要求已经实际执行工作或产生新经验。初始正文包含岗位职责摘要、来源索引（文档名称和 document_id）、共同经验（暂无则待积累），只摘取目标岗位通用职责，不整篇复制制度，不把摘要当成新制度。不要记录个人信息、临时任务进度或推断；已有文档无新增内容或没有可靠来源时不写入。已有待发布版本时跳过且不覆盖，不要求用户处理正常等待。创建、提交、排队、解析、发布成功和无更新均静默，不在业务回答或结尾追加记忆维护报告。成功提交后交给后台发布，不为报告进度额外轮询，不让用户确认、等待或跟进；只有实际失败且需要用户介入时才简短说明影响和处理办法。用户主动询问状态时按真实状态回答，不展示内部状态码、版本号或任务细节，不重复业务回答。document_id=null 不能据此断言整个岗位库没有其他待处理版本。',
          }] }))
        })
        ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
          const assembly = await next()
          if (context.agent === undefined) return assembly
          const signal = context.signal ?? new AbortController().signal
          await this.requireErpCapability(DATA_CAPABILITY, signal)
          // 使用主进程当前绑定的身份；每次请求重新读取，不缓存上一位用户或旧岗位。
          const reply = await this.request({ kind: 'api', method: 'GET', path: '/api/ai/context/prompt', body: null }, signal)
          if (reply.error) throw new Error(reply.error)
          if (reply.status !== 200 || typeof reply.body !== 'string') {
            throw new Error('ERP 岗位提示读取失败，请确认服务和数据库已更新')
          }
          let value: unknown
          try { value = JSON.parse(reply.body) } catch { throw new Error('ERP 岗位提示响应无效') }
          if (!isRecord(value) || value.code !== 0 || !isRecord(value.data) || typeof value.data.prompt !== 'string') {
            throw new Error('ERP 岗位提示响应无效')
          }
          if (value.data.position_memory_enabled === true) memoryEnabled.add(context.agent)
          else memoryEnabled.delete(context.agent)
          return { ...assembly, sections: [...assembly.sections, {
            name: 'erp:user-context', text: value.data.prompt, interpolate: false,
          }] }
        })

        registerDesktopErp(ctx, {
          baseUrl: this.apiOrigin, timeoutMs: 30_000, maxResponseChars: 50_000, writeApprovalTimeoutMs: 300_000,
          skillSources, skillCatalogRefreshMs, knowledgeFiles: true,
        }, {
          request: async (url, init, signal) => {
            if (url.origin !== new URL(this.apiOrigin).origin || !safePath(url.pathname)
              || url.username || url.password) throw new Error('ERP API 地址无效')
            await this.requireErpCapability(DATA_CAPABILITY, signal)
            const reply = await this.request({ kind: 'api', method: init.method ?? 'GET', path: `${url.pathname}${url.search}`,
              body: typeof init.body === 'string' ? init.body : null }, signal)
            if (reply.error) throw new Error(reply.error)
            const status = reply.status
            if (typeof status !== 'number' || !Number.isSafeInteger(status) || typeof reply.body !== 'string') throw new Error('ERP API 响应无效')
            return new Response([204, 205, 304].includes(status) ? null : reply.body, { status })
          },
        })
      },
    }
  }

  /** Build the Loader entry that registers the internal ERP page navigation tool. */
  navigationPlugin() {
    return {
      name: 'erp-navigation',
      inject: ['tools'],
      apply: (ctx: Context): void => {
        ctx.effect(() => ctx.tools.register(defineTool({
          name: 'erp_open_page',
          description: 'Open an authorized ERP page. Read GET /api/auth/menus with erp_api, then use its stable menu_key. The backend resolves the current path and checks access. This tool navigates only.',
          parameters: {
            menu_key: { type: 'string', description: 'Stable menu_key returned by ERP menus; preferred over path.' },
            path: { type: 'string', description: 'ERP route from the current authorized menu; provide either menu_key or path.' },
            query: { type: 'object', additionalProperties: true, description: 'Optional primitive Vue Router query values.' },
            replace: { type: 'boolean', description: 'Replace the current history entry.' },
          },
          output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          timeoutMs: 32_000,
          execute: async (args, exec) => {
            if ((args.menu_key === undefined) === (args.path === undefined)) throw new Error('menu_key 和 path 必须且只能提供一个')
            if (args.menu_key !== undefined && (args.menu_key.length < 1 || args.menu_key.length > 128)) throw new Error('ERP 菜单标识无效')
            if (args.path !== undefined && !safePath(args.path)) throw new Error('只能打开 ERP 内部的绝对路由')
            await this.requireErpCapability(NAVIGATION_CAPABILITY, exec.signal)
            const target = await this.request({ kind: 'api', method: 'POST', path: '/api/harness/navigation',
              body: JSON.stringify({ ...(args.menu_key === undefined ? { path: args.path } : { menu_key: args.menu_key }),
                query: queryOf(args.query) }) }, exec.signal)
            if (target.error || target.status !== 200 || typeof target.body !== 'string') throw new Error('页面不存在或当前账号无权访问')
            let value: unknown
            try { value = JSON.parse(target.body) } catch { throw new Error('ERP 页面解析响应无效') }
            if (!isRecord(value) || value.code !== 0 || !isRecord(value.data)
              || typeof value.data.path !== 'string' || !safePath(value.data.path)) throw new Error('ERP 页面解析响应无效')
            const path = value.data.path
            const reply = await this.request({ kind: 'navigate', path,
              query: queryOf(value.data.query), replace: args.replace ?? false }, exec.signal)
            return { ok: reply.ok === true, requestedPath: path,
              ...(reply.actualPath === undefined ? {} : { actualPath: reply.actualPath }),
              ...(reply.error === undefined ? {} : { message: reply.error }) }
          },
          presentCall: args => ({ card: 'generic', title: `Open ERP ${args.menu_key ?? args.path}`,
            kind: 'read', rawInput: args }),
        })))
      },
    }
  }
}

/** Keep ERP tool entries in the Loader tree and follow authenticated ERP protocol capability negotiation.
 * @param ctx - Host context whose Loader owns the tool entries.
 * @param tools - Authenticated ERP tool transport.
 * @param skillSources - Skill roots to mount with the ERP data plugin.
 * @param pluginStateRefreshMs - Delay between authenticated ERP capability reads in milliseconds.
 * @returns When the initial tenant plugin state has been applied.
 */
export async function installErpDesktopTools(
  ctx: Context, tools: ErpDesktopTools, skillSources: SkillSourceConfig[], pluginStateRefreshMs: number,
): Promise<void> {
  if (!Number.isSafeInteger(pluginStateRefreshMs) || pluginStateRefreshMs < 1_000) {
    throw new Error('pluginStateRefreshMs must be an integer of at least 1000')
  }
  // 桌面启动配置只发送一次；入口须先于登录完成发布，读取仍由动态 ERP 提供器鉴权。
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: '__DSH_USER_CONTEXT_PATH__', value: '/api/erp-user-context' })
    table.push({ kind: 'global', name: '__DSH_KNOWLEDGE_BASES_PATH__', value: '/api/erp/knowledge-bases' })
  })
  // Personal settings use a fixed authenticated target, separate from model tools.
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/erp-user-context', methods: ['GET', 'POST'], requestBody: 'buffered',
      async fetch(request) {
        let body: string | null = null
        if (request.method === 'POST') {
          let value: unknown
          try { value = await request.json() } catch { return new Response(null, { status: 400 }) }
          if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.instructions !== 'string'
            || value.instructions.length > 2000) return new Response(null, { status: 400 })
          body = JSON.stringify({ instructions: value.instructions })
        }
        try {
          const reply = await tools.request({ kind: 'api', method: request.method === 'POST' ? 'PUT' : 'GET', path: '/api/ai/context/mine', body }, request.signal)
          if (reply.error || reply.status === undefined || reply.body === undefined) {
            return Response.json({ code: 502 }, { status: 502 })
          }
          return new Response(reply.body, { status: reply.status,
            headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
        } catch (error) {
          if (request.signal.aborted) throw error
          return Response.json({ code: 502 }, { status: 502 })
        }
      },
    }), 'erp-user-context: personal instructions')
  })
  // Human feedback has fixed ERP targets and never uses model tool execution.
  ctx.inject(['connection'], (scope) => {
    for (const [suffix, path] of [['submit', '/api/ai_control/feedback'], ['status', '/api/ai_control/feedback/status'],
      ['upload', '/api/ai_control/feedback/files'], ['discard', '/api/ai_control/feedback/files/discard']] as const) {
      scope.effect(() => scope.connection.fetch.register({
        path: `/api/erp-ai-control/${suffix}`, methods: ['POST'], requestBody: 'buffered',
        async fetch(request) {
          const body = await request.text()
          try {
            const reply = await tools.request({ kind: suffix === 'upload' ? 'feedback-image' : 'api', method: 'POST', path, body }, request.signal)
            if (reply.error || reply.status === undefined || reply.body === undefined) {
              return Response.json({ code: 502, message: 'ERP feedback request was not confirmed' }, { status: 502 })
            }
            return new Response(reply.body, { status: reply.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
          } catch (error) {
            if (request.signal.aborted) throw error
            return Response.json({ code: 502, message: 'ERP feedback request was not confirmed' }, { status: 502 })
          }
        },
      }), `erp-ai-control: ${suffix}`)
    }
  })
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/erp-ai-control/review', methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        try {
          const payload = completionReviewRequest(await request.json())
          const reply = await tools.request({ kind: 'feedback-review', path: '/api/llm-gateway/anthropic/v1/messages',
            body: JSON.stringify(payload) }, request.signal)
          if (reply.error || reply.status !== 200 || reply.body === undefined) {
            return reviewFailure(reply.status, /timeout|未及时/u.test(reply.error ?? ''))
          }
          const answer = JSON.parse(payload.messages[0].content) as { answer_snapshot: string }
          return Response.json({ code: 0, data: parseCompletionReview(JSON.parse(reply.body), answer.answer_snapshot) },
            { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
          if (request.signal.aborted) throw error
          return reviewFailure(502, error instanceof Error && /timeout|未及时/u.test(error.message))
        }
      },
    }), 'erp-ai-control: independent completion review')
  })
  ctx.loader.builtins[DATA_PLUGIN_KEY] = tools.dataPlugin(skillSources)
  ctx.loader.builtins[NAVIGATION_PLUGIN_KEY] = tools.navigationPlugin()
  const dataId = await ctx.loader.create({ name: `cordis:${DATA_PLUGIN_KEY}`, disabled: true })
  const navigationId = await ctx.loader.create({ name: `cordis:${NAVIGATION_PLUGIN_KEY}`, disabled: true })

  let disposed = false
  let currentRequest: AbortController | undefined
  let refreshing: Promise<void> | undefined
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (refreshing !== undefined) return refreshing
    const controller = new AbortController()
    currentRequest = controller
    const task = (async () => {
      try {
        const enabled = await tools.enabledErpCapabilities(controller.signal)
        if (disposed) return
        await Promise.all([
          (async () => {
            const disabled = !enabled.has(DATA_CAPABILITY)
            if (ctx.loader.resolve(dataId).options.disabled !== disabled) {
              await ctx.loader.update(dataId, { disabled })
            }
          })(),
          (async () => {
            const disabled = !enabled.has(NAVIGATION_CAPABILITY)
            if (ctx.loader.resolve(navigationId).options.disabled !== disabled) {
              await ctx.loader.update(navigationId, { disabled })
            }
          })(),
        ])
        await Promise.all([dataId, navigationId].map(async (id) => {
          await ctx.loader.resolve(id).fiber?.await()
        }))
      } catch (error) {
        if (disposed) return
        await Promise.all([
          ctx.loader.update(dataId, { disabled: true }),
          ctx.loader.update(navigationId, { disabled: true }),
        ])
        console.warn('ERP plugin state refresh failed; managed Harness plugins remain disabled', error)
      } finally {
        if (currentRequest === controller) currentRequest = undefined
      }
    })()
    refreshing = task.finally(() => { refreshing = undefined })
    return refreshing
  }

  ctx.effect(() => {
    const timer = setInterval(() => {
      void refresh().catch((error: unknown) => console.error('ERP plugin state refresh failed', error))
    }, pluginStateRefreshMs)
    return async () => {
      disposed = true
      clearInterval(timer)
      currentRequest?.abort()
      await refreshing
    }
  })
  await refresh()
}
