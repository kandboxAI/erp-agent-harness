// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { KnowledgeCitation } from '../src/client/KnowledgeCitation.tsx'
import { citationSource } from '../src/client/knowledge-source.ts'
import { zh } from '../src/client/locales.ts'

type CitationProps = ComponentProps<typeof KnowledgeCitation>

afterEach(cleanup)
const address = `dsh-resource://knowledge/01900000-0000-7000-8000-000000000001/${'a'.repeat(64)}/chunk-a`
const t = (key: keyof typeof zh, values?: Record<string, string | number>) => Object.entries(values ?? {}).reduce<string>(
  (text, [name, value]) => text.replace(`{${name}}`, String(value)), zh[key],
)
const content = { document_name: '报销制度', page: 1, page_size: 1, total_chunks: 1,
  chunks: [{ chunk_no: 'chunk-a', chunk_index: 12, content: '标准为每晚380元', truncated: false }] }

it('opens the exact source, pages the protected document, and rereads on navigation', async () => {
  let revision = 1
  const loadCitation = vi.fn<CitationProps['loadCitation']>(() => Promise.resolve(content))
  const signal = new AbortController().signal
  const useTabInfo = () => ({ tab: { contentId: address, navigation: { revision }, signal, visible: true } })
  const props = { useTabInfo, loadCitation, t } as CitationProps
  const view = render(<KnowledgeCitation {...props} />)
  expect(await view.findByText('标准为每晚380元')).toBeTruthy()
  expect(loadCitation).toHaveBeenLastCalledWith(address, false, 1, expect.any(AbortSignal))
  fireEvent.click(view.getByRole('button', { name: '阅读文档' }))
  await waitFor(() => { expect(loadCitation).toHaveBeenLastCalledWith(address, true, 1, expect.any(AbortSignal)) })
  revision = 2
  view.rerender(<KnowledgeCitation {...props} />)
  await waitFor(() => { expect(loadCitation).toHaveBeenLastCalledWith(address, false, 1, expect.any(AbortSignal)) })
  expect(view.container.querySelector('img')).toBeNull()
})

it('clears source text after a revoked or changed source and ignores abandoned reads', async () => {
  const signal = new AbortController().signal
  const loadCitation = vi.fn<CitationProps['loadCitation']>(() => Promise.resolve(content))
  const props = {
    useTabInfo: () => ({ tab: { contentId: address, navigation: { revision: 1 }, signal, visible: true } }),
    loadCitation,
    t,
  } as CitationProps
  const view = render(<KnowledgeCitation {...props} />)
  expect(await view.findByText('标准为每晚380元')).toBeTruthy()
  loadCitation.mockRejectedValueOnce(new Error(zh['citation.changed']))
  fireEvent.click(view.getByRole('button', { name: '重新读取' }))
  expect(await view.findByRole('alert')).toHaveProperty('textContent', zh['citation.changed'])
  expect(view.queryByText('标准为每晚380元')).toBeNull()
  const lastSignal = loadCitation.mock.calls.at(-1)?.[3]
  view.unmount()
  expect(lastSignal?.aborted).toBe(true)
})

it('refuses foreign URLs and malformed source identifiers', () => {
  expect(citationSource(address)).toMatchObject({ chunk_no: 'chunk-a', source_hash_snapshot: 'a'.repeat(64) })
  expect(citationSource('https://engine/private')).toBeUndefined()
  expect(citationSource(`${address}?token=secret`)).toBeUndefined()
  expect(citationSource(address.replace('chunk-a', '../other'))).toBeUndefined()
})
