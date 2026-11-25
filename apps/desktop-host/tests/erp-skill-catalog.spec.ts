import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, it, vi } from 'vitest'
import { SessionSkillCatalog } from '../../../packages/api/session-controller/src/skill-catalog.ts'
import { ErpDesktopTools } from '../src/erp-desktop-tools.ts'

it('shows tenant-enabled business skills in the picker and removes them after deactivation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'erp-skill-catalog-'))
  let ctx: Context | undefined
  let active = true
  const sessionId = SessionId('erp-skill-picker')
  const bridge = new ErpDesktopTools('https://erp.example.com', (message) => {
    const request = message as { requestId: string; path: string }
    const data = request.path === '/api/plugins/ai-capabilities'
      ? { protocol_version: 1, capabilities: ['erp.data'] }
      : { enabled_skill_keys_by_plugin: active ? { edu: ['edu-report'] } : {} }
    queueMicrotask(() => bridge.accept({ type: 'erp-tool-result', requestId: request.requestId,
      status: 200, body: JSON.stringify({ code: 0, data }) }))
  })
  try {
    for (const name of ['edu-report', 'undeclared-report']) {
      const directory = join(root, name)
      await mkdir(directory)
      await writeFile(join(directory, 'SKILL.md'),
        `---\nname: ${name}\ndescription: Prepare a monthly report.\n---\nUse approved ERP data.\n`)
    }
    const config = fileURLToPath(new URL('./fixtures/erp-skills.cordis.yml', import.meta.url))
    ctx = await boot('erp-skill-catalog-test', config, [], (ctx) => {
      Object.assign(ctx.loader.builtins, {
        'system-prompt': SystemPrompt, tools: ToolRuntime, skills: SkillRegistry,
        sessions: SessionStore, agents: AgentRegistry,
        'session-projections': SessionProjectionRegistry, 'session-query': SqliteSessionQueryEngine,
        'erp-data': bridge.dataPlugin([
          { pluginKey: 'edu', customSkillDirs: [], bundledSkillDir: root },
        ], 1_000),
      })
    })
    ctx.sessions.create(sessionId, { meta: { cwd: root } })
    ctx.skills.register({ name: 'office-common', source: 'runtime', description: 'Create an Office document.',
      content: 'Use the shared Office tools.' })
    const catalog = new SessionSkillCatalog(ctx)
    const signal = new AbortController().signal
    const names = async (): Promise<string[]> => (await catalog.list({ sessionId }, signal)).skills.map(skill => skill.name)

    expect((await catalog.list({ sessionId }, signal)).skills.map(({ name, description, modelInvocable }) =>
      ({ name, description, modelInvocable }))).toMatchInlineSnapshot(`
      [
        {
          "description": "Prepare a monthly report.",
          "modelInvocable": true,
          "name": "edu-report",
        },
        {
          "description": "Create an Office document.",
          "modelInvocable": true,
          "name": "office-common",
        },
      ]
    `)
    active = false
    expect(await ctx.skills.get('edu-report', { sessionId, cwd: root })).toBeUndefined()
    await vi.waitFor(async () => { expect(await names()).toEqual(['office-common']) }, { timeout: 2_000 })
    active = true
    await vi.waitFor(async () => { expect(await names()).toEqual(['edu-report', 'office-common']) }, { timeout: 2_000 })
    expect(ctx.agents.list()).toEqual([])
  } finally {
    await ctx?.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
