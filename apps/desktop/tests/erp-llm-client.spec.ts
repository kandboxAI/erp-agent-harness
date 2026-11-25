import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErpLlmCredentialManager } from '../src/erp-llm-client.ts'

describe('ERP model credential binding', () => {
  afterEach(() => { vi.useRealTimers() })

  it('recovers after a backend restart without discarding a still-valid credential or signing out', async () => {
    vi.useFakeTimers()
    let online = true
    const published: Array<string | null> = []
    const expired = vi.fn()
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === 'DELETE') return new Response(null, { status: 200 })
      if (!online) throw new TypeError('fetch failed')
      return Response.json({ code: 0, data: { access_token: 'gateway-token', expires_in: 120 } })
    })
    const manager = new ErpLlmCredentialManager('http://127.0.0.1:8000', fetcher, token => published.push(token), expired)
    await manager.bind('erp-access-token-123456')
    online = false
    await vi.advanceTimersByTimeAsync(60_000)
    expect(published.at(-1)).toBe('gateway-token')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(published.at(-1)).toBeNull()
    expect(expired).not.toHaveBeenCalled()
    online = true
    await vi.advanceTimersByTimeAsync(30_000)
    expect(published.at(-1)).toBe('gateway-token')
    manager.clear()
  })

  it('asks ERP to refresh a rejected login once and accepts the renewed login in the same manager', async () => {
    vi.useFakeTimers()
    const expired = vi.fn()
    let authorized = true
    const published: Array<string | null> = []
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === 'DELETE') return new Response(null, { status: 200 })
      if (!authorized) return new Response(null, { status: 401 })
      return Response.json({ code: 0, data: { access_token: 'gateway-token', expires_in: 120 } })
    })
    const manager = new ErpLlmCredentialManager('https://erp.example.com', fetcher, token => published.push(token), expired)
    await manager.bind('erp-access-token-123456')
    authorized = false
    await vi.advanceTimersByTimeAsync(60_000)
    expect(expired).toHaveBeenCalledTimes(1)
    expect(published.at(-1)).toBeNull()
    const count = fetcher.mock.calls.length
    await vi.advanceTimersByTimeAsync(120_000)
    await expect(manager.ensure()).rejects.toThrow('登录已失效')
    expect(fetcher.mock.calls).toHaveLength(count)
    authorized = true
    await manager.bind('renewed-access-token-123456')
    expect(published.at(-1)).toBe('gateway-token')
    manager.clear()
  })

  it('notifies ERP for a tool API 401 but never for a service outage', async () => {
    const expired = vi.fn()
    const fetcher = vi.fn(async (url: string) => url.endsWith('/credential')
      ? Response.json({ code: 0, data: { access_token: 'gateway-token', expires_in: 600 } })
      : new Response('{}', { status: 401 }))
    const manager = new ErpLlmCredentialManager('https://erp.example.com', fetcher, () => {}, expired)
    await manager.bind('erp-access-token-123456')
    await expect(manager.requestErpApi('POST', '/api/harness/query', '{}')).rejects.toThrow('登录已失效')
    expect(expired).toHaveBeenCalledTimes(1)
    manager.clear()
  })

  it('cancels outage retries on logout and ignores a stale account rejection', async () => {
    vi.useFakeTimers()
    const expired = vi.fn()
    let release: ((response: Response) => void) | undefined
    const fetcher = vi.fn((_url: string, init: RequestInit) => {
      if (init.method === 'DELETE') return Promise.resolve(new Response(null, { status: 200 }))
      return new Promise<Response>((resolve) => { release = resolve })
    })
    const manager = new ErpLlmCredentialManager('https://erp.example.com', fetcher, () => {}, expired)
    const binding = manager.bind('erp-access-token-123456')
    manager.clear()
    release?.(new Response(null, { status: 401 }))
    await binding
    await vi.advanceTimersByTimeAsync(120_000)
    expect(expired).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('proxies ERP tool requests with the current login and blocks other origins', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/api/llm-gateway/credential')) {
        return Response.json({ code: 0, data: { access_token: 'gateway-token', expires_in: 600 } })
      }
      return Response.json({ code: 0, data: { resources: [] } })
    })
    const manager = new ErpLlmCredentialManager('https://erp.example.com/', fetcher, () => {})
    await manager.bind('erp-access-token-123456')
    const reply = await manager.requestErpApi('POST', '/api/harness/query', '{"operation":"catalog"}')
    expect(reply.status).toBe(200)
    expect(calls.at(-1)?.init.headers).toMatchObject({ authorization: 'Bearer erp-access-token-123456' })
    await manager.requestErpApi('POST', '/api/harness/discovery', '{"action":"search","question":"教师人数"}')
    expect(calls.at(-1)?.url).toBe('https://erp.example.com/api/harness/discovery')
    expect(calls.at(-1)?.init.headers).toMatchObject({ authorization: 'Bearer erp-access-token-123456' })
    await manager.requestErpApi('POST', '/api/harness/write-approval', '{"method":"POST","path":"/api/business/change"}')
    expect(calls.at(-1)?.url).toBe('https://erp.example.com/api/harness/write-approval')
    expect(calls.at(-1)?.init.headers).toMatchObject({ authorization: 'Bearer erp-access-token-123456' })
    const attachment = JSON.stringify({ method: 'POST',
      path: '/api/knowledge/bases/01900000-0000-7000-8000-000000000001/documents/upload',
      body: { content_base64: 'a'.repeat(300_000) },
    })
    await manager.requestErpApi('POST', '/api/harness/api', attachment)
    expect(calls.at(-1)?.init.body).toBe(attachment)
    await expect(manager.requestErpApi('POST', '/api/harness/api',
      attachment.replace('/documents/upload', '/documents/manual'))).rejects.toThrow('请求体无效')
    await manager.requestErpApi('GET', '/api/plugins/ai-capabilities', null)
    expect(calls.at(-1)?.url).toBe('https://erp.example.com/api/plugins/ai-capabilities')
    await manager.requestErpApi('GET', '/api/ai/context/prompt', null)
    expect(calls.at(-1)?.url).toBe('https://erp.example.com/api/ai/context/prompt')
    await manager.requestErpApi('GET', '/api/ai/context/mine', null)
    await manager.requestErpApi('PUT', '/api/ai/context/mine', JSON.stringify({ instructions: '简洁回答' }))
    expect(calls.at(-1)?.url).toBe('https://erp.example.com/api/ai/context/mine')
    expect(calls.at(-1)?.init.headers).toMatchObject({ authorization: 'Bearer erp-access-token-123456' })
    await expect(manager.requestErpApi('GET', '/api/ai/context/templates', null)).rejects.toThrow('无效')
    await expect(manager.requestErpApi('PUT', '/api/ai/context/prompt', '{}')).rejects.toThrow('无效')
    await expect(manager.requestErpApi('GET', '/api/ai/context/prompt?user_id=other', null)).rejects.toThrow('无效')

    expect(calls.at(-1)?.init.headers).toMatchObject({ authorization: 'Bearer erp-access-token-123456' })
    await manager.requestErpApi('POST', '/api/harness/navigation', '{"menu_key":"MesWorkOrders"}')
    expect(calls.at(-1)?.url).toBe('https://erp.example.com/api/harness/navigation')
    await expect(manager.requestErpApi('GET', '//other.example/api/users', null)).rejects.toThrow('无效')
    await manager.requestErpApi('POST', '/api/ai_control/feedback', '{"answer_snapshot":"confirmed excerpt"}')
    expect(calls.at(-1)?.url).toBe('https://erp.example.com/api/ai_control/feedback')
    await manager.requestErpApi('POST', '/api/ai_control/feedback/status', '{"dsh_message_no":"m-1"}')
    expect(calls.at(-1)?.init.headers).toMatchObject({ authorization: 'Bearer erp-access-token-123456' })
    await expect(manager.requestErpApi('POST', '/api/ai_control/queue', '{}')).rejects.toThrow('不允许')
    await expect(manager.requestErpApi('POST', '/private', '{}')).rejects.toThrow('不允许')
    await expect(manager.requestErpApi('POST', '/api/users', '{}')).rejects.toThrow('不允许')
    manager.clear()
    await expect(manager.requestErpApi('GET', '/api/users', null)).rejects.toThrow('请先登录')
  })
  it('keeps the provider key on the server and revokes the local credential on logout', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const published: Array<string | null> = []
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      if (init.method === 'DELETE') return new Response(null, { status: 200 })
      return Response.json({ code: 0, data: { access_token: 'short-lived-token', expires_in: 600 } })
    })
    const manager = new ErpLlmCredentialManager('https://erp.example.com/', fetcher, token => published.push(token))
    await manager.bind('erp-access-token-123456')
    expect(calls[0]?.url).toBe('https://erp.example.com/api/llm-gateway/credential')
    expect(calls[0]?.init.headers).toMatchObject({ authorization: 'Bearer erp-access-token-123456' })
    expect(published.at(-1)).toBe('short-lived-token')
    manager.clear()
    expect(published.at(-1)).toBeNull()
    expect(calls[1]?.init).toMatchObject({ method: 'DELETE', headers: { 'x-api-key': 'short-lived-token' } })
    await expect(manager.ensure()).rejects.toThrow('Log in to ERP')
  })

  it('does not publish a credential issued for the account that was replaced', async () => {
    let releaseFirst: ((response: Response) => void) | undefined
    const fetcher = vi.fn((_: string, init: RequestInit) => {
      if (init.method === 'DELETE') return Promise.resolve(new Response(null, { status: 200 }))
      if ((init.headers as Record<string, string>).authorization === 'Bearer first-account-token') {
        return new Promise<Response>((resolve) => { releaseFirst = resolve })
      }
      return Promise.resolve(Response.json({ code: 0, data: { access_token: 'new-token', expires_in: 600 } }))
    })
    const published: Array<string | null> = []
    const manager = new ErpLlmCredentialManager('https://erp.example.com', fetcher, token => published.push(token))
    const first = manager.bind('first-account-token')
    const second = manager.bind('second-account-token')
    releaseFirst?.(Response.json({ code: 0, data: { access_token: 'old-token', expires_in: 600 } }))
    await Promise.all([first, second])
    expect(published).not.toContain('old-token')
    expect(published.at(-1)).toBe('new-token')
    expect(fetcher.mock.calls.some(([, init]) => init.method === 'DELETE')).toBe(true)
    manager.clear()
  })
})


