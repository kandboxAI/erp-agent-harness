import { afterEach, describe, expect, it, vi } from 'vitest'
import { forwardErpApiRequest, resolveErpDesktopConfig } from '../src/erp-desktop-config.ts'

afterEach(() => vi.unstubAllGlobals())

describe('ERP desktop entry and API boundary', () => {
  it('accepts a local Vite server in development and requires HTTPS for packaged ERP', () => {
    expect(resolveErpDesktopConfig({ packaged: false, devUrl: 'http://127.0.0.1:8848/', packagedStaticDirectory: 'erp' })?.pageUrl)
      .toBe('http://127.0.0.1:8848/')
    expect(() => resolveErpDesktopConfig({ packaged: false, devUrl: 'http://example.com/', packagedStaticDirectory: 'erp' }))
      .toThrow('local HTTP')
    expect(() => resolveErpDesktopConfig({ packaged: true, packagedApiUrl: 'http://example.com/', packagedStaticDirectory: 'erp' }))
      .toThrow('HTTPS')
    expect(() => resolveErpDesktopConfig({ packaged: true, packagedLocalTest: true,
      packagedApiUrl: 'http://example.com/', packagedStaticDirectory: 'erp' })).toThrow('HTTPS')
    expect(resolveErpDesktopConfig({ packaged: true, packagedLocalTest: true,
      packagedApiUrl: 'http://127.0.0.1:8000/', packagedStaticDirectory: 'erp' }))
      .toMatchObject({ pageUrl: 'dsh-app://erp/', apiUrl: 'http://127.0.0.1:8000' })
    expect(resolveErpDesktopConfig({ packaged: true, packagedApiUrl: 'https://erp.example.com/', packagedStaticDirectory: 'erp' }))
      .toMatchObject({ pageUrl: 'dsh-app://erp/', apiUrl: 'https://erp.example.com' })
  })

  it('forwards only ERP API calls and never relays cookies or server set-cookie', async () => {
    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
      expect(init.headers).toBeInstanceOf(Headers)
      expect((init.headers as Headers).get('authorization')).toBe('Bearer test')
      expect((init.headers as Headers).has('cookie')).toBe(false)
      return new Response('{"ok":true}', { headers: { 'set-cookie': 'secret=1', 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const blocked = await forwardErpApiRequest(new Request('dsh-app://erp/api/test', {
      headers: { origin: 'dsh-app://app' },
    }), 'https://erp.example.com')
    expect(blocked.status).toBe(403)
    expect(fetchMock).not.toHaveBeenCalled()
    const response = await forwardErpApiRequest(new Request('dsh-app://erp/api/test?limit=2', {
      headers: { origin: 'dsh-app://erp', cookie: 'secret=1', authorization: 'Bearer test' },
    }), 'https://erp.example.com')
    expect(fetchMock.mock.calls[0]?.[0].href).toBe('https://erp.example.com/api/test?limit=2')
    expect(response.headers.has('set-cookie')).toBe(false)
    expect(await response.json()).toEqual({ ok: true })
  })
})
