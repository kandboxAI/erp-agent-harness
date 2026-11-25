import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { expect, it } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { ErpDesktopTools } from '../src/erp-desktop-tools.ts'

async function fixture(responses?: StreamChunk[][]) {
  const root = await mkdtemp(join(tmpdir(), 'desktop-erp-context-'))
  const ctx = new Context()
  const adapter = new MockAdapter(responses ?? Array.from({ length: 8 }, () => textResponse('已结合当前岗位回答。')))
  const state = { status: 200, body: JSON.stringify({ code: 0, data: { prompt: '当前岗位：一班班主任；任教语文。\n个人偏好：简洁回答，保留 {{literal}}。' } }) }
  const apiReply = { status: 200, body: JSON.stringify({ code: 0, data: { ok: true, status: 200,
    data: { document_id: 'existing-memory', content: '已有共同经验', can_update: true } } }), error: undefined as string | undefined }
  const requests: object[] = []
  const bridge = new ErpDesktopTools('https://erp.example.com', (message) => {
    requests.push(message)
    const row = message as { requestId: string; path: string }
    queueMicrotask(() => { bridge.accept(row.path === '/api/harness/api'
      ? { type: 'erp-tool-result', requestId: row.requestId, ...apiReply }
      : { type: 'erp-tool-result', requestId: row.requestId, status: row.path === '/api/plugins/ai-capabilities' ? 200 : state.status,
        body: row.path === '/api/plugins/ai-capabilities'
          ? JSON.stringify({ code: 0, data: { protocol_version: 1, capabilities: ['erp.data'] } }) : state.body }) })
  })
  const close = async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
  try {
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, {
      include: Include, llm: LlmRuntime, sessions: SessionStore, projections: SessionProjectionRegistry,
      system: SystemPrompt, tools: ToolRuntime, executor: NativeToolExecutor, skills: SkillRegistry, agents: AgentRegistry, loop: AgentLoop,
      'mock-model': { name: 'mock-model', inject: ['llm'], apply(scope: Context) {
        scope.effect(() => scope.llm.registerAdapter(['mock'], adapter))
      } },
      'erp-data': bridge.dataPlugin(),
    })
    const config = join(root, 'cordis.yml')
    await writeFile(config, [
      '- name: cordis:llm', '- name: cordis:sessions', '- name: cordis:projections',
      '- name: cordis:system', '  config:', '    includeHarnessIdentity: false', '    includeRuntimeContext: false',
      '    personaPrefix: 你是 ERP 助手。', '- name: cordis:tools', '- name: cordis:executor', '- name: cordis:skills',
      '- name: cordis:agents', '- name: cordis:loop', '  config:', '    agents: []',
      '- name: cordis:mock-model', '- name: cordis:erp-data', '',
    ].join('\n'))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    const agent = await ctx.agentLoop.create(SessionId('erp-context-snapshot'), { provider: 'mock', model: 'mock' })
    return { ctx, agent, adapter, state, apiReply, requests, close }
  } catch (error) {
    await close()
    throw error
  }
}

async function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

function systemTexts(request: GenerateOptions) {
  return request.messages.filter(message => message.role === 'system').map(message => message.content)
}

it('records current ERP identity in real Loader sessions, refreshes it, and removes it on plugin disposal', async () => {
  const h = await fixture()
  try {
    expect(renderPrompt(await h.ctx.systemPrompt.assemble())).toBe('你是 ERP 助手。')
    expect(h.requests).toHaveLength(0)
    await send(h.agent, '请帮我写班级通知')
    expect(h.adapter.requests).toHaveLength(1)
    expect(JSON.stringify(systemTexts(h.adapter.requests[0]!))).toContain('{{literal}}')
    h.state.body = JSON.stringify({ code: 0, data: { prompt: '当前岗位：二班班主任；任教数学。\n个人偏好：先给通知正文。' } })
    await send(h.agent, '现在的岗位是什么')
    expect(h.adapter.requests).toHaveLength(2)
    const second = JSON.stringify(systemTexts(h.adapter.requests[1]!))
    expect(second).toContain('二班班主任')
    expect(second).not.toContain('一班班主任')
    const replay = Session.create(h.agent.id, h.agent.session.snapshotEvents())
    expect(systemTexts(h.adapter.requests[1]!)).toEqual(replay.deriveMessages().filter(message => message.role === 'system').map(message => message.content))
    const data = [...h.ctx.loader.entries()].find(entry => entry.options.name === 'cordis:erp-data')
    expect(data).toBeDefined()
    await data!.fiber!.dispose()
    await send(h.agent, '继续')
    expect(h.adapter.requests).toHaveLength(3)
    expect(JSON.stringify(systemTexts(h.adapter.requests[2]!))).not.toContain('当前岗位')
    const snapshot = h.adapter.requests.map(systemTexts)
    await expect(JSON.stringify(snapshot, null, 2) + '\n').toMatchFileSnapshot('./expected/erp-user-context/session.expected.json')
    expect(h.requests.filter(row => 'path' in row && row.path === '/api/ai/context/prompt')).toHaveLength(2)
    expect(h.requests.every(row => !('authorization' in row) && !('accessToken' in row))).toBe(true)
  } finally { await h.close() }
})

