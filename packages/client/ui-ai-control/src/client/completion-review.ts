/** Review live business answers before automatic position-memory maintenance. */
import type { SessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { CompletionReview } from '../index.ts'
import type { ReviewCandidate } from './message.ts'

export type ReviewFailureCode = 'service_unavailable' | 'permission_denied' | 'sign_in_required' | 'rate_limited' | 'timeout' | 'model_unavailable' | 'request_failed'
export class ReviewRequestError extends Error {
  readonly failureCode: ReviewFailureCode

  constructor(failureCode: ReviewFailureCode) {
    super(failureCode)
    this.failureCode = failureCode
  }
}
export interface ReviewNotice {
  kind: CompletionReview['verdict'] | 'checking' | 'failed'
  reason: string
  candidate?: ReviewCandidate
  failureCode?: ReviewFailureCode
  retry?: () => void
}
export interface ReviewWatcherOptions {
  events: SessionEventSource
  candidateFor: (turn: number, messageId: MessageId) => ReviewCandidate | undefined
  review: (candidate: ReviewCandidate, signal: AbortSignal) => Promise<CompletionReview>
  notify: (notice: ReviewNotice) => void
  suggest?: (candidate: ReviewCandidate, reason: string) => void
}

/**
 * @param options - 实时事件窗口、本轮片段及对应回调。
 * @returns 取消待处理复核并移除监听的清理函数。
 */
export function watchCompletionReviews({ events, candidateFor, review, notify, suggest }: ReviewWatcherOptions): () => void {
  let active: AbortController | undefined
  let lastTurn = -1
  let maintenance = false
  const run = (candidate: ReviewCandidate) => {
    active?.abort()
    const controller = new AbortController()
    active = controller
    notify({ kind: 'checking', reason: '', candidate })
    void (async () => {
      try {
        const result = await review(candidate, controller.signal)
        if (controller.signal.aborted) return
        notify({ kind: result.verdict, reason: result.reason, candidate })
        if (result.verdict === 'incomplete') suggest?.(candidate, result.reason)
      } catch (error) {
        if (!controller.signal.aborted) notify({ kind: 'failed', reason: '', candidate,
          failureCode: error instanceof ReviewRequestError ? error.failureCode : 'request_failed', retry: () => { run(candidate) } })
      }
    })()
  }
  const stop = events.subscribe(() => {
    const change = events.getSnapshot().change
    if (change.kind !== 'append') return
    for (const entry of change.entries) {
      if (entry.type !== 'event') continue
      const event = entry.event
      if (event.type === 'turn/start') { maintenance = false; active?.abort(); notify({ kind: 'not_applicable', reason: '' }); continue }
      if (event.type === 'user/message') {
        const source: { kind: string } | undefined = event.data.source
        if (source?.kind === 'erp-position-memory') maintenance = true
        continue
      }
      if (maintenance || event.type !== 'assistant/message' || event.data.interrupted
        || event.data.message.content.some(block => block.type === 'tool-call')
        || !event.data.message.content.some(block => block.type === 'text' && block.text.trim())
        || event.data.turn <= lastTurn) continue
      const turn = event.data.turn
      const messageId = event.data.message.id
      lastTurn = turn
      active?.abort()
      const controller = new AbortController()
      active = controller
      queueMicrotask(() => {
        if (controller.signal.aborted) return
        try {
          const candidate = candidateFor(turn, messageId)
          if (candidate === undefined) { notify({ kind: 'unknown', reason: '' }); return }
          run(candidate)
        } catch { notify({ kind: 'failed', reason: '', failureCode: 'request_failed' }) }
      })
    }
  })
  return () => { active?.abort(); stop() }
}
