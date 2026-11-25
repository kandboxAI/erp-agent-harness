/** ERP Desktop composition must mount enterprise feedback and remove native feedback entry points. */
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { composeEntries, createRuntimeResolution, loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'

function readLayer(path: string) {
  const patches = loadOptionalPatches('erp-feedback-test', fileURLToPath(new URL(path, import.meta.url)))
  if (patches === undefined) throw new Error(`Missing composition layer: ${path}`)
  return patches
}

it('inserts enterprise feedback and disables native feedback only in the ERP desktop overlay', () => {
  const base = readLayer('../../../packages/bundle/base/cordis.patch.yml')
  const web = readLayer('../../../packages/bundle/web-app/cordis.patch.yml')
  const erp = readLayer('../erp-llm.patch.yml')
  const warnings: string[] = []
  const normal = composeEntries([base, web], warning => warnings.push(warning))
  const desktop = composeEntries([base, web, erp], warning => warnings.push(warning))
  expect(warnings).toEqual([])
  expect(desktop.filter(row => row.id === 'enterprise-ai-feedback')).toMatchObject([
    { name: '@deepseek-ai/dsh-client-ui-ai-control' },
  ])
  expect(desktop.find(row => row.id === 'enterprise-ai-feedback')?.disabled).not.toBe(true)
  for (const id of ['ui-message-feedback', 'command-feedback', 'message-feedback']) {
    expect(normal.find(row => row.id === id)).toBeDefined()
    expect(normal.find(row => row.id === id)?.disabled).not.toBe(true)
    expect(desktop.find(row => row.id === id)?.disabled).toBe(true)
  }
  expect(normal.some(row => row.id === 'enterprise-ai-feedback')).toBe(false)
})


it('resolves the enterprise plugin from the Desktop Host installation dependency closure', async () => {
  const installAnchor = fileURLToPath(new URL('../package.json', import.meta.url))
  const resolution = await createRuntimeResolution({ installAnchor })
  expect(resolution.entries.find(entry => entry.name === '@deepseek-ai/dsh-client-ui-ai-control'))
    .toMatchObject({ scope: 'installation', declarer: installAnchor })
})
