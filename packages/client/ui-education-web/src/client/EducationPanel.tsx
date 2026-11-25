/** Full-height iframe surface for the ERP Web application. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  BRIDGE_TOKEN_QUERY, type EducationPageContext, type NavigationAck, type NavigationCommand,
  type NavigationQueryValue,
} from '../navigation-contract.ts'
import type {} from './locales.ts'
import css from './EducationPanel.module.css'

/** Values supplied by the plugin registration to the main panel. */
export interface EducationPanelFace {
  /** Normalized HTTP(S) address loaded by the iframe. */
  url: string
  /** Latest Host navigation command, exposed as useNavigation by the renderer. */
  hooks: {
    navigation: HostObservable<NavigationCommand | null>
  }
  /** Return an iframe router result to the waiting Host tool. */
  acknowledgeNavigation: (ack: NavigationAck) => Promise<void>
  openAssistant: () => void
  updatePageContext: (context: EducationPageContext) => void
  /** Bind only the current iframe user's bearer token to the active Harness Session. */
  updateCredential: (accessToken: string | null) => Promise<void>
}

/** Props assembled by the main slot renderer. */
export type EducationPanelProps =
  PropsRuntime<'main'>
  & PropsLocale<'educationWeb'>
  & InjectFace<EducationPanelFace>


/**
 * Render the education application inside the Harness main column.
 * @param props - Resolved application URL and locale-bound frame label.
 * @returns The embedded application panel.
 */
function isPrimitive(value: unknown): value is NavigationQueryValue {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function primitiveRecord(value: unknown): Record<string, NavigationQueryValue> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (Object.keys(value).length > 32) return undefined
  const result: Record<string, NavigationQueryValue> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key.length > 64 || !isPrimitive(item) || (typeof item === 'string' && item.length > 512)) return undefined
    result[key] = item
  }
  return result
}

function parsePageContext(value: unknown): EducationPageContext | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  const params = primitiveRecord(row.params)
  const query = primitiveRecord(row.query)
  if (
    typeof row.path !== 'string' || row.path.length > 512
    || typeof row.fullPath !== 'string' || row.fullPath.length > 2048
    || (row.title !== undefined && (typeof row.title !== 'string' || row.title.length > 256))
    || (row.entity !== undefined && (typeof row.entity !== 'string' || row.entity.length > 128))
    || params === undefined || query === undefined
  ) {
    return undefined
  }
  return {
    path: row.path,
    fullPath: row.fullPath,
    params,
    query,
    ...(typeof row.title === 'string' ? { title: row.title } : {}),
    ...(typeof row.entity === 'string' ? { entity: row.entity } : {}),
  }
}

export function EducationPanel({
  url, useNavigation, acknowledgeNavigation, openAssistant, updatePageContext, updateCredential, t,
}: EducationPanelProps): ReactNode {
  const command = useNavigation(value => value)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const dispatched = useRef<string | null>(null)
  const [readyRevision, setReadyRevision] = useState(0)
  const bridgeToken = useMemo(() => randomUUID(), [])
  const frameUrl = useMemo(() => {
    const resolved = new URL(url)
    resolved.searchParams.set(BRIDGE_TOKEN_QUERY, bridgeToken)
    return resolved.href
  }, [bridgeToken, url])
  const frameOrigin = useMemo(() => new URL(url).origin, [url])

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>): void => {
      if (event.origin !== frameOrigin || event.source !== frameRef.current?.contentWindow) return
      if (event.data === null || typeof event.data !== 'object') return
      const row = event.data as Record<string, unknown>
      if (row.token !== bridgeToken) return
      if (row.type === 'erp:credential') {
        if (row.accessToken !== null && (typeof row.accessToken !== 'string'
          || row.accessToken.length < 1 || row.accessToken.length > 8192 || /[\r\n]/.test(row.accessToken))) return
        void updateCredential(row.accessToken).catch(() => { /* The ERP tool reports an unbound login. */ })
        return
      }
      if (row.type === 'erp:bootstrap') {
        frameRef.current.contentWindow?.postMessage({ type: 'erp:init', token: bridgeToken }, frameOrigin)
        return
      }
      if (row.type === 'erp:ready') {
        setReadyRevision(revision => revision + 1)
        return
      }
      if (row.type === 'erp:page-context') {
        const context = parsePageContext(row.context)
        if (context !== undefined) updatePageContext(context)
        return
      }
      if (row.type === 'erp:assistant-open') {
        openAssistant()
        return
      }
      if (row.type !== 'erp:navigation-result' || typeof row.requestId !== 'string' || typeof row.ok !== 'boolean') {
        return
      }
      const ack: NavigationAck = {
        requestId: row.requestId,
        ok: row.ok,
        ...(typeof row.actualPath === 'string' ? { actualPath: row.actualPath } : {}),
        ...(typeof row.message === 'string' ? { message: row.message } : {}),
      }
      void acknowledgeNavigation(ack).catch((error: unknown) => {
        console.error('[education-web] failed to acknowledge navigation:', error)
      })
    }
    window.addEventListener('message', receive)
    return () => {
      window.removeEventListener('message', receive)
    }
  }, [acknowledgeNavigation, bridgeToken, frameOrigin, openAssistant, updatePageContext, updateCredential])

  useEffect(() => {
    if (command === null || readyRevision === 0 || dispatched.current === command.requestId) return
    const target = frameRef.current?.contentWindow
    if (target === undefined || target === null) return
    target.postMessage({ type: 'erp:navigate', token: bridgeToken, ...command }, frameOrigin)
    dispatched.current = command.requestId
  }, [bridgeToken, command, frameOrigin, readyRevision])

  const initializeFrame = (): void => {
    dispatched.current = null
    void updateCredential(null).catch(() => { /* The next tool call fails closed without a credential. */ })
    frameRef.current?.contentWindow?.postMessage({ type: 'erp:init', token: bridgeToken }, frameOrigin)
  }

  return (
    <section className={css.panel} data-education-web-panel>
      <iframe
        ref={frameRef}
        className={css.frame}
        data-education-web-frame
        src={frameUrl}
        title={t('frameTitle')}
        onLoad={initializeFrame}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads"
      />
    </section>
  )
}
