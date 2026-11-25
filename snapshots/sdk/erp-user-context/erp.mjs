/** Recorded model replay with current-user ERP context supplied over Desktop IPC. */
import { ErpDesktopTools } from '../../../apps/desktop-host/src/erp-desktop-tools.ts'
import { installLlmReplay } from '../../../packages/test-support/llm-replay/src/index.ts'

export const name = 'erp-user-context-fixture'
export const inject = ['tools', 'llm']
export async function apply(ctx) {
  const replay = installLlmReplay(ctx, { file: process.env.DSH_SNAPSHOT_FILE,
    providers: [{ id: 'erp-replay', name: 'ERP replay', models: [{ id: 'erp-fixture' }] }] })
  const prompt = '当前用户是一班班主任，本学期教授语文。\n个人回答偏好：中文、简洁；通知先给出可直接发送的正文。'
  let reads = 0
  const bridge = new ErpDesktopTools('https://erp.example.com', (request) => {
    let data
    if (request.path === '/api/plugins/ai-capabilities') {
      data = { protocol_version: 1, capabilities: ['erp.data'] }
    } else if (request.path === '/api/ai/context/prompt' && request.method === 'GET' && request.body === null) {
      reads += 1
      data = { prompt }
    } else throw new Error('Unexpected ERP user-context request')
    queueMicrotask(() => bridge.accept({ type: 'erp-tool-result', requestId: request.requestId,
      status: 200, body: JSON.stringify({ code: 0, data }) }))
  })
  await ctx.plugin(bridge.dataPlugin())
  ctx.on('llm/stream', (request, next) => {
    const systems = request.messages.filter(message => message.role === 'system')
    if (!JSON.stringify(systems).includes(prompt.replaceAll('\n', '\\n'))) throw new Error('Current ERP context missing from model request')
    return next()
  })
  ctx.effect(() => () => {
    replay.assertConsumed()
    replay.dispose()
    if (reads !== 1) throw new Error('ERP user context was not read for the model request')
  })
}
