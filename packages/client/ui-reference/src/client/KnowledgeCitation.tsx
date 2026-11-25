/** Fresh, snapshot-bound knowledge text in the right Sidebar. */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { citationSource } from './knowledge-source.ts'
import css from './KnowledgeCitation.module.css'

interface CitationContent {
  document_name: string
  page: number
  page_size: number
  total_chunks: number
  chunks: { chunk_no?: string; chunk_index: number | null; content: string; truncated: boolean }[]
}

interface CitationInjected {
  loadCitation: (address: string, whole: boolean, page: number, signal: AbortSignal) => Promise<unknown>
}

type Props = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'reference'> & InjectFace<CitationInjected>

function contentOf(value: unknown, failure: string): CitationContent {
  if (value === null || typeof value !== 'object' || !('document_name' in value) || typeof value.document_name !== 'string'
    || !('page' in value) || typeof value.page !== 'number' || !('page_size' in value) || typeof value.page_size !== 'number'
    || !('total_chunks' in value) || typeof value.total_chunks !== 'number' || !('chunks' in value) || !Array.isArray(value.chunks)
    || !value.chunks.every((row: unknown) => row !== null && typeof row === 'object'
      && 'content' in row && typeof row.content === 'string' && 'truncated' in row && typeof row.truncated === 'boolean'
      && 'chunk_index' in row && (row.chunk_index === null || typeof row.chunk_index === 'number')
      && (!('chunk_no' in row) || row.chunk_no === null || typeof row.chunk_no === 'string'))) throw new Error(failure)
  return value as CitationContent
}

/**
 * Read on each visible navigation; abandoned reads cannot restore stale text.
 * @param props - Sidebar tab lifetime, authenticated reader, and localized copy.
 * @returns Source text or its current access/source-change failure.
 */
export function KnowledgeCitation({ useTabInfo, loadCitation, t }: Props): ReactNode {
  const { tab } = useTabInfo()
  const [view, setView] = useState({ revision: tab.navigation.revision, whole: false, page: 1 })
  const whole = view.revision === tab.navigation.revision && view.whole
  const page = view.revision === tab.navigation.revision ? view.page : 1
  const [reload, setReload] = useState(0)
  const key = `${tab.contentId}/${tab.navigation.revision}/${whole}/${page}/${reload}`
  const [state, setState] = useState<{ key: string; data?: CitationContent; error?: string }>()
  useEffect(() => {
    if (!tab.visible) return
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, tab.signal])
    void loadCitation(tab.contentId, whole, page, signal).then(value => contentOf(value, t('citation.failed'))).then(
      (data) => { if (!signal.aborted) setState({ key, data }) },
      (error: unknown) => { if (!signal.aborted) setState({ key, error: error instanceof Error ? error.message : t('citation.failed') }) },
    )
    return () => { controller.abort(); setState(undefined) }
  }, [key, tab.contentId, tab.visible, tab.signal, loadCitation, whole, page, t])
  const current = tab.visible && state?.key === key ? state : undefined
  const data = current?.data
  const source = citationSource(tab.contentId)
  return <article className={css.preview}>
    <header className={css.header}>
      <strong>{data?.document_name ?? t('citation.title')}</strong>
      <Button variant="ghost" onClick={() => { setReload(value => value + 1) }}>{t('citation.reload')}</Button>
    </header>
    {current?.error !== undefined ? <p role="alert">{current.error}</p> : data === undefined
      ? <p role="status">{t('citation.loading')}</p>
      : <>
        {data.chunks.map((chunk, index) => <section key={chunk.chunk_no ?? index}
          className={chunk.chunk_no === source?.chunk_no ? css.selected : css.chunk}>
          <p className={css.position}>{t('citation.chunk', { n: chunk.chunk_index ?? '—' })}</p>
          <MarkdownText text={chunk.content} labels={{ code: { copyLabel: t('citation.copy'), copiedLabel: t('citation.copied') }, footnotes: t('citation.footnotes') }} />
          {chunk.truncated && <p className={css.position}>{t('citation.truncated')}</p>}
        </section>)}
        <footer className={css.footer}>
          {!whole ? <Button variant="outline" onClick={() => { setView({ revision: tab.navigation.revision, whole: true, page: 1 }) }}>{t('citation.readDocument')}</Button> : <>
            <Button variant="ghost" disabled={page <= 1} onClick={() => { setView({ revision: tab.navigation.revision, whole, page: page - 1 }) }}>{t('citation.previous')}</Button>
            <span>{t('citation.page', { n: data.page })}</span>
            <Button variant="ghost" disabled={data.page * data.page_size >= data.total_chunks}
              onClick={() => { setView({ revision: tab.navigation.revision, whole, page: page + 1 }) }}>{t('citation.next')}</Button>
          </>}
        </footer>
      </>}
  </article>
}
