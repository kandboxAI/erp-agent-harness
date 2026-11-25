import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as DomainStorage from '@deepseek-ai/dsh-storage-domain'
import UserQuestions, { type AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import * as FileTools from '@deepseek-ai/dsh-tool-fs'
import { registerKnowledgeFiles } from '../src/knowledge-files.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const baseId = '01900000-0000-7000-8000-000000000001'
const documentId = '01900000-0000-7000-8000-000000000002'
const versionId = '01900000-0000-7000-8000-000000000003'

async function assembled(root: string, choose: () => string, uncertain: boolean | string = false) {
  const file = join(root, 'policy.md')
  const questions: AskUserQuestionItem[] = []
  const calls: { path: string; confirmed: boolean; content?: string; attachment?: string }[] = []
  let reviewed = false
  const yaml = join(root, 'cordis.yml')
  await writeFile(yaml, [
    "- name: 'cordis:test-runtime'",
    "- name: 'cordis:test-storage'", "- name: 'cordis:test-json'", `  config: { root: ${JSON.stringify(join(root, 'storage'))} }`,
    "- name: 'cordis:test-domain'", '  config: { backend: json }', "- name: 'cordis:test-questions'",
    "- name: 'cordis:test-file-tools'", "- name: 'cordis:test-knowledge-files'", '',
  ].join('\n'))
  const ctx = await boot('knowledge-file-test', yaml, [], (ctx) => {
    ctx.loader.builtins['test-runtime'] = { name: 'test-runtime', apply: (scope: Context) => mountAgentLoopTestDependencies(scope, { workingDirectory: true }) }
    ctx.loader.builtins['test-storage'] = Storage
    ctx.loader.builtins['test-json'] = JsonStorage
    ctx.loader.builtins['test-domain'] = DomainStorage
    ctx.loader.builtins['test-questions'] = UserQuestions
    ctx.loader.builtins['test-file-tools'] = FileTools
    ctx.loader.builtins['test-knowledge-files'] = { name: 'test-knowledge-files', inject: ['tools'], apply(scope: Context) {
      registerKnowledgeFiles(scope, async (request, _exec, confirmed = false) => {
        calls.push({ path: request.path, confirmed,
          ...request.body.content === undefined ? {} : { content: request.body.content },
          ...request.body.content_base64 === undefined ? {} : { attachment: request.body.content_base64 },
        })
        if (request.path.endsWith('/documents/manual') || request.path.endsWith('/documents/upload')) {
          if (uncertain === true || uncertain === request.body.content) throw new Error('network result unknown')
          return { ok: true, data: { document_id: documentId, version_id: versionId, status_code: 'draft' } }
        }
        if (request.path === '/api/knowledge/version-status') return { ok: true, data: {
          knowledge_base_id: baseId, edit_token: reviewed ? null : 'a'.repeat(64),
          versions: [{ version_id: versionId, content_hash_snapshot: 'a'.repeat(64), status_code: reviewed ? 'review' : 'draft' }],
        } }
        if (request.path.endsWith('/submit')) reviewed = true
        return { ok: true, data: null }
      })
    } }
  })
  contexts.push(ctx)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('knowledge-files-session'), {}, { cwd: root })
  await expect.poll(() => ctx.tools.get('erp_knowledge_bind_file'), { timeout: 5000 }).toBeDefined()
  ctx.on('user-questions/request', (request) => {
    questions.push(...request.questions)
    return Promise.resolve({ answers: request.questions.map(item => ({ id: item.id, selected: [choose()] })) })
  })
  let call = 0
  const run = async (name: string, args: object) => {
    const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', name, arguments: JSON.stringify(args),
      id: ToolCallId(`knowledge-file-${++call}`) }], agent, signal: AbortSignal.timeout(10_000) })
    return batch.results[0]!.result
  }
  const bind = () => run('erp_knowledge_bind_file', { path: file, knowledge_base_id: baseId, document_name: '学生工作制度' })
  return { ctx, file, run, bind, questions, calls }
}

