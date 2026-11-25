/** Host-side SSE navigation broker and model-facing page-opening tool. */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Config } from './config.ts'
import {
  NAVIGATION_ACK_PATH,
  NAVIGATION_EVENTS_PATH,
  isAllowedErpPath,
  type NavigationAck,
  type NavigationCommand,
  type NavigationQueryValue,
} from './navigation-contract.ts'

interface PendingNavigation {
  resolve: (ack: NavigationAck) => void
  reject: (error: unknown) => void
  timeout: ReturnType<typeof setTimeout>
  removeAbort: () => void
}

const MAX_ACK_BODY_BYTES = 16 * 1024

function normalizeQuery(value: unknown): Record<string, NavigationQueryValue> {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('query 必须是对象')
  }
  const query: Record<string, NavigationQueryValue> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' || item === null) {
      query[key] = item
      continue
    }
    throw new TypeError(`query.${key} 只允许字符串、数字、布尔值或 null`)
  }
  return query
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_ACK_BODY_BYTES) {
        reject(new Error('导航 ACK 请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function parseAck(value: unknown): NavigationAck {
  if (value === null || typeof value !== 'object') throw new TypeError('导航 ACK 必须是对象')
  const row = value as Record<string, unknown>
  if (typeof row.requestId !== 'string' || typeof row.ok !== 'boolean') {
    throw new TypeError('导航 ACK 缺少 requestId 或 ok')
  }
  if (row.actualPath !== undefined && typeof row.actualPath !== 'string') {
    throw new TypeError('导航 ACK actualPath 必须是字符串')
  }
  if (row.message !== undefined && typeof row.message !== 'string') {
    throw new TypeError('导航 ACK message 必须是字符串')
  }
  return {
    requestId: row.requestId,
    ok: row.ok,
    ...(row.actualPath === undefined ? {} : { actualPath: row.actualPath }),
    ...(row.message === undefined ? {} : { message: row.message }),
  }
}

/** One-process broker between model tool executions and connected Harness pages. */
export class ErpNavigationBroker {
  private readonly clients = new Set<ServerResponse>()
  private readonly pending = new Map<string, PendingNavigation>()

  constructor(private readonly timeoutMs: number) {}

  /** Attach one browser EventSource response until it disconnects. */
  connect(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(': connected\n\n')
    this.clients.add(res)
    res.once('close', () => { this.clients.delete(res) })
  }

  /** Resolve a pending command from an iframe acknowledgement. */
  acknowledge(ack: NavigationAck): boolean {
    const pending = this.pending.get(ack.requestId)
    if (pending === undefined) return false
    this.pending.delete(ack.requestId)
    clearTimeout(pending.timeout)
    pending.removeAbort()
    pending.resolve(ack)
    return true
  }

  /** Broadcast one command and wait for the embedded router result. */
  dispatch(command: NavigationCommand, signal: AbortSignal): Promise<NavigationAck> {
    if (signal.aborted) return Promise.reject(signal.reason ?? new Error('导航已取消'))
    for (const client of [...this.clients]) {
      if (client.destroyed || client.writableEnded) this.clients.delete(client)
    }
    if (this.clients.size === 0) {
      return Promise.resolve({
        requestId: command.requestId,
        ok: false,
        message: '没有已连接的 Harness 浏览器页面，请先打开 Harness Web 界面',
      })
    }

    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const pending = this.pending.get(command.requestId)
        if (pending === undefined) return
        this.pending.delete(command.requestId)
        clearTimeout(pending.timeout)
        reject(signal.reason ?? new Error('导航已取消'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      const timeout = setTimeout(() => {
        const pending = this.pending.get(command.requestId)
        if (pending === undefined) return
        this.pending.delete(command.requestId)
        pending.removeAbort()
        resolve({
          requestId: command.requestId,
          ok: false,
          message: `ERP 前端在 ${String(this.timeoutMs)}ms 内未确认导航`,
        })
      }, this.timeoutMs)
      const pending: PendingNavigation = {
        resolve,
        reject,
        timeout,
        removeAbort: () => { signal.removeEventListener('abort', onAbort) },
      }
      this.pending.set(command.requestId, pending)

      const frame = `data: ${JSON.stringify(command)}\n\n`
      for (const client of [...this.clients]) {
        try {
          client.write(frame)
        } catch {
          this.clients.delete(client)
        }
      }
    })
  }

  /** Close clients and reject all outstanding commands during plugin disposal. */
  dispose(): void {
    for (const client of this.clients) client.end()
    this.clients.clear()
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout)
      pending.removeAbort()
      pending.reject(new Error(`ERP 导航通道已关闭: ${requestId}`))
    }
    this.pending.clear()
  }
}

function sendJson(res: ServerResponse, status: number, body: object): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/** Register the navigation transport and model-facing tool. */
export function registerErpNavigation(ctx: Context, config: Config): () => void {
  const broker = new ErpNavigationBroker(config.navigationTimeoutMs)
  const disposeEvents = ctx.webServer.register({
    kind: 'exact',
    path: NAVIGATION_EVENTS_PATH,
    handler(req, res) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, message: 'Method Not Allowed' })
        return
      }
      broker.connect(res)
    },
  })
  try {
    const disposeAck = ctx.webServer.register({
      kind: 'exact',
      path: NAVIGATION_ACK_PATH,
      async handler(req, res) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, message: 'Method Not Allowed' })
          return
        }
        try {
          const ack = parseAck(await readJsonBody(req))
          if (!broker.acknowledge(ack)) {
            sendJson(res, 410, { ok: false, message: '导航请求已不存在' })
            return
          }
          res.statusCode = 204
          res.end()
        } catch (error) {
          sendJson(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) })
        }
      },
    })
    try {
      const disposeTool = ctx.tools.register(defineTool({
        name: 'erp_open_page',
        description: 'Open any page inside the embedded ERP without clicking UI elements. Use an absolute in-app route returned by the ERP menu or route metadata. Examples: /welcome, /students/list, /system/role/index, /system/user/index, /system/menu/index. This tool only navigates; use erp_api for reading or changing ERP data.',
        parameters: {
          path: { type: 'string', required: true, description: 'Absolute ERP frontend route beginning with /.' },
          query: { type: 'object', additionalProperties: true, description: 'Optional primitive Vue Router query values.' },
          replace: { type: 'boolean', description: 'Replace browser history instead of pushing a new entry.' },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        timeoutMs: config.navigationTimeoutMs + 2_000,
        async execute(args, exec) {
          if (!isAllowedErpPath(args.path)) {
            throw new Error('路径必须是ERP 内部的绝对路由，不能包含外部地址、查询串或片段')
          }
          const command: NavigationCommand = {
            requestId: randomUUID(),
            path: args.path,
            query: normalizeQuery(args.query),
            replace: args.replace ?? false,
          }
          const ack = await broker.dispatch(command, exec.signal)
          return {
            ok: ack.ok,
            requestedPath: command.path,
            ...(ack.actualPath === undefined ? {} : { actualPath: ack.actualPath }),
            ...(ack.message === undefined ? {} : { message: ack.message }),
          }
        },
        presentCall: args => ({
          card: 'generic',
          title: `Open ERP ${args.path}`,
          kind: 'read',
          rawInput: args,
        }),
      }))

      return () => {
        broker.dispose()
        disposeTool()
        disposeAck()
        disposeEvents()
      }
    } catch (error) {
      disposeAck()
      throw error
    }
  } catch (error) {
    broker.dispose()
    disposeEvents()
    throw error
  }
}
