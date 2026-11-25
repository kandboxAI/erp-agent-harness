/** Extract only the selected settled response and its nearest loaded user question. */
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'

export interface Excerpt { question_snapshot: string; answer_snapshot: string }

/** @param snapshot - currently loaded Chat projection. @param messageId - selected response. @returns editable excerpts, or no target. */
export function messageExcerpt(snapshot: ChatSnapshot, messageId: MessageId): Excerpt | undefined {
  const nodes = snapshot.legacy.nodes
  const index = nodes.findIndex(node => node.kind === 'assistant' && node.messageId === messageId && !node.interrupted)
  const answer = nodes[index]
  if (answer?.kind !== 'assistant') return undefined
  const answer_snapshot = answer.blocks.flatMap(block => block.kind === 'text' ? [block.text] : []).join('').slice(0, 20000)
  if (!answer_snapshot.trim()) return undefined
  let question_snapshot = ''
  for (let position = index - 1; position >= 0; position -= 1) {
    const node = nodes[position]
    if (node?.kind !== 'user') continue
    question_snapshot = node.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('').slice(0, 20000)
    break
  }
  return { question_snapshot, answer_snapshot }
}

/** @param snapshot - loaded Chat projection. @returns the latest completed text answer, if available. */
export function latestFeedbackMessage(snapshot: ChatSnapshot): MessageId | undefined {
  for (let index = snapshot.legacy.nodes.length - 1; index >= 0; index -= 1) {
    const node = snapshot.legacy.nodes[index]
    if (node?.kind === 'assistant' && node.messageId !== undefined && !node.interrupted
      && messageExcerpt(snapshot, node.messageId) !== undefined) return node.messageId
  }
  return undefined
}

export interface ReviewCandidate extends Excerpt { messageId: MessageId }

/**
 * @param snapshot - 已加载的 Chat 投影。
 * @param turn - 业务回答所属轮次。
 * @param messageId - 触发复核的业务回答，排除后续记忆维护回答。
 * @returns 本轮完整文字片段；文字缺失或过长时不复核。
 */
export function completionCandidate(snapshot: ChatSnapshot, turn: number, messageId: MessageId): ReviewCandidate | undefined {
  const nodes = snapshot.legacy.nodes
  const index = nodes.findLastIndex(node => node.kind === 'assistant' && node.turn === turn && !node.interrupted && node.messageId === messageId)
  const answer = nodes[index]
  if (answer?.kind !== 'assistant' || answer.messageId === undefined) return undefined
  const answer_snapshot = answer.blocks.flatMap(block => block.kind === 'text' ? [block.text] : []).join('')
  let question_snapshot = ''
  for (let position = index - 1; position >= 0; position -= 1) {
    const node = nodes[position]
    if (node?.kind === 'assistant' && node.turn !== turn) break
    if (node?.kind !== 'user') continue
    question_snapshot = node.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    break
  }
  if (!question_snapshot.trim() || !answer_snapshot.trim()
    || question_snapshot.length > 20000 || answer_snapshot.length > 20000) return undefined
  return { messageId: answer.messageId, question_snapshot, answer_snapshot }
}
