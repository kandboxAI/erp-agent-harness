/** Exchange the ERP login for a short-lived model gateway credential in Electron main. */
import { createHash, randomUUID } from 'node:crypto'

interface GatewayResponse {
  code: number
  data?: { access_token?: string; expires_in?: number }
}

export class ErpLlmCredentialManager {
  readonly clientId = randomUUID()
  private erpAccessToken: string | undefined
  private gatewayToken: string | undefined
  private expiresAt = 0
  private generation = 0
  private renewal: Promise<void> | undefined
  private renewalGeneration = 0
  private sessionExpired = false
  private retryDelay = 1000
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(apiOrigin: string,
    private readonly fetcher: (url: string, init: RequestInit) => Promise<Response>,
    private readonly publish: (token: string | null) => void,
    private readonly onSessionExpired: () => void = () => {}) {
    const url = new URL(apiOrigin)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || (url.protocol !== 'https:' && (url.protocol !== 'http:'
        || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
      throw new Error('ERP model gateway requires a HTTPS origin or local development HTTP')
    }
    this.apiOrigin = url.origin
  }

  private readonly apiOrigin: string

  async bind(accessToken: string): Promise<void> {
    if (accessToken.length < 16 || accessToken.length > 8192) throw new Error('Invalid ERP access token')
    if (this.erpAccessToken !== accessToken || this.sessionExpired) {
      const old = this.gatewayToken
      this.erpAccessToken = accessToken
      this.generation++
      this.sessionExpired = false
      this.retryDelay = 1000
      this.dropCredential()
      if (old) void this.revoke(old).catch(() => undefined)
    }
    await this.ensure()
  }

  async ensure(forceRenewal = false): Promise<void> {
    if (!forceRenewal && this.gatewayToken && Date.now() < this.expiresAt - 30_000) return
    if (!this.erpAccessToken) throw new Error('Log in to ERP before opening DSH')
    if (this.sessionExpired) throw new Error('ERP_SESSION_EXPIRED: ERP 登录已失效，请重新登录')
    if (this.renewal) {
      const generation = this.renewalGeneration
      try { await this.renewal } catch (error) {
        if (generation === this.generation) throw error
      }
      if (generation !== this.generation) return this.ensure(forceRenewal)
      return
    }
    const generation = this.generation
    const accessToken = this.erpAccessToken
    const run = async (): Promise<void> => {
      const response = await this.fetcher(`${this.apiOrigin}/api/llm-gateway/credential`, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: this.clientId }),
        signal: AbortSignal.timeout(15_000),
      })
      if (generation !== this.generation && !response.ok) return
      if (response.status === 401) {
        this.expireSession()
        throw new Error('ERP_SESSION_EXPIRED: ERP 登录已失效，请重新登录')
      }
      if (!response.ok) throw new Error(`ERP model gateway rejected the session (${String(response.status)})`)
      const payload = await response.json() as GatewayResponse
      const token = payload.data?.access_token
      const ttl = payload.data?.expires_in
      if (payload.code !== 0 || typeof token !== 'string' || !token || !Number.isSafeInteger(ttl)
        || ttl === undefined || ttl < 60 || ttl > 3600) throw new Error('ERP model gateway returned an invalid credential')
      if (generation !== this.generation) {
        await this.revoke(token).catch(() => undefined)
        return
      }
      const old = this.gatewayToken
      this.gatewayToken = token
      this.expiresAt = Date.now() + ttl * 1000
      this.retryDelay = 1000
      this.publish(token)
      if (old && old !== token) void this.revoke(old).catch(() => undefined)
      this.scheduleRenewal(Math.max(1000, (ttl - 60) * 1000), generation)
    }
    this.renewalGeneration = generation
    this.renewal = run().catch((error: unknown) => {
      if (generation === this.generation && !this.sessionExpired) {
        // A restart or outage does not invalidate the ERP login. Retry without discarding a valid credential.
        if (Date.now() >= this.expiresAt) this.dropCredential()
        const delay = this.gatewayToken
          ? Math.min(this.retryDelay, Math.max(1, this.expiresAt - Date.now())) : this.retryDelay
        this.retryDelay = Math.min(30_000, this.retryDelay * 2)
        this.scheduleRenewal(delay, generation)
      }
      throw error
    }).finally(() => { this.renewal = undefined })
    return this.renewal
  }

  resend(): void { this.publish(Date.now() < this.expiresAt ? this.gatewayToken ?? null : null) }

  /** Execute an authenticated ERP API request in main, where the ERP JWT stays. */
  async requestErpApi(method: string, path: string, body: string | null): Promise<{ status: number; body: string }> {
    const accessToken = this.erpAccessToken
    const generation = this.generation
    if (!accessToken) throw new Error('请先登录 ERP')
    const fixedRead = method === 'GET'
      && (path === '/api/plugins/skills' || path === '/api/plugins/ai-capabilities' || path === '/api/ai/context/prompt' || path === '/api/ai/context/mine') && body === null
    const personalWrite = method === 'PUT' && path === '/api/ai/context/mine'
    if ((!fixedRead && !personalWrite && method !== 'POST') || path.length > 4096
      || !path.startsWith('/') || path.startsWith('//') || /[\\#\u0000-\u001f\u007f]/u.test(path)) {
      throw new Error('ERP API 请求无效')
    }
    const target = new URL(path, this.apiOrigin)
    if (target.origin !== this.apiOrigin || (!fixedRead && !personalWrite
      && !['/api/harness/api', '/api/harness/query', '/api/harness/discovery', '/api/harness/write-approval', '/api/harness/navigation', '/api/ai_control/feedback', '/api/ai_control/feedback/status', '/api/ai_control/feedback/review-access', '/api/ai_control/feedback/files/upload-ticket', '/api/ai_control/feedback/files/complete', '/api/ai_control/feedback/files/discard'].includes(target.pathname))
        || target.search) throw new Error('ERP API 路径不允许访问')
    if ((!fixedRead && body === null) || (body !== null && body.length > 28_000_000)) throw new Error('ERP API 请求体无效')
    if (body !== null && body.length > 256_000) {
      const call: unknown = JSON.parse(body)
      if (!['/api/harness/api', '/api/harness/write-approval'].includes(target.pathname)
        || call === null || typeof call !== 'object' || !('method' in call) || call.method !== 'POST'
        || !('path' in call) || typeof call.path !== 'string'
        || !/^\/api\/knowledge\/bases\/[0-9a-f-]{36}\/documents\/upload$/iu.test(call.path)) {
        throw new Error('ERP API 请求体无效')
      }
    }
    const response = await this.fetcher(target.href, { method,
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json',
        ...(body === null ? {} : { 'content-type': 'application/json' }) },
      ...(body === null ? {} : { body }), redirect: 'error' })
    const raw = await response.text()
    if (generation !== this.generation) throw new Error('ERP 登录用户已切换，请重试')
    if (raw.length > 50_000) throw new Error('ERP API 响应超过 50000 字符')
    if (response.status === 401) {
      this.expireSession()
      throw new Error('ERP 登录已失效，请重新登录')
    }
    return { status: response.status, body: raw }
  }

  /**
   * Upload an explicitly selected feedback image directly to its ERP-signed storage target.
   * @param body - JSON image metadata and Base64 bytes supplied by the feedback form.
   * @returns the authenticated ERP ticket rejection or completed-file response.
   */
  async uploadFeedbackImage(body: string | null): Promise<{ status: number; body: string }> {
    if (body === null || body.length > 2_800_000) throw new Error('反馈图片不能超过 2 MB')
    const input: unknown = JSON.parse(body)
    if (input === null || typeof input !== 'object' || !('file_name' in input) || !('content_type' in input)
      || !('content_base64' in input) || typeof input.file_name !== 'string' || !input.file_name || input.file_name.length > 255
      || typeof input.content_type !== 'string' || !['image/png', 'image/jpeg', 'image/webp'].includes(input.content_type)
      || typeof input.content_base64 !== 'string') throw new Error('请选择 JPG、PNG 或 WebP 图片')
    const bytes = Buffer.from(input.content_base64, 'base64')
    if (!bytes.length || bytes.length > 2 * 1024 * 1024 || bytes.toString('base64') !== input.content_base64) {
      throw new Error('反馈图片内容无效或超过 2 MB')
    }
    const generation = this.generation
    const ticketReply = await this.requestErpApi('POST', '/api/ai_control/feedback/files/upload-ticket', JSON.stringify({
      file_name: input.file_name, content_type: input.content_type, file_size: bytes.length,
      content_md5: createHash('md5').update(bytes).digest('base64'),
    }))
    if (ticketReply.status !== 200) return ticketReply
    const ticket: unknown = JSON.parse(ticketReply.body)
    if (ticket === null || typeof ticket !== 'object' || !('code' in ticket) || ticket.code !== 0 || !('data' in ticket)
      || ticket.data === null || typeof ticket.data !== 'object' || !('id' in ticket.data) || typeof ticket.data.id !== 'string'
      || !('upload' in ticket.data) || ticket.data.upload === null || typeof ticket.data.upload !== 'object') {
      throw new Error('ERP 图片上传凭证无效')
    }
    const { id, upload } = ticket.data
    if (!('url' in upload) || typeof upload.url !== 'string' || !('method' in upload) || upload.method !== 'PUT'
      || !('headers' in upload) || upload.headers === null || typeof upload.headers !== 'object'
      || Object.values(upload.headers).some(value => typeof value !== 'string')) throw new Error('ERP 图片上传凭证无效')
    const target = new URL(upload.url, this.apiOrigin)
    // 本地开发使用 ERP 签名地址；远端对象存储只接收签名头，不接收 ERP 登录凭据。
    if (target.username || target.password || target.hash || (target.origin !== this.apiOrigin && target.protocol !== 'https:')) {
      throw new Error('ERP 图片上传地址无效')
    }
    const response = await this.fetcher(target.href, { method: 'PUT', headers: upload.headers as Record<string, string>,
      body: bytes, redirect: 'error' })
    if (generation !== this.generation) throw new Error('ERP 登录用户已切换，请重试')
    if (!response.ok) throw new Error('图片上传失败，请重新选择图片')
    return this.requestErpApi('POST', '/api/ai_control/feedback/files/complete', JSON.stringify({ file_id: id }))
  }

  /**
   * Relay one plugin-owned, text-only completion review through the existing model gateway.
   * @param body - fixed review payload containing only the authorized current question and answer.
   * @returns the permission rejection or the model gateway response, without submitting feedback.
   */
  async reviewFeedback(body: string | null): Promise<{ status: number; body: string }> {
    if (body === null || body.length > 256_000) throw new Error('完成情况复核请求无效')
    const input: unknown = JSON.parse(body)
    if (input === null || typeof input !== 'object'
      || Object.keys(input).some(key => !['model', 'max_tokens', 'stream', 'thinking', 'system', 'messages'].includes(key))
      || !('model' in input) || input.model !== 'deepseek-flash' || !('max_tokens' in input) || input.max_tokens !== 1024
      || !('stream' in input) || input.stream !== false || !('system' in input) || typeof input.system !== 'string' || input.system.length > 4000
      || !('thinking' in input) || JSON.stringify(input.thinking) !== '{"type":"disabled"}'
      || !('messages' in input) || !Array.isArray(input.messages) || input.messages.length !== 1) throw new Error('完成情况复核请求无效')
    const message: unknown = input.messages[0]
    if (message === null || typeof message !== 'object' || !('role' in message) || message.role !== 'user'
      || !('content' in message) || typeof message.content !== 'string' || Object.keys(message).length !== 2) throw new Error('复核仅允许本轮文字')
    const excerpts: unknown = JSON.parse(message.content)
    if (excerpts === null || typeof excerpts !== 'object' || Object.keys(excerpts).length !== 2
      || !('question_snapshot' in excerpts) || !('answer_snapshot' in excerpts)
      || typeof excerpts.question_snapshot !== 'string' || !excerpts.question_snapshot.trim() || excerpts.question_snapshot.length > 20000
      || typeof excerpts.answer_snapshot !== 'string' || !excerpts.answer_snapshot.trim() || excerpts.answer_snapshot.length > 20000) throw new Error('复核仅允许本轮问答片段')
    const allowed = await this.requestErpApi('POST', '/api/ai_control/feedback/review-access', '{}')
    if (allowed.status !== 200) return allowed
    const permission: unknown = JSON.parse(allowed.body)
    if (permission === null || typeof permission !== 'object' || !('code' in permission) || permission.code !== 0) return allowed
    await this.ensure()
    const generation = this.generation
    const gatewayToken = this.gatewayToken
    if (gatewayToken === undefined) throw new Error('ERP 模型网关凭据不可用，请重试')
    const response = await this.fetcher(`${this.apiOrigin}/api/llm-gateway/anthropic/v1/messages`, {
      method: 'POST', headers: { 'x-api-key': gatewayToken, 'x-erp-client-id': this.clientId,
        'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body, redirect: 'error', signal: AbortSignal.timeout(25_000),
    })
    const raw = await response.text()
    if (generation !== this.generation) throw new Error('ERP 登录用户已切换，请重试')
    if (raw.length > 50_000) throw new Error('完成情况复核响应过大')
    return { status: response.status, body: raw }
  }

  clear(): void {
    this.generation++
    this.erpAccessToken = undefined
    this.sessionExpired = false
    const old = this.gatewayToken
    this.dropCredential()
    if (old) void this.revoke(old).catch(() => undefined)
  }

  private dropCredential(): void {
    this.gatewayToken = undefined
    this.expiresAt = 0
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.publish(null)
  }

  private expireSession(): void {
    if (this.sessionExpired) return
    this.sessionExpired = true
    this.dropCredential()
    this.onSessionExpired()
  }

  private scheduleRenewal(delay: number, generation: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (generation !== this.generation || !this.erpAccessToken || this.sessionExpired) return
      // ensure owns retry scheduling; timer failures must not become unhandled rejections.
      void this.ensure(true).catch(() => undefined)
    }, delay)
    this.timer.unref()
  }

  private async revoke(token: string): Promise<void> {
    await this.fetcher(`${this.apiOrigin}/api/llm-gateway/credential`, {
      method: 'DELETE', headers: { 'x-api-key': token, 'x-erp-client-id': this.clientId },
    })
  }
}
