import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { receiveDesktopAssistantPrompts } from '../src/client/desktop-erp-prompt.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('ERP desktop assistant prompts', () => {
  it('submits buffered and later questions once in separate selected Sessions', async () => {
    let listener: ((command: { kind: 'prompt'; prompt: string } | { kind: 'recent' }) => void) | undefined
    const stopListener = vi.fn()
    vi.stubGlobal('window', {
      location: { search: '?erp_embedded_chat=1' },
      erpDesktop: {
        takeAssistantCommands: async () => [{ kind: 'prompt', prompt: '第一问' }],
        onAssistantCommand: (callback: (command: { kind: 'prompt'; prompt: string } | { kind: 'recent' }) => void) => {
          listener = callback
          return stopListener
        },
      },
    })
    const prompt = vi.fn(async (_blocks: Array<{ type: 'text'; text: string }>, _mode: string) => ({ ok: true }))
    const openSession = vi.fn((_id: string) => {})
    let counter = 0
    const ctx = {
      sessions: {
        create: async () => `session-${++counter}`,
        using: async (_id: string, _options: unknown, action: (reference: unknown) => Promise<void>) => {
          await action({ ready: Promise.resolve(), binding: { session: { prompt } } })
        },
      },
      uiWorkspace: { openSession },
    } as unknown as ClientContext

    const stop = receiveDesktopAssistantPrompts(ctx)
    await vi.waitFor(() => { expect(prompt).toHaveBeenCalledTimes(1) })
    listener?.({ kind: 'prompt', prompt: '第二问' })
    await vi.waitFor(() => { expect(prompt).toHaveBeenCalledTimes(2) })
    expect(openSession.mock.calls.map(([id]) => id)).toEqual(['session-1', 'session-2'])
    expect(prompt.mock.calls.map(([blocks]) => blocks)).toEqual([
      [{ type: 'text', text: '第一问' }],
      [{ type: 'text', text: '第二问' }],
    ])
    stop()
    expect(stopListener).toHaveBeenCalledOnce()
  })

  it('opens the newest nonblank, unarchived Session without creating another', async () => {
    vi.stubGlobal('window', {
      location: { search: '?erp_embedded_chat=1' },
      erpDesktop: {
        takeAssistantCommands: async () => [{ kind: 'recent' }],
        onAssistantCommand: () => () => {},
      },
    })
    const create = vi.fn()
    const openSession = vi.fn()
    const ctx = {
      sessions: {
        create,
        list: { getSnapshot: () => ({
          phase: 'ready', ids: ['blank', 'archived', 'older', 'latest'],
          byId: {
            blank: { id: 'blank', blank: true, updatedAt: 400 },
            archived: { id: 'archived', blank: false, updatedAt: 300 },
            older: { id: 'older', blank: false, updatedAt: 100 },
            latest: { id: 'latest', blank: false, updatedAt: 200 },
          },
        }) },
      },
      workspaces: { list: { getSnapshot: () => ({ phase: 'ready', archivedSessionIds: ['archived'] }) } },
      uiWorkspace: { openSession },
    } as unknown as ClientContext

    const stop = receiveDesktopAssistantPrompts(ctx)
    await vi.waitFor(() => { expect(openSession).toHaveBeenCalledWith('latest') })
    expect(create).not.toHaveBeenCalled()
    stop()
  })

  it('waits for the Session list before resuming an existing conversation', async () => {
    vi.stubGlobal('window', {
      location: { search: '?erp_embedded_chat=1' },
      erpDesktop: {
        takeAssistantCommands: async () => [{ kind: 'recent' }],
        onAssistantCommand: () => () => {},
      },
    })
    let phase = 'pending'
    let notify = () => {}
    const subscribe = vi.fn((listener: () => void) => {
      notify = listener
      return () => {}
    })
    const openSession = vi.fn()
    const ctx = {
      sessions: { list: {
        getSnapshot: () => ({ phase, ids: ['existing'], byId: { existing: { id: 'existing', blank: false, updatedAt: 1 } } }),
        subscribe,
      } },
      workspaces: { list: {
        getSnapshot: () => ({ phase: 'ready', archivedSessionIds: [] }),
        subscribe: () => () => {},
      } },
      uiWorkspace: { openSession },
    } as unknown as ClientContext

    const stop = receiveDesktopAssistantPrompts(ctx)
    await vi.waitFor(() => { expect(subscribe).toHaveBeenCalledOnce() })
    expect(openSession).not.toHaveBeenCalled()
    phase = 'ready'
    notify()
    await vi.waitFor(() => { expect(openSession).toHaveBeenCalledWith('existing') })
    stop()
  })
})