it('loads file contributions through the app Loader, keeps defer quiet across restart and removes registrations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-files-')); roots.push(root)
  await writeFile(join(root, 'policy.md'), '# 已校对的本地正文\n')
  const first = await assembled(root, () => '暂不提交')
  const bound = await first.bind()
  expect(bound.isError, JSON.stringify(bound)).toBe(false)
  const decision = await first.run('erp_knowledge_check_file', { path: first.file })
  expect(decision.isError).toBe(false)
  expect(first.questions.map(item => ({ header: item.header, question: item.question, choices: item.options?.map(option => option.label) }))).toMatchInlineSnapshot(`
    [
      {
        "choices": [
          "提交审核",
          "只保存草稿",
          "暂不提交",
        ],
        "header": "知识修订",
        "question": "是否将“学生工作制度”保存到知识库并提交审核？",
      },
    ]
  `)
  expect(first.calls).toEqual([])
  const tools = first.ctx.tools
  await first.ctx.fiber.dispose()
  expect(tools.get('erp_knowledge_check_file')).toBeUndefined()
  const second = await assembled(root, () => '提交审核')
  const unchanged = await second.run('erp_knowledge_check_file', { path: second.file })
  expect(unchanged.isError).toBe(false)
  expect(unchanged.content).toEqual([{ type: 'text', text: '{"state":"unchanged","document_id":null}' }])
  expect(second.questions).toEqual([])
})

it('submits the captured candidate only after the human decision and checks later file-tool writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-files-')); roots.push(root)
  await writeFile(join(root, 'policy.md'), '# 第一版本\n')
  let choice = '暂不提交'
  const test = await assembled(root, () => choice)
  await test.bind()
  await test.run('erp_knowledge_check_file', { path: test.file })
  choice = '提交审核'
  const edited = await test.run('write', { file_path: test.file, content: '# 第二版本\n' })
  expect(edited.isError, JSON.stringify(edited)).toBe(false)
  expect(test.questions).toHaveLength(2)
  expect(test.questions[1]?.detail).toContain('# 第二版本')
  expect(test.questions[1]?.detail).not.toMatch(/SHA-256|policy\.md/)
  expect(test.calls.filter(call => call.content !== undefined)).toEqual([
    { path: `/api/knowledge/bases/${baseId}/documents/manual`, confirmed: true, content: '# 第二版本\n' },
  ])
  expect(test.calls.some(call => call.path.endsWith('/submit') && call.confirmed)).toBe(true)
  expect(edited.content.some(block => block.type === 'text' && block.text.includes('"state":"review"'))).toBe(true)
})

it('keeps an uncertain creation from being recreated by checking or rebinding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-files-')); roots.push(root)
  await writeFile(join(root, 'policy.md'), '# 待核对\n')
  const test = await assembled(root, () => '提交审核', true)
  const bound = await test.bind()
  expect(bound.isError, JSON.stringify(bound)).toBe(false)
  expect((await test.run('erp_knowledge_check_file', { path: test.file })).isError).toBe(true)
  expect((await test.run('erp_knowledge_check_file', { path: test.file })).isError).toBe(true)
  expect((await test.bind()).isError).toBe(true)
  expect(test.calls.filter(call => call.path.endsWith('/documents/manual'))).toHaveLength(1)
})

it('asks once for multiple files and reports partial submission without recreating an unknown draft', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-files-')); roots.push(root)
  const secondFile = join(root, 'checklist.pdf')
  await writeFile(join(root, 'policy.md'), '# 待核对\n')
  await writeFile(secondFile, '%PDF-1.7\n')
  const test = await assembled(root, () => '提交审核', '# 待核对\n')
  await test.bind()
  await test.run('erp_knowledge_bind_file', { path: secondFile, knowledge_base_id: baseId, document_name: '材料清单' })
  const args = { paths: [test.file, secondFile], knowledge_base_id: baseId }
  const submitted = await test.run('erp_knowledge_submit_files', args)
  expect(submitted.isError, JSON.stringify(submitted)).toBe(false)
  expect(test.questions).toHaveLength(1)
  expect(test.questions[0]?.detail).toContain('checklist.pdf')
  expect(test.questions[0]?.detail).not.toMatch(/SHA-256|policy\.md/)
  expect(test.calls).toContainEqual({
    path: `/api/knowledge/bases/${baseId}/documents/upload`, confirmed: true,
    attachment: Buffer.from('%PDF-1.7\n').toString('base64'),
  })
  expect(JSON.parse((submitted.content[0] as { text: string }).text)).toMatchObject({ results: [
    { state: 'save_unconfirmed' }, { state: 'review', document_id: documentId },
  ] })
  expect(test.calls.filter(call => call.path.endsWith('/submit'))).toHaveLength(1)
  expect((await test.run('erp_knowledge_submit_files', args)).isError).toBe(true)
  expect(test.calls.filter(call => /\/documents\/(manual|upload)$/.test(call.path))).toHaveLength(2)
})
