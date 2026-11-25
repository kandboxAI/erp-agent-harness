// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { DocumentTitle } from '../src/client/DocumentTitle.tsx'

let originalTitle: string
beforeEach(() => { originalTitle = document.title })

afterEach(() => {
  try { cleanup() } finally { document.title = originalTitle }
})

describe('DocumentTitle', () => {
  it('replaces the previous Session title with the configured product title', () => {
    document.title = 'Previous Session — DeepSeek Harness'
    const mounted = render(<DocumentTitle productTitle="DeepSeek Harness" />)
    expect(document.title).toBe('DeepSeek Harness')
    mounted.unmount()
    expect(document.title).toBe('DeepSeek Harness')
  })

  it('follows changes to the localized product title', () => {
    const mounted = render(<DocumentTitle productTitle="DSH Local Build" />)
    expect(document.title).toBe('DSH Local Build')
    mounted.rerender(<DocumentTitle productTitle="DeepSeek Harness" />)
    expect(document.title).toBe('DeepSeek Harness')
    mounted.unmount()
    expect(document.title).toBe('DeepSeek Harness')
  })
})
