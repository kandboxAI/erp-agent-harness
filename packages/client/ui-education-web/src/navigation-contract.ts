/** Same-origin Harness endpoint streaming navigation commands to the browser plugin. */
export const NAVIGATION_EVENTS_PATH = '/api/education-web/navigation/events'

/** Same-origin Harness endpoint accepting iframe navigation acknowledgements. */
export const NAVIGATION_ACK_PATH = '/api/education-web/navigation/ack'

/** Query parameter carrying the per-frame bridge token. */
export const BRIDGE_TOKEN_QUERY = '__dsh_education_bridge'

/** Primitive query values accepted by Vue Router through the bridge. */
export type NavigationQueryValue = string | number | boolean | null

/** Command sent from the Harness Host to its browser plugin. */
export interface NavigationCommand {
  requestId: string
  path: string
  query: Record<string, NavigationQueryValue>
  replace: boolean
}

/** Result sent by the education iframe after Vue Router settles. */
export interface NavigationAck {
  requestId: string
  ok: boolean
  actualPath?: string
  message?: string
}

/** Safe, router-derived context reported by the embedded education application. */
export interface EducationPageContext {
  path: string
  fullPath: string
  title?: string
  entity?: string
  params: Record<string, NavigationQueryValue>
  query: Record<string, NavigationQueryValue>
}

/** Return whether a value is a bounded absolute path inside the education SPA. */
export function isAllowedEducationPath(path: string): boolean {
  if (path.length === 0 || path.length > 2_048) return false
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('\0')) return false
  if (path.includes('?') || path.includes('#')) return false
  if (/[\u0000-\u001f\u007f]/u.test(path)) return false
  try {
    const decoded = decodeURIComponent(path)
    return decoded.startsWith('/')
      && !decoded.startsWith('//')
      && !decoded.includes('\\')
      && !decoded.includes('\0')
      && !decoded.includes('?')
      && !decoded.includes('#')
      && !/[\u0000-\u001f\u007f]/u.test(decoded)
  } catch {
    return false
  }
}
