/** Per-message enterprise feedback form; all transport and Session access arrive as callbacks. */
import { useEffect, useRef, useState } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import {
  Button, Modal, IconCheckCircleFillRegular, IconDislikeOutlineRegular, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Category, FeedbackProps, FeedbackDialogProps, FeedbackDialogRequest, Receipt, Submission, FeedbackImage, CompletionNoticeProps } from './contract.ts'
import css from './Feedback.module.css'
import type { ReviewNotice } from './completion-review.ts'

const categories: Category[] = ['wrong_answer', 'not_resolved', 'outdated', 'product_issue', 'other']

/** @param props - selected message and localized enterprise action. @returns the message-row dislike icon. */
export function Feedback({ messageId, openFeedback, t }: FeedbackProps) {
  return <Tooltip label={t('action')} side="bottom"><button type="button" className={css.action}
    aria-label={t('action')} onClick={() => { openFeedback(messageId) }}><IconDislikeOutlineRegular /></button></Tooltip>
}

/**
 * @param props - 单个会话共享的弹窗请求和企业反馈回调。
 * @returns 反馈弹窗；目标不变时保留弹窗实例。
 */
export function FeedbackDialog({ useFeedbackDialog, ...props }: FeedbackDialogProps) {
  const target = useFeedbackDialog(value => value)
  return target === null ? null : <FeedbackForm key={target.messageId ?? 'no-answer'} {...props} target={target} />
}

/**
 * @param props - Session review state and explicit draft action.
 * @returns 可操作的复核结果弹窗或复核中状态；需要补充信息、无法判断或无操作时不展示。
 */
export function CompletionNotice({ useFeedbackDialog, watchReview, openReview, t }: CompletionNoticeProps) {
  const target = useFeedbackDialog(value => value)
  const [notice, setNotice] = useState<ReviewNotice | null>(null)
  useEffect(() => watchReview?.(setNotice), [watchReview])
  const key = notice?.kind === 'checking' ? 'reviewChecking' : notice?.kind === 'failed' ? 'reviewFailed'
    : notice?.kind === 'incomplete' ? 'reviewIncomplete' : null
  if (key === null || notice === null) return null
  if (notice.kind === 'checking') return <div className={css.reviewChecking} role="status" aria-label={t('reviewNoticeTitle')}>
    <StateDot state="ongoing" /><span>{t('reviewChecking')}</span>
  </div>
  const open = () => { openReview?.(notice); setNotice(null) }
  const ignore = () => { setNotice(null) }
  const actionable = notice.candidate !== undefined
  // 只有关闭按钮的提示无需打断用户。
  if (!actionable && notice.retry === undefined) return null
  const errorKey = notice.failureCode === undefined ? null : `reviewError.${notice.failureCode}` as const
  return <Modal open={!target?.isOpen} title={t(notice.kind === 'incomplete' ? 'reviewQuestion' : key)} closeLabel={t('reviewNotNow')} onClose={ignore}
    footer={<><Button onClick={ignore}>{t('reviewNotNow')}</Button>
      {notice.retry !== undefined && <Button onClick={notice.retry}>{t('reviewRetry')}</Button>}
      {actionable && <Button variant="primary" onClick={open}>{t(notice.kind === 'incomplete' ? 'reviewWrite' : 'reviewManual')}</Button>}</>}>
    {notice.reason && <p>{notice.reason}</p>}
    {notice.kind === 'incomplete' && !notice.reason && <p>{t('reviewIncomplete')}</p>}
    {errorKey !== null && <p>{t(errorKey)}</p>}
    {actionable && <p>{t('reviewChoiceHint')}</p>}
  </Modal>
}

type FeedbackFormProps = Pick<FeedbackDialogProps, 'sessionId' | 'prepare' | 'submit' | 'status' | 'uploadImage' | 'discardImage' | 'dismiss' | 't'> & {
  target: FeedbackDialogRequest
}