it('uploads feedback images to signed storage without sending the ERP token to storage', async () => {
  const requests: { url: string; init: RequestInit }[] = []
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, init })
    if (url.endsWith('/api/llm-gateway/credential')) return Response.json({ code: 0, data: { access_token: 'gateway-token', expires_in: 600 } })
    if (url.endsWith('/upload-ticket')) return Response.json({ code: 0, data: { id: 'image-1', upload: {
      method: 'PUT', url: 'https://storage.example.com/signed-image', headers: { 'Content-Type': 'image/png', 'Content-MD5': 'ticket-md5' },
    } } })
    if (init.method === 'PUT') return new Response(null, { status: 200 })
    return Response.json({ code: 0, data: { id: 'image-1', file_name: 'clipboard.png' } })
  })
  const manager = new ErpLlmCredentialManager('https://erp.example.com', fetcher, () => {})
  try {
    await manager.bind('erp-access-token-123456')
    const bytes = Buffer.from('chosen image bytes')
    const response = await manager.uploadFeedbackImage(JSON.stringify({ file_name: 'clipboard.png', content_type: 'image/png', content_base64: bytes.toString('base64') }))
    expect(JSON.parse(response.body)).toMatchObject({ code: 0, data: { id: 'image-1' } })
    const upload = requests.find(request => request.init.method === 'PUT')!
    expect(upload.url).toBe('https://storage.example.com/signed-image')
    expect(new Headers(upload.init.headers).has('authorization')).toBe(false)
    expect(upload.init.body).toEqual(bytes)
    const ticket = requests.find(request => request.url.endsWith('/upload-ticket'))!
    expect(new Headers(ticket.init.headers).get('authorization')).toBe('Bearer erp-access-token-123456')
    expect(JSON.parse(String(ticket.init.body))).toMatchObject({ file_size: bytes.length, content_type: 'image/png' })
    expect(ticket.init.body).not.toContain('content_base64')
    const before = requests.length
    await expect(manager.uploadFeedbackImage(JSON.stringify({ file_name: 'bad.svg', content_type: 'image/svg+xml', content_base64: 'eA==' }))).rejects.toThrow('JPG')
    expect(requests).toHaveLength(before)
  } finally { manager.clear() }
})


