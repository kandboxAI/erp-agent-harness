/** Message feedback UI data passed through Session-scoped slot inject faces. */
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from './locales.ts'
import type { ReviewNotice } from './completion-review.ts'
import type { Excerpt } from './message.ts'

export type Category = 'wrong_answer' | 'not_resolved' | 'outdated' | 'product_issue' | 'other'
export type FeedbackState = 'pending' | 'processing' | 'resolved' | 'closed'
export interface Submission extends Excerpt {
  dsh_submission_no: string
  dsh_session_no: string
  dsh_message_no: string
  category_code: Category
  description: string
  is_reply_requested: boolean
  attachment_ids: string[]
}
export interface FeedbackImage { id: string; file_name: string }
export interface Receipt { id: string; status_code: FeedbackState; latest_reply?: string | null }
export interface FeedbackFace {
  uploadImage: (file: File) => Promise<FeedbackImage>
  discardImage: (fileId: string) => Promise<void>
  prepare: (messageId: MessageId) => Excerpt | undefined
  submit: (body: Submission) => Promise<Receipt>
  status: (messageId: MessageId) => Promise<Receipt | null>
}
export interface FeedbackDialogRequest { messageId: MessageId | null; isOpen: boolean; review?: Excerpt & { reason: string } }
export interface FeedbackDialogFace extends FeedbackFace {
  watchReview?: (notify: (notice: ReviewNotice) => void) => () => void
  openReview?: (notice: ReviewNotice) => void
  hooks: { feedbackDialog: HostObservable<FeedbackDialogRequest | null> }
  dismiss: () => void
}
export type FeedbackProps = PropsRuntime<'conversation.chat.assistant-actions'> & InjectFace<{
  openFeedback: (messageId: MessageId) => void
}> & PropsLocale<'aiControl'>
export type FeedbackDialogProps = PropsRuntime<'conversation.input.overlay'> & InjectFace<FeedbackDialogFace> & PropsLocale<'aiControl'>

export type CompletionNoticeProps = PropsRuntime<'conversation.input.dock'> & InjectFace<FeedbackDialogFace> & PropsLocale<'aiControl'>
