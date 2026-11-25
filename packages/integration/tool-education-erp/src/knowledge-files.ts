/** Markdown file associations and human-reviewed ERP contributions over the mounted filesystem. */
import { basename, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { createTwoFilesPatch } from 'diff'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-user-questions'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'

type Execution = Pick<ToolRunContext, 'agent' | 'callId' | 'signal'>
type BindingId = Branded<'ErpKnowledgeFileBindingId'>
type Api = (request: { method: 'POST' | 'PUT'; path: string; body: Record<string, string> }, exec: Execution, confirmed?: boolean) => Promise<unknown>
const recordSchema = z.object({
  path: z.string(), sessionId: z.string(), documentId: z.string().nullable(), baseId: z.string(),
  title: z.string(), editToken: z.string().nullable(), lastSavedHash: z.string(), lastPromptedHash: z.string(),
  previousContent: z.string(), state: z.enum(['bound', 'uncertain']),
})
type Binding = z.infer<typeof recordSchema>
const bindingSpec = defineDomain({ name: 'erp_knowledge_files', version: 1,
  tables: { files: domainTable<BindingId, Binding>(recordSchema) } })
const attachmentTypes = new Map([
  ['.pdf', 'application/pdf'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
])
const attachmentMaxBytes = 20 * 1024 * 1024
const fingerprint = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex')
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
function data(value: unknown): Record<string, unknown> {
  if (!object(value) || value.ok !== true || !object(value.data)) throw new Error('ERP 操作未确认成功，请到业务页面核对；不要重复创建。')
  return value.data
}
function status(value: unknown): { editToken: string | null; versionId: string; hash: string; state: string; baseId: string } {
  const result = data(value)
  if (!(typeof result.edit_token === 'string' || result.edit_token === null) || !Array.isArray(result.versions) || typeof result.knowledge_base_id !== 'string') throw new Error('ERP 版本状态无效，请更新服务端')
  const latest: unknown = result.versions[0]
  if (!object(latest) || typeof latest.version_id !== 'string' || typeof latest.content_hash_snapshot !== 'string'
      || typeof latest.status_code !== 'string') throw new Error('ERP 版本信息缺失')
  return { editToken: result.edit_token, versionId: latest.version_id, hash: latest.content_hash_snapshot,
    state: latest.status_code, baseId: result.knowledge_base_id }
}

/**
 * Register durable file associations, explicit checks, and checks after successful file-tool writes.
 * @param ctx - Integration plugin scope; filesystem, questions and domain storage activate the file feature together.
 * @param api - Session-bound ERP executor; `confirmed` is supplied only after the human reviewed the frozen file payload.
 * @returns no value; tool registrations and domain lifetime belong to the injected scope.
 */
export function registerKnowledgeFiles(ctx: Context, api: Api): void {
  ctx.inject(['fs', 'userQuestions', 'storageDomain'], async (scope) => {
    const domain = await scope.storageDomain.open(bindingSpec)
    scope.effect(() => () => domain.close(), 'erp-knowledge-files: storage')
    const files = domain.table('files')
    const resolve = async (path: string, exec: Execution) => {
      if (!exec.agent) throw new Error('知识文件操作需要当前会话')
      const cwd = exec.agent.session.header.cwd
      const target = await scope.fs.resolve(path, { ...cwd === undefined ? {} : { cwd }, signal: exec.signal })
      const key = brandString<BindingId>(fingerprint(`${exec.agent.session.id}\n${target.targetKey}`))
      return { target, key, sessionId: exec.agent.session.id }
    }
    const read = async (path: string, exec: Execution) => {
      const resolved = await resolve(path, exec)
      const info = await scope.fs.stat(resolved.target, exec.signal)
      if (info?.type !== 'file') throw new Error('请选择有效文件')
      const extension = extname(path).toLowerCase()
      const contentType = attachmentTypes.get(extension)
      if (contentType) {
        const fileName = basename(path.replaceAll('\\', '/'))
        if (!fileName || fileName.length > 255) throw new Error('附件文件名不能超过 255 个字符')
        const bytes = await scope.fs.readBytes(resolved.target, exec.signal, attachmentMaxBytes)
        if (!bytes.length) throw new Error('不能上传空附件')
        return { ...resolved, content: '', hash: fingerprint(bytes), attachment: { fileName, contentType, size: bytes.length } }
      }
      if (extension !== '.md' || info.size !== undefined && info.size > 4 * 1024 * 1024) throw new Error('请选择 Markdown、Word、PDF、Excel 或 PowerPoint 文件')
      const content = await scope.fs.readText(resolved.target, exec.signal)
      if (!content.trim() || Array.from(content).length > 200_000) throw new Error('Markdown 正文须为 1 至 200,000 个字符')
      return { ...resolved, content, hash: fingerprint(content), attachment: undefined }
    }
    const version = async (documentId: string, exec: Execution) => status(await api({ method: 'POST', path: '/api/knowledge/version-status', body: { document_id: documentId } }, exec))
    type LocalFile = Awaited<ReturnType<typeof read>>
    type CurrentVersion = Awaited<ReturnType<typeof version>> | null
    const prepare = async (binding: Binding, exec: Execution) => {
      if (binding.state === 'uncertain') throw new Error('上次知识写入结果待核对，请先到 ERP 核对后用确切文档重新关联。')
      const current = binding.documentId ? await version(binding.documentId, exec) : null
      if (current && current.editToken !== binding.editToken) throw new Error('ERP 文档已变化，请核对最新版本后重新关联文件。')
      return current
    }
    const save = async (local: LocalFile, binding: Binding, current: CurrentVersion, exec: Execution) => {
      // The confirmed request uses the captured content; a later file save requires a new review.
      if (binding.lastSavedHash !== local.hash) {
        if (current && current.editToken === null) throw new Error('当前版本不可编辑，请在 ERP 核对审核状态。')
        const attachment = local.attachment
        const bytes = attachment ? await scope.fs.readBytes(local.target, exec.signal, attachmentMaxBytes) : undefined
        if (bytes && fingerprint(bytes) !== local.hash) throw new Error('附件在确认后发生变化，请重新核对并送审。')
        await files.put(local.key, { ...binding, state: 'uncertain' })
        if (binding.documentId) {
          if (!current?.editToken) throw new Error('当前文档缺少有效编辑基线，请到 ERP 核对。')
          const updated = await api({ method: 'PUT', path: `/api/knowledge/documents/${encodeURIComponent(binding.documentId)}/edit`, body: {
            source_hash_snapshot: current.editToken, content: local.content, change_reason: 'DSH 关联文件修订',
          } }, exec, true)
          if (!object(updated) || updated.ok !== true) throw new Error('草稿写入未确认，请到 ERP 核对。')
        } else {
          const created = data(await api({ method: 'POST',
            path: `/api/knowledge/bases/${encodeURIComponent(binding.baseId)}/documents/${attachment ? 'upload' : 'manual'}`,
            body: attachment && bytes
              ? { file_name: attachment.fileName, content_type: attachment.contentType, content_base64: Buffer.from(bytes).toString('base64') }
              : { document_name: binding.title, content: local.content, change_reason: 'DSH 文件提交为新知识' },
          }, exec, true))
          if (typeof created.document_id !== 'string') throw new Error('草稿创建结果待核对，请到 ERP 检查，不要重复创建。')
          binding = { ...binding, documentId: created.document_id }
        }
        if (!binding.documentId) throw new Error('未取得确切知识文档 ID，请到 ERP 核对。')
        current = await version(binding.documentId, exec)
        binding = { ...binding, editToken: current.editToken, lastSavedHash: local.hash,
          lastPromptedHash: local.hash, previousContent: local.content, state: 'bound' }
        await files.put(local.key, binding)
      }
      return { binding, current }
    }
    const submit = async (local: LocalFile, binding: Binding, current: CurrentVersion, exec: Execution) => {
      if (!current || current.state !== 'draft') throw new Error('已保存的版本不是可提交草稿，请到 ERP 核对。')
      const submittedResult = await api({ method: 'POST', path: `/api/knowledge/versions/${encodeURIComponent(current.versionId)}/submit`,
        body: { content_hash_snapshot: current.hash } }, exec, true)
      if (!object(submittedResult) || submittedResult.ok !== true) throw new Error('草稿已保存，提交未确认，请到 ERP 核对。')
      if (!binding.documentId) throw new Error('未取得确切知识文档 ID，请到 ERP 核对。')
      const submitted = await version(binding.documentId, exec)
      await files.put(local.key, { ...binding, editToken: submitted.editToken })
      return submitted
    }
    const diff = (local: LocalFile, binding: Binding) =>
      local.attachment
        ? `原件附件：${local.attachment.fileName}（${local.attachment.size} 字节）`
        : createTwoFilesPatch('修改前', '修改后', binding.previousContent, local.content)
    const check = async (path: string, exec: Execution, force: boolean) => {
      if (!exec.agent) throw new Error('知识文件操作需要当前会话')
      const local = await read(path, exec)
      const binding = files.get(local.key)
      if (!binding) return { state: 'not_bound', path: local.target.displayPath }
      const current = await prepare(binding, exec)
      if (!force && binding.lastPromptedHash === local.hash) return { state: 'unchanged', document_id: binding.documentId }
      const difference = diff(local, binding)
      const decision = await scope.userQuestions.ask({ agent: exec.agent, signal: exec.signal, questions: [{
        id: 'knowledge-contribution', header: '知识修订',
        question: `是否将“${binding.title}”保存到知识库并提交审核？`,
        detail: `${binding.documentId ? '修订已有知识文档' : '新建知识文档'}\n提交后由 ERP 审核人员审核。下方是本地文件的变更或附件名称。\n\n\`\`\`diff\n${difference}\n\`\`\``,
        options: [{ label: '提交审核' }, { label: '只保存草稿' }, { label: '暂不提交' }],
      }] })
      const answer = decision.answers.find(item => item.id === 'knowledge-contribution')
      const choice = answer?.selected.length === 1 ? answer.selected[0] : undefined
      if (choice !== '提交审核' && choice !== '只保存草稿') {
        await files.put(local.key, { ...binding, lastPromptedHash: local.hash })
        return { state: 'deferred', document_id: binding.documentId }
      }
      const saved = await save(local, binding, current, exec)
      const result = choice === '提交审核' ? await submit(local, saved.binding, saved.current, exec) : saved.current
      return { state: result?.state ?? 'draft', document_id: saved.binding.documentId }
    }
    const submitBatch = async (paths: string[], baseId: string, exec: Execution) => {
      if (!exec.agent) throw new Error('知识文件操作需要当前会话')
      if (paths.length < 1 || paths.length > 10) throw new Error('一次请选择 1 至 10 份文件')
      const candidates = []
      const targets = new Set<string>()
      for (const path of paths) {
        const local = await read(path, exec)
        const binding = files.get(local.key)
        if (!binding || binding.baseId !== baseId) throw new Error('请先将每份文件关联到同一目标知识库')
        const target = binding.documentId ?? local.key
        if (targets.has(target)) throw new Error('同一文件或知识文档不能重复送审')
        targets.add(target)
        const current = await prepare(binding, exec)
        if (current && ((current.editToken === null && !local.attachment) || (local.attachment && binding.lastSavedHash !== local.hash) || (binding.lastSavedHash === local.hash && current.state !== 'draft'))) {
          throw new Error(`“${binding.title}”当前没有可送审的修改，请核对版本状态。`)
        }
        candidates.push({ local, binding, current })
      }
      const detail = candidates.map(({ local, binding }) =>
        `${binding.title} · ${binding.documentId ? '修订' : '新建'}\n\n\`\`\`diff\n${diff(local, binding)}\n\`\`\``).join('\n\n')
      const decision = await scope.userQuestions.ask({ agent: exec.agent, signal: exec.signal, questions: [{
        id: 'knowledge-batch-submit', header: '批量送审',
        question: `是否将这 ${candidates.length} 份材料保存到知识库并逐份提交审核？`,
        detail: `提交后由 ERP 审核人员逐份审核。\n\n${detail}`,
        options: [{ label: '提交审核' }, { label: '暂不提交' }],
      }] })
      const choice = decision.answers.find(item => item.id === 'knowledge-batch-submit')?.selected
      if (choice?.length !== 1 || choice[0] !== '提交审核') return { state: 'deferred' }
      const results = []
      for (const { local, binding, current } of candidates) {
        if (exec.signal.aborted) {
          results.push({ path: local.target.displayPath, document_id: binding.documentId, state: 'not_attempted' })
          continue
        }
        let documentId = binding.documentId
        let stage = 'save'
        try {
          const saved = await save(local, binding, current, exec)
          documentId = saved.binding.documentId
          stage = 'submit'
          const submitted = await submit(local, saved.binding, saved.current, exec)
          results.push({ path: local.target.displayPath, document_id: documentId, state: submitted.state })
        }
        catch (error) {
          results.push({ path: local.target.displayPath, document_id: documentId,
            state: stage === 'submit' ? 'draft_saved_submit_unconfirmed' : 'save_unconfirmed',
            message: error instanceof Error ? error.message : '请到 ERP 核对' })
        }
      }
      return { state: 'processed', results }
    }
    scope.effect(() => scope.tools.register(defineTool({
      name: 'erp_knowledge_bind_file',
      description: 'Associate one explicitly selected local Markdown, Word, PDF, Excel or PowerPoint file with an ERP knowledge document or a new-document destination. Ask the user whether this file is a source revision or a separate deliverable before binding. Associations persist on this Host and are scoped to the current Session. Do not reconstruct a whole source from redacted search excerpts. Use the exact IDs returned by ERP tools. Attachments can only be associated as new documents. Binding does not submit or publish the file.',
      parameters: {
        path: { type: 'string', required: true, description: 'Explicitly selected local file path.' },
        knowledge_base_id: { type: 'string', required: true, description: 'Verified ERP target knowledge base ID.' },
        document_id: { type: 'string', description: 'Verified existing ERP document ID for a revision; omit for a new document.' },
        document_name: { type: 'string', required: true, description: 'Human-readable document title.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, exec) => {
        const local = await read(args.path, exec)
        if (local.attachment && args.document_id) throw new Error('附件修订请在 ERP 上传新版本。')
        const previous = files.get(local.key)
        if (previous && !args.document_id && (previous.state === 'uncertain' || previous.documentId !== null)) throw new Error('此文件已有知识关联或待核对写入，请先在 ERP 确认文档后使用确切文档 ID 关联。')
        const existing = args.document_id ? await version(args.document_id, exec) : null
        if (existing && existing.baseId !== args.knowledge_base_id) throw new Error('文档不属于所选知识库，请核对目标。')
        if (existing?.editToken === null) throw new Error('目标文档当前不可编辑，请到 ERP 核对。')
        await files.put(local.key, { path: local.target.displayPath, sessionId: local.sessionId,
          documentId: args.document_id ?? null, baseId: args.knowledge_base_id, title: local.attachment?.fileName ?? args.document_name,
          editToken: existing?.editToken ?? null, lastSavedHash: '', lastPromptedHash: '', previousContent: '', state: 'bound' })
        return { state: 'bound', path: local.target.displayPath, document_id: args.document_id ?? null }
      },
      presentCall: args => ({ card: 'generic', title: '关联知识文件', kind: 'read', rawInput: args }),
    })), 'erp-knowledge-files: bind tool')
    scope.effect(() => scope.tools.register(defineTool({
      name: 'erp_knowledge_check_file',
      description: 'Check one associated Markdown file for changes and show the human a diff with Submit for review, Save draft, and Defer choices. Repeated unchanged content is quiet. ERP checks current permissions and version hashes. This never approves or publishes knowledge. A new unknown creation result requires manual reconciliation, never automatic recreation.',
      parameters: { path: { type: 'string', required: true }, force_prompt: { type: 'boolean', description: 'Show the decision again when the user explicitly requests it for unchanged content.' } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (args, exec) => check(args.path, exec, args.force_prompt === true),
      presentCall: args => ({ card: 'generic', title: '检查知识文件修订', kind: 'edit', rawInput: args }),
    })), 'erp-knowledge-files: check tool')
    scope.effect(() => scope.tools.register(defineTool({
      name: 'erp_knowledge_submit_files',
      description: 'Submit 1 to 10 explicitly selected Markdown, Word, PDF, Excel or PowerPoint files in one human confirmation. Attachments are submitted as new documents, up to 20 MiB each. Resolve the target ERP library first and bind each unassociated file to that same library using erp_knowledge_bind_file. For a revision reuse the exact existing document ID. This replaces individual checks for the requested batch. Each file has a separate ERP review and result. Do not retry confirmed submissions or unknown writes. To retry a known unsent draft, first verify its ERP status, then explicitly check the failed file with force_prompt or batch only the remaining files.',
      parameters: {
        paths: { type: 'array', items: { type: 'string' }, required: true, description: 'One to ten explicitly selected, associated local file paths.' },
        knowledge_base_id: { type: 'string', required: true, description: 'Verified common ERP knowledge base ID.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (args, exec) => submitBatch(args.paths, args.knowledge_base_id, exec),
      presentCall: args => ({ card: 'generic', title: '批量送审知识文件', kind: 'edit', rawInput: args }),
    })), 'erp-knowledge-files: submit batch tool')
    scope.on('tools/post-execute', async (exec, result, next) => {
      const accepted = await next()
      const path = object(exec.arguments) ? (exec.arguments.file_path ?? exec.arguments.path) : undefined
      if (accepted.kind === 'block' || accepted.value !== undefined || result.isError || exec.parent !== undefined
          || !exec.agent || !object(exec.arguments) || typeof path !== 'string'
          || !path.toLowerCase().endsWith('.md')
          || !['write', 'edit', 'str_replace_editor'].includes(exec.name)
          || exec.name === 'str_replace_editor' && !['create', 'str_replace', 'insert'].includes(String(exec.arguments.command))) return accepted
      let summary: string
      try {
        const resolved = await resolve(path, exec)
        if (!files.get(resolved.key)) return accepted
        summary = JSON.stringify(await check(path, exec, false))
      }
      catch (error) { summary = `本地文件操作已完成，知识修订尚未完成：${error instanceof Error ? error.message : '请手动检查知识文件'}` }
      return { kind: 'accept', content: [...accepted.content ?? result.content, { type: 'text', text: summary }],
        ...accepted.additionalContexts === undefined ? {} : { additionalContexts: accepted.additionalContexts } }
    })
  })
}
