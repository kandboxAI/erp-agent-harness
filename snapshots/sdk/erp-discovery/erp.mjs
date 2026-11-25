/** Fixed model replay and external ERP responses for the real ERP tool in the shipped SDK profile. */
import { registerDesktopEducationErp } from '../../../packages/integration/tool-education-erp/src/index.ts'
import { installLlmReplay } from '../../../packages/test-support/llm-replay/src/index.ts'

export const name = 'erp-discovery-fixture'
export const inject = ['tools', 'llm']
export function apply(ctx) {
  const replay = installLlmReplay(ctx, { file: process.env.DSH_SNAPSHOT_FILE,
    providers: [{ id: 'erp-replay', name: 'ERP replay', models: [{ id: 'erp-fixture' }] }] })
  ctx.effect(() => () => { replay.assertConsumed(); replay.dispose() })
  registerDesktopEducationErp(ctx, { baseUrl: 'https://erp.example.com', timeoutMs: 30_000, maxResponseChars: 50_000,
    writeApprovalTimeoutMs: 300_000, skillSources: [], skillCatalogRefreshMs: 15_000 }, {
    async request(url, init) {
      if (url.pathname !== '/api/harness/discovery' || init.method !== 'POST') throw new Error('Unexpected ERP request')
      const args = JSON.parse(init.body)
      let data
      if (args.action === 'search' && args.question === '教师学历结构') {
        data = { candidates: [{ id: 'resource:education.instructor', kind: 'resource', label: '教师档案', summary: '教师学历、职称和类型' }] }
      } else if (args.action === 'describe' && args.catalog_revision === 'sha256:fixture' && args.ids.length === 1
        && args.ids[0] === 'resource:education.instructor') {
        data = { definitions: [{ id: args.ids[0], label: '教师档案', fields: [{ name: 'education_level', description: '学历' }],
          grain: '一条教师档案', execution: { tool: 'education_erp_query', resource: 'education.instructor', operation: 'query' } }] }
      } else throw new Error('Unexpected ERP discovery arguments')
      return Response.json({ code: 0, data: { discovery_contract_version: 1, catalog_revision: 'sha256:fixture', ...data } })
    },
  })
}
