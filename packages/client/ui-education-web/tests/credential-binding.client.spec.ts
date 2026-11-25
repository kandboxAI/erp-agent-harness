import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { EducationCredentialBinding } from '../src/client/credential-binding.ts'
import type { EducationAssistantState } from '../src/client/assistant-controller.ts'

describe('education credential binding', () => {
  it('replaces the active Session credential and revokes it on logout', async () => {
    let selected = 'session-a' as SessionId
    const listeners = new Set<() => void>()
    const state = {
      getSnapshot: () => ({ sessionId: selected }) as EducationAssistantState,
      subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    } as HostObservable<EducationAssistantState>
    const calls: Array<[SessionId, string | null]> = []
    const binding = new EducationCredentialBinding(state, async (sessionId, accessToken) => {
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
