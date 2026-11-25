import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ErpLlmGatewayRoute } from '../src/erp-llm-gateway.ts'

let ctx: Context

beforeEach(async () => {
  ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(new ErpLlmGatewayRoute('http://127.0.0.1:8000', 'erp-test').plugin())
})

afterEach(async () => { await ctx.fiber.dispose() })

it('recognizes the saved official route and moves its next request onto the ERP gateway', async () => {
  await expect(ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-flash'))
    .resolves.toMatchObject({ provider: 'deepseek-official', id: 'deepseek-flash' })
  const proposal = await ctx.waterfall(ctx as never, 'agent/request', {
    agent: {} as never, turn: 1, step: 1, signal: new AbortController().signal,
  }, () => Promise.resolve({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }))
  expect(proposal).toMatchObject({ provider: 'erp-gateway', model: 'deepseek-flash' })
  await expect(ctx.llm.prepareCall(proposal)).resolves.toMatchObject({
    config: { provider: 'erp-gateway', model: 'deepseek-flash' },
  })
})

it('keeps the gateway route for new sessions', async () => {
  const proposal = await ctx.waterfall(ctx as never, 'agent/request', {
    agent: {} as never, turn: 1, step: 1, signal: new AbortController().signal,
  }, () => Promise.resolve({ provider: 'erp-gateway', model: 'deepseek-flash' }))
  expect(proposal).toEqual({ provider: 'erp-gateway', model: 'deepseek-flash' })
  await expect(ctx.llm.resolveModelInfo('erp-gateway', 'deepseek-flash'))
    .resolves.toMatchObject({ defaultMaxTokens: 393_216 })
})