function FeedbackForm({ target, sessionId, prepare, submit, status, uploadImage, discardImage, dismiss, t }: FeedbackFormProps) {
  const messageId = target.messageId
  const [initial] = useState(() => messageId === null ? undefined : target.review ?? prepare(messageId))
  const [draft, setDraft] = useState<Submission | null>(() => initial === undefined || messageId === null ? null : {
    // 复核原因只预填补充说明，不属于 ERP 接收的问答字段。
    question_snapshot: initial.question_snapshot, answer_snapshot: initial.answer_snapshot,
    dsh_submission_no: randomUUID(), dsh_session_no: sessionId, dsh_message_no: messageId,
    category_code: target.review === undefined ? 'wrong_answer' : 'not_resolved', description: target.review?.reason ?? '', is_reply_requested: false, attachment_ids: [],
  })
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [submitted, setSubmitted] = useState<{ id: string; body: Submission } | null>(null)
  const [error, setError] = useState(initial === undefined ? t('unavailable') : '')
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [noFeedback, setNoFeedback] = useState(false)
  const [lastPayload, setLastPayload] = useState('')
  const [images, setImages] = useState<(FeedbackImage & { previewUrl: string })[]>([])
  const [uploading, setUploading] = useState(false)
  const [preview, setPreview] = useState<{ previewUrl: string; file_name: string } | null>(null)
  const changingImages = useRef(false)
  const previewUrls = useRef(new Set<string>())
  useEffect(() => () => { for (const url of previewUrls.current) URL.revokeObjectURL(url) }, [])
  const addImages = async (files: File[]) => {
    if (!files.length || changingImages.current || busy || receipt !== null || draft === null) return
    if (images.length + files.length > 6 || files.some(file => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)
      || !file.size || file.size > 2 * 1024 * 1024)) { setError(t('imageLimits')); return }
    changingImages.current = true
    setUploading(true)
    setError('')
    try {
      for (const file of files) {
        const image = await uploadImage(file)
        const previewUrl = URL.createObjectURL(file)
        previewUrls.current.add(previewUrl)
        setImages(current => [...current, { ...image, previewUrl }])
        setDraft(current => current === null ? null : { ...current, attachment_ids: [...current.attachment_ids, image.id] })
      }
    } catch { setError(t('imageFailed')) } finally { changingImages.current = false; setUploading(false) }
  }
  const removeImage = async (id: string) => {
    if (busy || changingImages.current) return
    changingImages.current = true
    setUploading(true)
    setError('')
    try {
      await discardImage(id)
      const image = images.find(item => item.id === id)
      if (image !== undefined) { URL.revokeObjectURL(image.previewUrl); previewUrls.current.delete(image.previewUrl) }
      setPreview(null)
      setImages(current => current.filter(item => item.id !== id))
      setDraft(current => current === null ? null : { ...current, attachment_ids: current.attachment_ids.filter(fileId => fileId !== id) })
    } catch { setError(t('imageRemoveFailed')) } finally { changingImages.current = false; setUploading(false) }
  }

  const send = async () => {
    if (draft === null || busy || changingImages.current) return
    // The same confirmed content reuses its submission ID after a lost response.
    const payloadText = JSON.stringify({ ...draft, dsh_submission_no: '' })
    const payload = lastPayload && lastPayload !== payloadText ? { ...draft, dsh_submission_no: randomUUID() } : draft
    setDraft(payload)
    setLastPayload(payloadText)
    setBusy(true)
    setError('')
    setNoFeedback(false)
    try {
      const value = await submit(payload)
      setReceipt(value)
      setSubmitted({ id: value.id, body: payload })
    } catch { setError(t('failed')) } finally { setBusy(false) }
  }
  const check = async () => {
    if (messageId === null) return
    setChecking(true)
    setError('')
    setNoFeedback(false)
    try {
      const value = await status(messageId)
      setReceipt(value)
      setNoFeedback(value === null)
    } catch { setError(t('statusFailed')) } finally { setChecking(false) }
  }
  // 进度接口不返回原始反馈，只有编号一致时才能展示本次确认发送的内容。
  const sent = submitted?.id === receipt?.id ? submitted?.body : undefined
  return <div onPaste={(event) => {
    const files = Array.from(event.clipboardData.files)
    if (target.isOpen && files.length) { event.preventDefault(); void addImages(files) }
  }}>
    <Modal open={target.isOpen} title={t('title')} closeLabel={t('close')} onClose={() => { if (!busy && !uploading) dismiss() }} className={css.dialog as string}
      contentClassName={css.content as string}
      footer={<div className={css.footer}>
        {error && <p role="alert">{error}</p>}
        {noFeedback && <p role="status">{t('none')}</p>}
        <div className={css.footerActions}>
          <Button disabled={busy || uploading || checking || messageId === null} onClick={() => { void check() }}>{t(receipt === null ? 'progress' : 'refresh')}</Button>
          {receipt === null && <Button variant="primary" disabled={busy || uploading || draft === null || !draft.answer_snapshot.trim()} onClick={() => { void send() }}>{busy ? t('sending') : t('submit')}</Button>}
          {receipt !== null && <Button variant="primary" onClick={dismiss}>{t('close')}</Button>}
        </div>
      </div>}>
      {target.review !== undefined && receipt === null && <p role="status">{t(target.review.reason ? 'reviewDraft' : 'reviewManualDraft')}</p>}
      {preview !== null && <div className={css.fullImage}><Button onClick={() => { setPreview(null) }}>{t('closePreview')}</Button><img src={preview.previewUrl} alt={preview.file_name} /></div>}
      {receipt !== null ? <div className={css.receipt}>
        <div className={css.receiptHeader} role="status">
          <div className={css.receiptTitle}><IconCheckCircleFillRegular size={20} /><span>{t('accepted')}</span></div>
          <span className={css.status} data-state={receipt.status_code}>{t(`status.${receipt.status_code}`)}</span>
        </div>
        <p className={css.feedbackId}>{t('feedbackId')}<span>{receipt.id}</span></p>
        <section className={css.submission} aria-label={t('myFeedback')}>
          <h3 className={css.sectionTitle}>{t('myFeedback')}</h3>
          {sent === undefined ? <p className={css.muted}>{t('submissionRecorded')}</p> : <>
            <span className={css.category}>{t(`category.${sent.category_code}`)}</span>
            <p className={css.message}>{sent.description.trim() ? sent.description : t('noDescription')}</p>
            <div className={css.images}>{images.filter(image => sent.attachment_ids.includes(image.id)).map(image =>
              <button key={image.id} type="button" className={css.imagePreview} aria-label={`${t('previewImage')} ${image.file_name}`} onClick={() => { setPreview(image) }}><img src={image.previewUrl} alt={image.file_name} /></button>)}</div>
            <details className={css.excerpts}>
              <summary>{t('submittedExcerpts')}</summary>
              <dl><dt>{t('question')}</dt><dd>{sent.question_snapshot || t('emptyQuestion')}</dd>
                <dt>{t('answer')}</dt><dd>{sent.answer_snapshot}</dd></dl>
            </details>
          </>}
        </section>
        <section className={css.reply} aria-label={t('humanReply')}>
          <div className={css.replyHeader}><h3 className={css.sectionTitle}>{t('humanReply')}</h3><span>{t('replySource')}</span></div>
          {receipt.latest_reply?.trim() ? <p className={css.message}>{receipt.latest_reply}</p> : <p className={css.muted}>{t('noReply')}</p>}
        </section>
      </div> : draft !== null && <div className={css.fields}>
        <p>{t('hint')}</p>
        <label>{t('category')}<select value={draft.category_code} disabled={busy} onChange={event => setDraft({ ...draft, category_code: event.target.value as Category })}>
          {categories.map(category => <option key={category} value={category}>{t(`category.${category}`)}</option>)}
        </select></label>
        <label>{t('question')}<textarea value={draft.question_snapshot} maxLength={20000} disabled={busy} onChange={event => setDraft({ ...draft, question_snapshot: event.target.value })} /></label>
        <label>{t('answer')}<textarea value={draft.answer_snapshot} maxLength={20000} disabled={busy} onChange={event => setDraft({ ...draft, answer_snapshot: event.target.value })} /></label>
        <label>{t('description')}<textarea value={draft.description} maxLength={4000} disabled={busy} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label>
        <section aria-label={t('images')} className={css.imageSection}>
          <label>{t('images')}<input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={busy || uploading || images.length >= 6}
            onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void addImages(files) }} /></label>
          <p className={css.muted}>{uploading ? t('imageUploading') : t('imageHint')}</p>
          <div className={css.images}>{images.map(image => <div key={image.id}>
            <button type="button" className={css.imagePreview} aria-label={`${t('previewImage')} ${image.file_name}`} onClick={() => { setPreview(image) }}><img src={image.previewUrl} alt={image.file_name} /></button>
            <Button disabled={busy || uploading} aria-label={`${t('removeImage')} ${image.file_name}`} onClick={() => { void removeImage(image.id) }}>{t('removeImage')}</Button>
          </div>)}</div>
        </section>
        <label><input type="checkbox" checked={draft.is_reply_requested} disabled={busy} onChange={event => setDraft({ ...draft, is_reply_requested: event.target.checked })} />{t('replyRequested')}</label>
      </div>}
    </Modal>
  </div>
}
