/** Recorded model replay with external ERP authorization and native-navigation replies. */
import { ErpDesktopTools } from '../../../apps/desktop-host/src/erp-desktop-tools.ts'
import { installLlmReplay } from '../../../packages/test-support/llm-replay/src/index.ts'

export const name = 'erp-navigation-fixture'
export const inject = ['tools', 'llm']
export async function apply(ctx) {
  const replay = installLlmReplay(ctx, { file: process.env.DSH_SNAPSHOT_FILE,
    providers: [{ id: 'erp-replay', name: 'ERP replay', models: [{ id: 'erp-fixture' }] }] })
  let opened = 0
  const bridge = new ErpDesktopTools('https://erp.example.com', (request) => {
    let reply
    if (request.path === '/api/plugins/ai-capabilities') {
      reply = { status: 200, body: JSON.stringify({ code: 0, data: { protocol_version: 1, capabilities: ['erp.navigation'] } }) }
    } else if (request.path === '/api/harness/navigation') {
      if (JSON.parse(request.body).menu_key !== 'MesWorkOrders') throw new Error('Unexpected ERP menu')
      reply = { status: opened === 0 ? 200 : 404,
        body: JSON.stringify({ code: 0, data: { path: '/factory/orders', query: {} } }) }
    } else if (request.kind === 'navigate' && request.path === '/factory/orders') {
      opened += 1
      reply = { ok: true, actualPath: '/factory/orders' }
    } else throw new Error('Unexpected ERP navigation request')
    queueMicrotask(() => bridge.accept({ type: 'erp-tool-result', requestId: request.requestId, ...reply }))
  })
  await ctx.plugin(bridge.navigationPlugin())
  ctx.effect(() => () => {
    replay.assertConsumed()
    replay.dispose()
    if (opened !== 1) throw new Error('Revoked ERP navigation reached the native window')
  })
}
