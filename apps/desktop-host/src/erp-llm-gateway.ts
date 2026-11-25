/** ERP Desktop's model route. The upstream provider key exists only on ERP's server. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { catalogModelInfo, registerDeepSeekProvider, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'

const ERP_PROVIDER = 'erp-gateway'
const ERP_MODEL = 'deepseek-flash'
const LEGACY_PROVIDER = 'deepseek-official'
// DeepSeek-V4.1-Flash accepts at most 384K output tokens per request.
const ERP_MAX_OUTPUT_TOKENS = 393_216

/** ERP owns one server-backed route, including sessions saved before gateway mode existed. */
export function erpCallConfig(config: LlmCallConfig): LlmCallConfig {
  if (config.provider === ERP_PROVIDER && config.model === ERP_MODEL) return config
  return { ...config, provider: ERP_PROVIDER, model: ERP_MODEL }
}

export class ErpLlmGatewayRoute {
  private token: string | undefined

  constructor(private readonly apiOrigin: string, private readonly clientId: string) {
    const url = new URL(apiOrigin)
    if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:'
      && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
      throw new Error('ERP LLM gateway requires HTTPS or local development HTTP')
    }
  }

  setToken(token: string | null): void {
    this.token = token === null ? undefined : token
  }

  plugin() {
    return {
      name: 'erp-llm-gateway',
      inject: ['llm'],
      apply: (ctx: Context): void => {
        const options = () => resolveAdapterOptions({
          baseURL: `${this.apiOrigin.replace(/\/+$/u, '')}/api/llm-gateway/anthropic`,
          maxTokens: ERP_MAX_OUTPUT_TOKENS,
          models: [{ id: ERP_MODEL, name: 'DeepSeek Harness', maxTokens: ERP_MAX_OUTPUT_TOKENS, inputModalities: ['text', 'image'] }],
        })
        ctx.llm.registerConfigurableProviders([
          { provider: ERP_PROVIDER, displayName: 'DeepSeek Harness', settingsNs: 'erp-llm-gateway', settingsPath: [] },
        ])
        const resolveAuth = async () => {
          if (!this.token) throw new LlmError('请先登录 ERP，再使用智能体', 'MISSING_CREDENTIAL')
          return { headers: { 'x-api-key': this.token, 'x-erp-client-id': this.clientId } }
        }
        for (const provider of [ERP_PROVIDER, LEGACY_PROVIDER]) {
          registerDeepSeekProvider(ctx, provider, {
            options,
            providerName: 'DeepSeek Harness',
            resolveAuth,
            discoverModels: () => Promise.resolve(options().models.map(model => catalogModelInfo(provider, model))),
          })
        }
        // Old request headers and pending model selections can outlive a changed
        // default. Rewrite the actual request before adapter lookup; the request
        // header records the gateway route even for a restored session.
        ctx.on('agent/request', async (_request, next) => erpCallConfig(await next()))
      },
    }
  }
}
