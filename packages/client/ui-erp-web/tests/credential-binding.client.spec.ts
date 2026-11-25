import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { ErpCredentialBinding } from '../src/client/credential-binding.ts'
import type { ErpAssistantState } from '../src/client/assistant-controller.ts'

describe('ERP credential binding', () => {
  it('replaces the active Session credential and revokes it on logout', async () => {
    let selected = 'session-a' as SessionId
    const listeners = new Set<() => void>()
    const state = {
      getSnapshot: () => ({ sessionId: selected }) as ErpAssistantState,
      subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    } as HostObservable<ErpAssistantState>
    const calls: Array<[SessionId, string | null]> = []
    const binding = new ErpCredentialBinding(state, async (sessionId, accessToken) => {
      calls.push([sessionId, accessToken])
    })
    const stop = binding.start()
    try {
      await binding.update('alice-token')
      selected = 'session-b' as SessionId
      for (const listener of listeners) listener()
      await binding.reconcile()
      await binding.update(null)
      expect(calls).toEqual([
        ['session-a', 'alice-token'],
        ['session-a', null],
        ['session-b', 'alice-token'],
        ['session-b', null],
      ])
    } finally {
      await stop()
    }
  })
})
