/** Independent enterprise feedback entry for settled Chat answers. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { FeedbackDialogFace, FeedbackDialogRequest, Receipt, FeedbackImage } from './contract.ts'
import { Feedback, FeedbackDialog, CompletionNotice } from './Feedback.tsx'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import { IconDislikeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { watchCompletionReviews, ReviewRequestError } from './completion-review.ts'
import { messageExcerpt, latestFeedbackMessage, completionCandidate } from './message.ts'
import { en, zh } from './locales.ts'

/** Services used to bind the message action to the current Session. */
export const inject = ['slots', 'locale', 'sessions', 'uiConversation', 'commandUi']

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function receipt(value: unknown): Receipt {
  if (!record(value) || typeof value.id !== 'string' || !['pending', 'processing', 'resolved', 'closed'].includes(String(value.status_code))
    || value.latest_reply !== undefined && value.latest_reply !== null && typeof value.latest_reply !== 'string') throw new Error('Invalid feedback receipt')
  return { id: value.id, status_code: value.status_code as Receipt['status_code'],
    ...(value.latest_reply === undefined ? {} : { latest_reply: value.latest_reply as string | null }) }
}

async function request(path: string, body: object, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`/api/erp-ai-control/${path}`, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) })
  const value: unknown = await response.json()
  if (!response.ok || !record(value) || value.code !== 0) {
    if (path === 'review') {
      const code = record(value) ? value.error_code : undefined
      switch (code) {
        case 'service_unavailable': case 'permission_denied': case 'sign_in_required': case 'rate_limited': case 'timeout': case 'model_unavailable':
          throw new ReviewRequestError(code)
        default: throw new ReviewRequestError('request_failed')
      }
    }
    throw new Error('Enterprise feedback request failed')
  }
  return value.data
}

async function uploadImage(file: File): Promise<FeedbackImage> {
  const content_base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result.slice(reader.result.indexOf(',') + 1))
      else reject(new Error('Invalid image'))
    }
    reader.onerror = () => { reject(new Error('Image read failed')) }
    reader.readAsDataURL(file)
  })
  const value = await request('upload', { file_name: file.name || 'clipboard.png', content_type: file.type, content_base64 })
  if (!record(value) || typeof value.id !== 'string' || typeof value.file_name !== 'string') throw new Error('Invalid uploaded image')
  return { id: value.id, file_name: value.file_name }
}

/** @param ctx - Client services and Session-scoped message slot. @returns no value; registrations follow the plugin lifecycle. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('aiControl', { zh, en }), 'ai-control: dictionaries')
  const t = ctx.locale.bind('aiControl')
  const dialogs = new Map<SessionId, ReturnType<typeof createDialog>>()
  const createDialog = () => createSnapshotStore<FeedbackDialogRequest | null>(null)
  const dialogFor = (sessionId: SessionId) => {
    let dialog = dialogs.get(sessionId)
    if (dialog === undefined) { dialog = createDialog(); dialogs.set(sessionId, dialog) }
    return dialog
  }
  const snapshotFor = (sessionId: SessionId) => {
    const binding = ctx.sessions.binding(sessionId)
    return binding === undefined ? undefined : ctx.uiConversation.binding(binding).target('chat').getSnapshot()
  }
  const open = (sessionId: SessionId, messageId: MessageId | null) => {
    dialogFor(sessionId).set({ messageId, isOpen: true })
  }
  ctx.effect(() => () => { dialogs.clear() }, 'ai-control: Session dialogs')
  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions', id: 'enterprise-ai-feedback', order: 10, locale: 'aiControl',
    inject: sessionId => ({ openFeedback: (messageId: MessageId) => { open(sessionId, messageId) } }),
  }, Feedback))
  const faceFor = (sessionId: SessionId): FeedbackDialogFace => ({
    hooks: { feedbackDialog: dialogFor(sessionId) },
    openReview: (notice) => {
      const candidate = notice.candidate
      if (candidate === undefined) return
      dialogFor(sessionId).set({ messageId: candidate.messageId, isOpen: true,
        review: { question_snapshot: candidate.question_snapshot, answer_snapshot: candidate.answer_snapshot, reason: notice.kind === 'incomplete' ? notice.reason : '' } })
    },
    watchReview: (notify) => {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) return () => {}
      return watchCompletionReviews({ events: binding.eventSource, notify,
        candidateFor: (turn, messageId) => {
          const snapshot = snapshotFor(sessionId)
          return snapshot === undefined ? undefined : completionCandidate(snapshot, turn, messageId)
        },
        review: async (candidate, signal) => {
          const value = await request('review', { question_snapshot: candidate.question_snapshot, answer_snapshot: candidate.answer_snapshot }, signal)
          if (!record(value) || typeof value.reason !== 'string' || typeof value.evidence !== 'string') throw new Error('Invalid completion verdict')
          switch (value.verdict) {
            case 'completed': case 'incomplete': case 'needs_input': case 'unknown': case 'not_applicable':
              return { verdict: value.verdict, reason: value.reason, evidence: value.evidence }
            default: throw new Error('Invalid completion verdict')
          }
        },

      })
    },
    dismiss: () => { dialogFor(sessionId).update((target) => { if (target !== null) target.isOpen = false }) },
    prepare: (messageId) => {
      const snapshot = snapshotFor(sessionId)
      return snapshot === undefined ? undefined : messageExcerpt(snapshot, messageId)
    },
    uploadImage,
    discardImage: async (fileId) => { await request('discard', { file_id: fileId }) },
    submit: async body => receipt(await request('submit', body)),
    status: async (messageId) => {
      const value = await request('status', { dsh_session_no: sessionId, dsh_message_no: messageId })
      if (!record(value)) throw new Error('Invalid feedback status')
      return value.feedback === null ? null : receipt(value.feedback)
    },

  })
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
    name: 'conversation.input.overlay', id: 'enterprise-ai-feedback-dialog', order: 2, locale: 'aiControl', inject: faceFor,
  }, FeedbackDialog))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'enterprise-ai-feedback-notice', order: 15, locale: 'aiControl', inject: faceFor,
  }, CompletionNotice))
  ctx.effect(() => ctx.commandUi.register({
    name: 'feedback', label: () => t('action'), description: () => t('commandDescription'),
    icon: IconDislikeOutlineRegular, available: () => true,
    ui: { kind: 'action', run: (session) => {
      const snapshot = snapshotFor(session.sessionId)
      open(session.sessionId, snapshot === undefined ? null : latestFeedbackMessage(snapshot) ?? null)
    } },
  }), 'ai-control: /feedback')
}
