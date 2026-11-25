/** Resolve the ERP entry without allowing a packaged client to load arbitrary local HTTP. */
export interface ErpDesktopConfig {
  readonly pageUrl: string
  readonly pageOrigin: string
  readonly apiUrl?: string
  readonly staticDirectory?: string
}

function absoluteUrl(value: string, label: string): URL {
  let url: URL
  try { url = new URL(value) }
  catch { throw new Error(`${label} must be an absolute URL`) }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} cannot contain credentials, query, or fragment`)
  }
  return url
}

export function resolveErpDesktopConfig(options: {
  packaged: boolean
  devUrl?: string | undefined
  packagedApiUrl?: string | undefined
  packagedLocalTest?: boolean | undefined
  packagedStaticDirectory: string
}): ErpDesktopConfig | undefined {
  if (!options.packaged && options.devUrl?.trim()) {
    const url = absoluteUrl(options.devUrl.trim(), 'ERP_DEV_URL')
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new Error('ERP_DEV_URL must be a local HTTP URL')
    }
    return { pageUrl: url.href, pageOrigin: url.origin }
  }
  if (!options.packagedApiUrl?.trim()) return undefined
  const api = absoluteUrl(options.packagedApiUrl.trim(), 'ERP_API_URL')
  const localHttp = options.packagedLocalTest === true && api.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname)
  if ((!localHttp && api.protocol !== 'https:') || api.pathname !== '/') {
    throw new Error('ERP_API_URL must be an HTTPS server origin or an unsigned local-test loopback origin')
  }
  return {
    pageUrl: 'dsh-app://erp/',
    pageOrigin: 'dsh-app://erp',
    apiUrl: api.origin,
    staticDirectory: options.packagedStaticDirectory,
  }
}

/** Forward only ERP API routes to the configured server. Browser credentials stay in the ERP page. */
export async function forwardErpApiRequest(request: Request, apiOrigin: string): Promise<Response> {
  const source = new URL(request.url)
  if (!source.pathname.startsWith('/api/')) return new Response(null, { status: 404 })
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== 'dsh-app://erp') return new Response(null, { status: 403 })
  const target = new URL(source.pathname + source.search, apiOrigin)
  const headers = new Headers(request.headers)
  for (const name of ['host', 'origin', 'cookie', 'content-length', 'sec-fetch-site']) headers.delete(name)
  const init = {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? null : request.body,
    redirect: 'manual' as const,
    // Node requires duplex when forwarding a streaming request body.
    duplex: 'half' as const,
  }
  const response = await fetch(target, init)
  const outgoing = new Headers(response.headers)
  for (const name of ['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding', 'connection']) outgoing.delete(name)
  return new Response(response.body, { status: response.status, headers: outgoing })
}
