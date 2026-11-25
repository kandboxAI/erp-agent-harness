/** Browser-only ERP bearer binding for the currently selected Harness Session. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ErpAssistantState } from './assistant-controller.ts'

const CREDENTIAL_PATH = '/api/erp/credential'

async function publish(sessionId: SessionId, accessToken: string | null): Promise<void> {
  const response = await fetch(CREDENTIAL_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, accessToken }),
  })
  if (!response.ok) throw new Error(`ERP credential binding failed (HTTP ${String(response.status)})`)
}

/** Keep the ERP token outside Session events, model arguments, and browser stores. */
export class ErpCredentialBinding {
  private accessToken: string | null = null
  private readonly bound = new Map<SessionId, string>()
  private pending: Promise<void> = Promise.resolve()
  private selected: SessionId | undefined

  constructor(
    private readonly assistant: HostObservable<ErpAssistantState>,
    private readonly publishCredential: (sessionId: SessionId, accessToken: string | null) => Promise<void> = publish,
  ) {}

  start(): () => Promise<void> {
    this.selected = this.assistant.getSnapshot().sessionId
    const unsubscribe = this.assistant.subscribe(() => {
      const selected = this.assistant.getSnapshot().sessionId
      if (selected === this.selected) return
      this.selected = selected
      void this.reconcile().catch(() => undefined)
    })
    const interval = setInterval(() => { void this.reconcile(true).catch(() => undefined) }, 20_000)
    return async () => {
      unsubscribe()
      clearInterval(interval)
      this.accessToken = null
      await this.reconcile()
    }
  }

  update(accessToken: string | null): Promise<void> {
    this.accessToken = accessToken
    return this.reconcile()
  }

  reconcile(renew = false): Promise<void> {
    this.pending = this.pending.catch(() => undefined).then(async () => {
      const selected = this.assistant.getSnapshot().sessionId
      const accessToken = this.accessToken
      for (const [sessionId, previous] of this.bound) {
        if (sessionId === selected && previous === accessToken) continue
        await this.publishCredential(sessionId, null)
        this.bound.delete(sessionId)
      }
      if (selected !== undefined && accessToken !== null && (renew || this.bound.get(selected) !== accessToken)) {
        await this.publishCredential(selected, accessToken)
        this.bound.set(selected, accessToken)
      }
    })
    return this.pending
  }
}
