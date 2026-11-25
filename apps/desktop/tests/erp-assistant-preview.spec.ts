// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  expose: vi.fn<(name: string, api: unknown) => void>(),
  invoke: vi.fn<(channel: string, action: string) => Promise<unknown>>(),
  on: vi.fn<(channel: string, listener: () => void) => void>(),
  off: vi.fn(),
}))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, off: electron.off } }))

type Bridge = {
  setAssistantObscured: (obscured: boolean) => Promise<void>
  closeAssistant: () => Promise<void>
  clearErpSession: () => Promise<void>
  onAssistantFailed: (listener: () => void) => () => void
}
const snapshot = { dataUrl: 'data:image/png;base64,preview', bounds: { x: 20, y: 200, width: 900, height: 450 } }
let api: Bridge
const originalDecode = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode')

beforeEach(async () => {
  vi.stubGlobal('process', { ...process, isMainFrame: true })
  vi.stubGlobal('location', { origin: 'dsh-app://erp', protocol: 'dsh-app:', hostname: 'erp' })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  Object.defineProperty(HTMLImageElement.prototype, 'decode', { configurable: true, value: vi.fn(async () => {}) })
  electron.invoke.mockImplementation(async (_channel: string, action: string) => action === 'preview' ? snapshot : undefined)
  await import('../src/preload-erp.ts')
  api = electron.expose.mock.calls[0]![1] as Bridge
})

afterEach(async () => {
  await api.closeAssistant()
  if (originalDecode === undefined) Reflect.deleteProperty(HTMLImageElement.prototype, 'decode')
  else Object.defineProperty(HTMLImageElement.prototype, 'decode', originalDecode)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
  vi.clearAllMocks()
})

it('paints a non-interactive preview before hiding the native view, then removes it on reveal', async () => {
  electron.invoke.mockImplementation(async (_channel: string, action: string) => {
    if (action === 'preview') return snapshot
    if (action === 'obscure') expect(document.querySelector('img')?.src).toBe(snapshot.dataUrl)
    if (action === 'reveal') expect(document.querySelector('img')).not.toBeNull()
  })
  await api.setAssistantObscured(true)
  const image = document.querySelector('img')!
  expect(image.style.cssText).toContain('left: 20px')
  expect(image.style.cssText).toContain('height: 450px')
  expect(image.style.pointerEvents).toBe('none')
  expect(image.alt).toBe('')
  expect(image.outerHTML).toMatchInlineSnapshot('"<img alt="" data-erp-assistant-preview="" src="data:image/png;base64,preview" style="position: fixed; left: 20px; top: 200px; width: 900px; height: 450px; pointer-events: none; z-index: 1;">"')
  await api.setAssistantObscured(false)
  expect(document.querySelector('img')).toBeNull()
  expect(electron.invoke.mock.calls.map(call => call[1])).toEqual(['preview', 'obscure', 'reveal'])
})

it('does not hide the assistant when settings closes before capture finishes', async () => {
  let finish!: (value: typeof snapshot) => void
  const capture = new Promise<typeof snapshot>((resolve) => { finish = resolve })
  electron.invoke.mockImplementation(async (_channel: string, action: string) => action === 'preview' ? capture : undefined)
  const opening = api.setAssistantObscured(true)
  await api.setAssistantObscured(false)
  finish(snapshot)
  await opening
  expect(document.querySelector('img')).toBeNull()
  expect(electron.invoke.mock.calls.map(call => call[1])).toEqual(['preview', 'reveal'])
})

it.each(['closeAssistant', 'clearErpSession'] as const)('clears the retained image on %s', async (action) => {
  await api.setAssistantObscured(true)
  await api[action]()
  expect(document.querySelector('img')).toBeNull()
})

it('removes the preview when the assistant fails', async () => {
  const failed = vi.fn()
  api.onAssistantFailed(failed)
  await api.setAssistantObscured(true)
  electron.on.mock.calls[0]![1]()
  expect(document.querySelector('img')).toBeNull()
  expect(failed).toHaveBeenCalledOnce()
})

it('still opens the overlay when native capture fails', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  electron.invoke.mockRejectedValueOnce(new Error('capture unavailable'))
  await api.setAssistantObscured(true)
  expect(electron.invoke).toHaveBeenLastCalledWith('erp-desktop:assistant', 'obscure')
  expect(document.querySelector('img')).toBeNull()
})

it('does not paint a preview when no native assistant is visible', async () => {
  electron.invoke.mockResolvedValue(undefined)
  await api.setAssistantObscured(true)
  expect(document.querySelector('img')).toBeNull()
})