it.each([
  { status: 503, body: '{}', message: '读取失败' },
  { status: 200, body: 'invalid json', message: '响应无效' },
  { status: 200, body: '{"code":0,"data":{"instructions":"raw personal data"}}', message: '响应无效' },
  { status: 200, body: '{"code":1,"data":{"prompt":"stale identity"}}', message: '响应无效' },
])('rejects an unavailable or invalid ERP context without reusing an old identity: $body', async (response) => {
  const h = await fixture()
  try {
    await send(h.agent, 'first')
    Object.assign(h.state, response)
    await expect(h.ctx.systemPrompt.assemble({ agent: h.agent, scope: h.agent, signal: new AbortController().signal }))
      .rejects.toThrow(response.message)
    expect(h.adapter.requests).toHaveLength(1)
  } finally { await h.close() }
})


it('automatically consolidates position memory once per turn only for eligible members', async () => {
  const h = await fixture()
  try {
    h.state.body = JSON.stringify({ code: 0, data: { prompt: '岗位：数学教师；position_id=verified-position', position_memory_enabled: true } })
    await send(h.agent, '我的工作职责：已查到正式岗位制度，但岗位工作.md 尚不存在')
    expect(h.adapter.requests).toHaveLength(2)
    const consolidation = JSON.stringify(h.adapter.requests[1]!.messages)
    expect(consolidation).toContain('erp_position_memory_update 自动合并发布')
    expect(consolidation).toContain('应调用 erp_position_memory_update 创建初始文档')
    expect(consolidation).toContain('不要求已经实际执行工作或产生新经验')
    expect(consolidation).toContain('创建、提交、排队、解析、发布成功和无更新均静默')
    expect(consolidation).toContain('不为报告进度额外轮询')
    expect(h.agent.session.snapshotEvents().filter(event => event.type === 'turn/end')).toHaveLength(1)
    await send(h.agent, '下一项工作')
    expect(h.adapter.requests).toHaveLength(4)
    h.state.body = JSON.stringify({ code: 0, data: { prompt: '已离岗', position_memory_enabled: false } })
    await send(h.agent, '现在不再有岗位知识资格')
    expect(h.adapter.requests).toHaveLength(5)
    const data = [...h.ctx.loader.entries()].find(entry => entry.options.name === 'cordis:erp-data')
    await data!.fiber!.dispose()
    expect(h.ctx.tools.get('erp_position_memory_update')).toBeUndefined()
    await send(h.agent, '插件已停用')
    expect(h.adapter.requests).toHaveLength(6)
  } finally { await h.close() }
})

it.each([false, true])('silences automatic position memory reports while preserving tools and explicit status answers: update=%s', async (update) => {
  const read = toolCallResponse('memory-read', 'erp_position_memory_read', { position_id: 'verified-position' })
  const write = toolCallResponse('memory-write', 'erp_position_memory_update', {
    position_id: 'verified-position', source_hash_snapshot: 'a'.repeat(64),
    replacements: [{ before: '已有共同经验', after: '已有共同经验和新约定' }],
  })
  const h = await fixture([
    textResponse('你好！'), read, ...update ? [write] : [], textResponse('本轮无需更新或已提交记忆。'),
    textResponse('当前记忆状态如下。'), textResponse('再次维护完成。'),
  ])
  try {
    h.state.body = JSON.stringify({ code: 0, data: { prompt: '岗位：班主任', position_memory_enabled: true } })
    const streamedText: string[] = []
    h.ctx.on('agent/assistant-stream', ({ frame }) => {
      if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') streamedText.push(frame.chunk.text)
    })
    await send(h.agent, 'hi')
    expect(h.requests.filter(row => 'path' in row && row.path === '/api/harness/api')).toHaveLength(update ? 2 : 1)
    expect(streamedText.join('')).toBe('你好！')
    const messages = h.agent.session.deriveMessages()
    const replay = Session.create(h.agent.id, h.agent.session.snapshotEvents())
    expect(replay.deriveMessages()).toEqual(messages)
    const calls = messages.filter(message => message.role === 'assistant').flatMap(message => message.content.filter(block => block.type === 'tool-call'))
    expect(calls.map(call => call.name)).toEqual(['erp_position_memory_read', ...update ? ['erp_position_memory_update'] : []])
    expect(messages.at(-1)?.content).toEqual([{ type: 'text', text: '' }])
    await send(h.agent, '岗位记忆现在是什么状态？')
    const replies = h.agent.session.deriveMessages().filter(message => message.role === 'assistant')
      .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).filter(Boolean)
    await expect(JSON.stringify(replies, null, 2) + '\n').toMatchFileSnapshot('./expected/erp-user-context/memory-replies.expected.json')
  } finally { await h.close() }
})

it.each(['api', 'transport'])('preserves actionable position memory failures: %s', async (failure) => {
  const h = await fixture([
    textResponse('你好！'),
    toolCallResponse('memory-read', 'erp_position_memory_read', { position_id: 'verified-position' }),
    textResponse('岗位记忆读取失败，请检查 ERP 服务。'),
  ])
  try {
    h.state.body = JSON.stringify({ code: 0, data: { prompt: '岗位：班主任', position_memory_enabled: true } })
    if (failure === 'transport') h.apiReply.error = 'ERP 客户端未及时响应'
    else Object.assign(h.apiReply, { status: 503, body: JSON.stringify({ code: 0, data: { ok: false, status: 503, data: null } }) })
    await send(h.agent, 'hi')
    const messages = h.agent.session.deriveMessages()
    expect(messages.at(-1)?.content).toEqual([{ type: 'text', text: '岗位记忆读取失败，请检查 ERP 服务。' }])
    expect(messages.filter(message => message.role === 'tool').map(message => message.isError)).toEqual([failure === 'transport'])
  } finally { await h.close() }
})
