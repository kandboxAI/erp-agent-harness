/** Opens ERP desktop questions or the latest existing Session in embedded chat. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'

type AssistantCommand = { kind: 'prompt'; prompt: string } | { kind: 'recent' }

interface DesktopAssistantPromptBridge {
  takeAssistantCommands(): Promise<AssistantCommand[]>
  onAssistantCommand(listener: (command: AssistantCommand) => void): () => void
}

function waitForCatalog(ctx: ClientContext, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  const ready = () => ctx.sessions.list.getSnapshot().phase === 'ready'
    && ctx.workspaces.list.getSnapshot().phase === 'ready'
  if (ready()) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    let stopSessions = () => {}
    let stopWorkspaces = () => {}
    const finish = (available: boolean): void => {
      if (settled) return
      settled = true
      stopSessions()
      stopWorkspaces()
      signal.removeEventListener('abort', abort)
      resolve(available)
    }
    const abort = (): void => { finish(false) }
    const check = (): void => { if (ready()) finish(true) }
    stopSessions = ctx.sessions.list.subscribe(check)
    stopWorkspaces = ctx.workspaces.list.subscribe(check)
    signal.addEventListener('abort', abort, { once: true })
    check()
  })
}

/**
 * Register the Electron assistant-command receiver after the Client services are ready.
 * @param ctx - Client services used to create or resume a conversation.
 * @returns Cleanup for the renderer listener.
 */
export function receiveDesktopAssistantPrompts(ctx: ClientContext): () => void {
  if (typeof window === 'undefined') return () => {}
  if (!new URLSearchParams(window.location.search).has('erp_embedded_chat')) return () => {}
  const bridge = (window as Window & { erpDesktop?: DesktopAssistantPromptBridge }).erpDesktop
  if (bridge === undefined) return () => {}
  let active = true
  const lifetime = new AbortController()
  let chain = Promise.resolve()
  const receive = (command: AssistantCommand): void => {
    chain = chain.then(async () => {
      if (!active) return
      if (command.kind === 'recent') {
        if (!await waitForCatalog(ctx, lifetime.signal) || !active) return
        const catalog = ctx.sessions.list.getSnapshot()
        const archived = new Set(ctx.workspaces.list.getSnapshot().archivedSessionIds)
        const recent = catalog.ids
          .flatMap((id) => {
            const summary = catalog.byId[id]
            return summary !== undefined && !summary.blank && summary.origin !== 'subagent' && !archived.has(summary.id)
              ? [summary] : []
          })
          .sort((left, right) => right.updatedAt - left.updatedAt)[0]
        if (recent !== undefined) ctx.uiWorkspace.openSession(recent.id)
        return
      }
      const prompt = command.prompt.trim()
      if (prompt === '') return
      const sessionId = await ctx.sessions.create()
      if (!active) return
      ctx.uiWorkspace.openSession(sessionId)
      await ctx.sessions.using(sessionId, { source: 'controllerOperation' }, async (reference) => {
        await reference.ready
        if (!active) return
        const result = await reference.binding.session.prompt([{ type: 'text', text: prompt }], 'queue')
        if (!result.ok) throw new Error(`ERP assistant prompt failed: ${result.error.code}: ${result.error.message}`)
      })
    }).catch((error: unknown) => {
      console.error('ERP assistant prompt failed:', error)
    })
  }
  const stop = bridge.onAssistantCommand(receive)
  void bridge.takeAssistantCommands().then((commands) => {
    if (active) commands.forEach(receive)
  }).catch((error: unknown) => {
    console.error('ERP assistant prompt intake failed:', error)
  })
  return () => { active = false; lifetime.abort(); stop() }
}
