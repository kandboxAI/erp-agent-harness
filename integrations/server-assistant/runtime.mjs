/** Server-only ERP tools and model gateway; credentials remain outside session logs. */
import { registerDesktopErp } from '@deepseek-ai/dsh-tool-erp'
import { registerDeepSeekProvider, resolveAdapterOptions, catalogModelInfo } from '@deepseek-ai/dsh-llm-deepseek'
import z from '@deepseek-ai/schemastery'

export const name = 'erp-server-runtime'
export const inject = ['tools', 'llm', 'approval']
export const Config = z.object({
  baseUrl: z.string().required(),
  gatewayUrl: z.string().required(),
  model: z.string().required(),
  timeoutMs: z.number().min(1000).required(),
  maxResponseChars: z.number().min(1000).required(),
})

/** Load authenticated ERP tools and forward write confirmations to the current user. */
export function apply(ctx, config) {
  const accessToken = process.env.ERP_SERVER_ACCESS_TOKEN
  const gatewayToken = process.env.ERP_SERVER_GATEWAY_TOKEN
  const clientId = process.env.ERP_SERVER_CLIENT_ID
  const approvalToken = process.env.ERP_SERVER_APPROVAL_TOKEN
  const runId = process.env.ERP_SERVER_RUN_ID
  const sessionId = process.env.ERP_SERVER_SESSION_ID
  if (!accessToken || !gatewayToken || !clientId || !approvalToken || !runId || !sessionId) throw new Error('服务端智能体缺少当前用户凭据')
  const origin = new URL(config.baseUrl).origin
  const gatewayUrl = new URL(config.gatewayUrl)
  if (gatewayUrl.origin !== origin) throw new Error('模型网关必须使用同一个 ERP 服务')
  ctx.on('approval/request', async (request, next) => {
    if (request.toolName !== 'erp_api') return next()
    const preview = request.displayReason?.zh ?? request.displayReason?.['zh-CN']
    if (typeof preview !== 'string' || !preview || preview.length > 8192) return 'unavailable'
    try {
      const response = await fetch(new URL('/api/ai/internal/write-approval', config.baseUrl), {
        method: 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${accessToken}`, 'x-erp-approval-token': approvalToken,
          'content-type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, run_id: runId, preview }),
        signal: request.signal,
      })
      if (!response.ok) return 'unavailable'
      const result = await response.json()
      return ['allowed-once', 'rejected'].includes(result?.data?.outcome) ? result.data.outcome : 'unavailable'
    } catch {
      return 'unavailable'
    }
  })
  registerDesktopErp(ctx, {
    ...config, writeApprovalTimeoutMs: Number(process.env.ERP_SERVER_APPROVAL_TIMEOUT_MS || 90000),
    // This server profile does not mount filesystem skill providers.
    skillSources: [], skillCatalogRefreshMs: 15_000,
  }, {
    request(url, init, signal) {
      if (url.origin !== origin || !['/api/harness/api', '/api/harness/query', '/api/harness/discovery', '/api/harness/write-approval'].includes(url.pathname)) {
        throw new Error('服务端智能体只允许使用 ERP 数据工具')
      }
      if (typeof init.body === 'string') {
        const args = JSON.parse(init.body)
        if (args.operation === 'catalog' || args.path === '/api/harness/catalog') {
          throw new Error('请按问题使用 erp_discover search 和 describe，不加载全量目录')
        }
      }
      const headers = new Headers(init.headers)
      headers.set('authorization', `Bearer ${accessToken}`)
      headers.set('x-harness-server-assistant', '1')
      return fetch(url, { ...init, headers, redirect: 'error', signal })
    },
  })
  const provider = 'erp-gateway'
  const options = () => resolveAdapterOptions({ baseURL: config.gatewayUrl,
    models: [{ id: config.model, inputModalities: ['text'] }], streamIdleTimeoutMs: config.timeoutMs })
  registerDeepSeekProvider(ctx, provider, {
    options, providerName: 'DeepSeek Harness',
    resolveAuth: async () => ({ headers: { 'x-api-key': gatewayToken, 'x-erp-client-id': clientId } }),
    discoverModels: () => Promise.resolve(options().models.map(model => catalogModelInfo(provider, model))),
  })
}