it('checks ERP feedback permission before one independent, text-only model review', async () => {
  let allowed = true
  const requests: { url: string; init: RequestInit }[] = []
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, init })
    if (url.endsWith('/credential')) return Response.json({ code: 0, data: { access_token: 'gateway-token', expires_in: 600 } })
    if (url.endsWith('/review-access')) return Response.json({ code: allowed ? 0 : 403, data: { allowed } }, { status: allowed ? 200 : 403 })
    return Response.json({ content: [{ type: 'text', text: '{"verdict":"unknown","reason":"","evidence":""}' }] })
  })
  const manager = new ErpLlmCredentialManager('https://erp.example.com', fetcher, () => {})
  const payload = { model: 'deepseek-flash', max_tokens: 1024, stream: false, thinking: { type: 'disabled' }, system: 'review prompt',
    messages: [{ role: 'user', content: JSON.stringify({ question_snapshot: '任务', answer_snapshot: '未完成' }) }] }
  try {
    await manager.bind('erp-access-token-123456')
    await manager.reviewFeedback(JSON.stringify(payload))
    const models = () => requests.filter(request => request.url.endsWith('/anthropic/v1/messages'))
    expect(models()).toHaveLength(1)
    expect(new Headers(models()[0]!.init.headers).get('x-api-key')).toBe('gateway-token')
    expect(new Headers(models()[0]!.init.headers).get('x-erp-client-id')).toBe(manager.clientId)
    expect(models()[0]!.init.body).toBe(JSON.stringify(payload))
    allowed = false
    expect((await manager.reviewFeedback(JSON.stringify(payload))).status).toBe(403)
    expect(models()).toHaveLength(1)
    await expect(manager.reviewFeedback(JSON.stringify({ ...payload, tools: [] }))).rejects.toThrow('无效')
    const withImage = { ...payload, messages: [{ role: 'user', content: [{ type: 'image', data: 'private' }] }] }
    await expect(manager.reviewFeedback(JSON.stringify(withImage))).rejects.toThrow('本轮文字')
    expect(models()).toHaveLength(1)
  } finally { manager.clear() }
})
