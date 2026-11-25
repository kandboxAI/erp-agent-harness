/** Browser-side receiver for Host navigation commands and iframe acknowledgements. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ILayout, MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import {
  NAVIGATION_ACK_PATH,
  NAVIGATION_EVENTS_PATH,
  isAllowedEducationPath,
  type NavigationAck,
  type NavigationCommand,
  type NavigationQueryValue,
} from '../navigation-contract.ts'

type EventSourceFactory = (url: string) => EventSource
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function parseQuery(value: unknown): Record<string, NavigationQueryValue> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const query: Record<string, NavigationQueryValue> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean' && item !== null) {
      return undefined
    }
    query[key] = item
  }
  return query
}

/** Parse one untrusted SSE command before exposing it to the iframe. */
export function parseNavigationCommand(raw: string): NavigationCommand | undefined {
  try {
    const value = JSON.parse(raw) as unknown
    if (value === null || typeof value !== 'object') return undefined
    const row = value as Record<string, unknown>
    const query = parseQuery(row.query)
    if (
      typeof row.requestId !== 'string'
      || typeof row.path !== 'string'
      || !isAllowedEducationPath(row.path)
      || query === undefined
      || typeof row.replace !== 'boolean'
    ) return undefined
    return { requestId: row.requestId, path: row.path, query, replace: row.replace }
  } catch {
    return undefined
  }
}

/** Own the EventSource lifecycle and publish the latest navigation command. */
export class EducationNavigationController {
  readonly state: SnapshotStore<NavigationCommand | null> = createSnapshotStore<NavigationCommand | null>(null)
  private source: EventSource | undefined

  constructor(
    private readonly layout: ILayout,
    private readonly panelId: MainPanelId,
    private readonly eventSourceFactory: EventSourceFactory = url => new EventSource(url),
    private readonly fetcher: FetchLike = (input, init) => fetch(input, init),
  ) {}

  /** Connect to the same-origin Host command stream. */
  start(): () => void {
    if (this.source !== undefined) throw new Error('education navigation controller already started')
    const source = this.eventSourceFactory(NAVIGATION_EVENTS_PATH)
    this.source = source
    source.onmessage = (event) => {
      const command = parseNavigationCommand(event.data)
      if (command === undefined) {
        console.warn('[education-web] ignored malformed navigation command')
        return
      }
      this.layout.selectPanel(this.panelId)
      this.state.set(command)
    }
    source.onerror = () => {
      console.warn('[education-web] navigation stream disconnected; EventSource will retry')
    }
    return () => {
      if (this.source !== source) return
      this.source = undefined
      source.close()
      this.state.set(null)
    }
  }

  /** Forward the iframe's settled router result to the waiting Host tool. */
  async acknowledge(ack: NavigationAck): Promise<void> {
    const response = await this.fetcher(NAVIGATION_ACK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ack),
    })
    if (!response.ok && response.status !== 410) {
      throw new Error(`education navigation acknowledgement failed: HTTP ${String(response.status)}`)
    }
  }
}
