// @vitest-environment jsdom
/** Explicit per-message confirmation and replay of a failed enterprise submission. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { chatSnapshot, makeTranslate, sessionSnapshot, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FeedbackDialogRequest, Receipt, Submission } from '../src/client/contract.ts'
import { CompletionNotice, Feedback, FeedbackDialog } from '../src/client/Feedback.tsx'
import { messageExcerpt, latestFeedbackMessage, completionCandidate } from '../src/client/message.ts'
import { zh } from '../src/client/locales.ts'
import type { ReviewNotice } from '../src/client/completion-review.ts'

let runtime: SlotTestRuntime | undefined
let releaseReference: (() => void) | undefined
afterEach(async () => {
  await runtime?.dispose()
  releaseReference?.()
  releaseReference = undefined
  runtime = undefined
  cleanup()
})
const messageId = 'answer-1' as MessageId
const sessionId = 'session-1' as SessionId
const t = makeTranslate(zh, commonZh)

it.each([
  ['incomplete', true], ['incomplete', false], ['unknown', true], ['unknown', false],
  ['failed', true], ['failed', false], ['needs_input', true], ['needs_input', false],
] as const)('presents %s with candidate=%s and retains the draft', async (kind, hasCandidate) => {
  runtime = await SlotTestRuntime.create()
  await runtime.declare({ 'conversation.input.dock': { kind: 'list', scope: 'session' } })
  await runtime.sessions.add({ id: sessionId })
  const reference = runtime.sessions.retain(sessionId)
  releaseReference = () => { reference[Symbol.dispose]() }
  await reference.ready
  const target = createSnapshotStore<FeedbackDialogRequest | null>({ messageId, isOpen: false })
  const candidate = { messageId, question_snapshot: '请提交申请', answer_snapshot: '缺少权限，申请未提交' }
  const retry = vi.fn()
  const notice: ReviewNotice = { kind, reason: '申请未提交', ...(hasCandidate ? { candidate } : {}), ...(kind === 'failed' && hasCandidate ? { retry, failureCode: 'timeout' as const } : {}) }
  const openReview = vi.fn()
  runtime.slots.register({ name: 'conversation.input.dock', id: 'enterprise-review-test',
    inject: () => ({ hooks: { feedbackDialog: target }, openReview,
      watchReview: (notify: (notice: ReviewNotice) => void) => { notify(notice); return () => {} },
      prepare: () => candidate, submit: async (): Promise<Receipt> => ({ id: 'feedback-1', status_code: 'pending' }),
      status: async () => null, uploadImage: async () => ({ id: 'image-1', file_name: '截图.png' }),
      discardImage: async () => {}, dismiss: () => {},
    }),
  }, props => <CompletionNotice {...props} t={t} />)
  runtime.renderSlot('conversation.input.dock', {
    session: sessionSnapshot(sessionId),
    input: { draft: '', attachmentIds: [], draftRev: 0, phase: 'plain', occurrences: [], queue: [] },
  }, { session: reference })
  if (kind === 'unknown' || kind === 'needs_input' || !hasCandidate) {
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('status', { name: zh.reviewNoticeTitle })).toBeNull()
    expect(screen.queryByText(notice.reason)).toBeNull()
    expect(openReview).not.toHaveBeenCalled()
    expect(target.getSnapshot()).toEqual({ messageId, isOpen: false })
    return
  }
  const title = kind === 'incomplete' ? zh.reviewQuestion : zh.reviewFailed
  const popup = await screen.findByRole('dialog', { name: title })
  expect(screen.queryByRole('status', { name: zh.reviewNoticeTitle })).toBeNull()
  expect(screen.getAllByText(notice.reason)).toHaveLength(1)
  expect(popup.textContent).toMatchSnapshot()
  if (kind === 'failed') {
    fireEvent.click(within(popup).getByText(zh.reviewRetry))
    expect(retry).toHaveBeenCalledOnce()
  }
  fireEvent.click(within(popup).getByText(kind === 'incomplete' ? zh.reviewWrite : zh.reviewManual, { exact: true }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('status', { name: zh.reviewNoticeTitle })).toBeNull()
  expect(openReview.mock.calls).toEqual([[notice]])
  expect(target.getSnapshot()).toEqual({ messageId, isOpen: false })
})

it('selects exactly the chosen answer and preceding question, excluding reasoning and other messages', () => {
  const empty = chatSnapshot()
  const snapshot = chatSnapshot({ legacy: { ...empty.legacy, nodes: [
    { kind: 'user', seq: 0, time: 0, source: null, content: [{ type: 'text', text: '如何申请？' }] },
    { kind: 'assistant', seq: 1, time: 1, turn: 0, step: 0, messageId, blocks: [{ kind: 'reasoning', text: 'private reasoning' }, { kind: 'text', text: '原回答 [1](erp-knowledge://source)' }] },
    { kind: 'user', seq: 2, time: 2, source: null, content: [{ type: 'text', text: 'later private question' }] },
  ] } })
  expect(messageExcerpt(snapshot, messageId)).toMatchInlineSnapshot(`
    {
      "answer_snapshot": "原回答 [1](erp-knowledge://source)",
      "question_snapshot": "如何申请？",
    }
  `)
  expect(messageExcerpt(snapshot, 'missing' as MessageId)).toBeUndefined()
  expect(latestFeedbackMessage(snapshot)).toBe(messageId)
})

it('reviews the business answer even when the projection already contains a silent maintenance tail', () => {
  const empty = chatSnapshot()
  const snapshot = chatSnapshot({ legacy: { ...empty.legacy, nodes: [
    { kind: 'user', seq: 0, time: 0, source: null, content: [{ type: 'text', text: 'hi' }] },
    { kind: 'assistant', seq: 1, time: 1, turn: 1, step: 1, messageId, blocks: [{ kind: 'text', text: '你好' }] },
    { kind: 'user', seq: 2, time: 2, source: { kind: 'erp-position-memory' }, content: [{ type: 'text', text: '整理岗位共同记忆' }] },
    { kind: 'assistant', seq: 3, time: 3, turn: 1, step: 2, messageId: 'memory-answer' as MessageId, blocks: [{ kind: 'text', text: '' }] },
  ] } })
  expect(completionCandidate(snapshot, 1, messageId)).toEqual({ messageId, question_snapshot: 'hi', answer_snapshot: '你好' })
})

it('sends only after confirmation and reuses the submission ID after failure and reopening', async () => {
  const submit = vi.fn<(value: Submission) => Promise<{ id: string; status_code: 'pending' }>>()
    .mockRejectedValueOnce(new Error('lost response')).mockResolvedValue({ id: 'feedback-1', status_code: 'pending' })
  const status = vi.fn(async () => ({ id: 'feedback-1', status_code: 'resolved' as const, latest_reply: '人工答复' }))
  runtime = await SlotTestRuntime.create()
  await runtime.declare({ 'conversation.chat.assistant-actions': { kind: 'list', scope: 'session' },
    'conversation.input.overlay': { kind: 'list', scope: 'session' } })
  await runtime.sessions.add({ id: sessionId })
  const reference = runtime.sessions.retain(sessionId)
  releaseReference = () => { reference[Symbol.dispose]() }
  await reference.ready
  const target = createSnapshotStore<FeedbackDialogRequest | null>(null)
  runtime.slots.register({ name: 'conversation.chat.assistant-actions', id: 'enterprise-feedback-test' },
    (props: PropsRuntime<'conversation.chat.assistant-actions'>) => <Feedback {...props}
      openFeedback={(messageId) => { target.set({ messageId, isOpen: true }) }} t={t} />)
  runtime.slots.register({ name: 'conversation.input.overlay', id: 'enterprise-dialog-test',
    inject: () => ({ hooks: { feedbackDialog: target },
      prepare: () => ({ question_snapshot: '问题', answer_snapshot: '回答' }), submit, status,
      uploadImage: async () => ({ id: 'image-1', file_name: '截图.png' }), discardImage: async () => {},
      dismiss: () => { target.update((value) => { if (value !== null) value.isOpen = false }) },
    }),
  }, props => <FeedbackDialog {...props} t={t} />)
  runtime.renderSlot('conversation.chat.assistant-actions', { messageId }, { session: reference })
  runtime.renderSlot('conversation.input.overlay', {}, { session: reference })
  const ui = screen
  const icon = ui.getByRole('button', { name: zh.action })
  expect(icon.textContent).toBe('')
  expect(icon.querySelector('svg')).not.toBeNull()
  fireEvent.click(icon)
  expect(submit).not.toHaveBeenCalled()
  fireEvent.change(ui.getByLabelText(zh.description), { target: { value: '这处不准确' } })
  fireEvent.click(ui.getByLabelText(zh.replyRequested))
  fireEvent.click(ui.getByText(zh.submit))
  await ui.findByText(zh.failed)
  fireEvent.click(ui.getByLabelText(zh.close))
  fireEvent.click(ui.getByRole('button', { name: zh.action }))
  fireEvent.click(ui.getByText(zh.submit))
  await ui.findByText(zh.accepted)
  expect(submit.mock.calls[0]?.[0]).toEqual(submit.mock.calls[1]?.[0])
  expect(submit.mock.calls[0]?.[0]).toMatchObject({ dsh_session_no: sessionId, dsh_message_no: messageId,
    question_snapshot: '问题', answer_snapshot: '回答', description: '这处不准确', is_reply_requested: true })
  expect(Object.keys(submit.mock.calls[0]![0]).sort()).toEqual(['answer_snapshot', 'attachment_ids', 'category_code', 'description', 'dsh_message_no', 'dsh_session_no', 'dsh_submission_no', 'is_reply_requested', 'question_snapshot'])
  const mine = ui.getByRole('region', { name: zh.myFeedback })
  const reply = ui.getByRole('region', { name: zh.humanReply })
  expect(within(mine).getByText('这处不准确')).toBeTruthy()
  expect(within(mine).queryByText('人工答复')).toBeNull()
  expect(within(reply).getByText(zh.noReply)).toBeTruthy()
  fireEvent.click(within(mine).getByText(zh.submittedExcerpts))
  expect(within(mine).getByText('回答')).toBeTruthy()
  fireEvent.click(ui.getByText(zh.refresh))
  await waitFor(() => expect(ui.getByText('人工答复')).toBeTruthy())
  expect(within(reply).queryByText(zh.noReply)).toBeNull()
  expect({ status: ui.getByRole('status').textContent, mine: mine.textContent, reply: reply.textContent }).toMatchInlineSnapshot(`
    {
      "mine": "我的反馈回答错误这处不准确查看提交的问题与回答问题片段问题回答片段回答",
      "reply": "人工回复企业控制中心人工答复",
      "status": "反馈已提交已解决",
    }
  `)
  status.mockResolvedValueOnce({ id: 'feedback-2', status_code: 'resolved', latest_reply: '另一次反馈的回复' })
  fireEvent.click(ui.getByText(zh.refresh))
  await ui.findByText('另一次反馈的回复')
  expect(within(mine).getByText(zh.submissionRecorded)).toBeTruthy()
  expect(within(mine).queryByText('这处不准确')).toBeNull()
})
