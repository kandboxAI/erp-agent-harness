/** 检查项目内置微信插件的兼容补丁，不连接微信或调用模型。 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const require = createRequire(new URL('../../packages/bundle/web-app/package.json', import.meta.url))
const installed = new URL('./', pathToFileURL(require.resolve('dsh-wechat/package.json')))
const { WeChatDSHBridge } = await import(new URL('dist/bridge/bridge.js', installed))
const { DshOps } = await import(new URL('dist/dsh/ops.js', installed))
const { apply } = await import(new URL('dist/index.js', installed))

for (const outcome of ['timeout', 'confirmed']) {
  test(`重新扫码成功后，旧流程的 ${outcome} 不覆盖状态和令牌`, async t => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-wechat-login-'))
    t.after(() => rm(storageDir, { recursive: true, force: true }))
    const bridge = new WeChatDSHBridge({}, { storageDir, baseUrl: 'https://wechat.test' })
    const startLogin = bridge.startLoginFlow;
    t.mock.method(bridge, 'startLoginFlow', function () {
      this.loginTask = startLogin.call(this);
      return this.loginTask;
    });
    const monitor = t.mock.method(bridge, 'startMonitor', async () => {})
    let qrCount = 0
    let oldSignal
    const oldPolling = Promise.withResolvers()
    const oldResponse = Promise.withResolvers()
    const json = value => new Response(JSON.stringify(value))
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.ok(url.startsWith('https://wechat.test/'))
      if (url.includes('/get_bot_qrcode?')) {
        return json({ qrcode: `qr-${++qrCount}`, qrcode_img_content: `qr-url-${qrCount}` })
      }
      if (url.includes('qrcode=qr-1')) {
        oldSignal = options.signal
        oldPolling.resolve()
        // 模拟取消后仍延迟返回的旧请求，验证结果不能落盘或覆盖新状态。
        return oldResponse.promise
      }
      return json({ status: 'confirmed', bot_token: 'new-token', ilink_bot_id: 'new-bot' })
    })
    await bridge.start()
    const oldTask = bridge.loginTask
    try {
      await oldPolling.promise
      await bridge.relogin()
      await bridge.loginTask
      assert.equal(oldSignal?.aborted, true)
      assert.equal(bridge.getLoginState().phase, 'logged-in')
    } finally {
      if (outcome === 'timeout') oldResponse.reject(new Error('Login timeout (5 minutes)'))
      else oldResponse.resolve(json({ status: 'confirmed', bot_token: 'old-token', ilink_bot_id: 'old-bot' }))
      await oldTask
      await bridge.stop()
    }
    assert.deepEqual(bridge.getLoginState(), { phase: 'logged-in', botId: 'new-bot' })
    assert.equal(JSON.parse(await readFile(join(storageDir, 'auth/token.json'), 'utf8')).token, 'new-token')
    assert.equal(monitor.mock.callCount(), 1)
  })
}

for (const action of ['logout', 'stop']) {
  test(`${action} 取消正在等待的扫码请求`, async t => {
    const storageDir = await mkdtemp(join(tmpdir(), 'dsh-wechat-cancel-'))
    t.after(() => rm(storageDir, { recursive: true, force: true }))
    const bridge = new WeChatDSHBridge({}, { storageDir, baseUrl: 'https://wechat.test' })
    const startLogin = bridge.startLoginFlow;
    t.mock.method(bridge, 'startLoginFlow', function () {
      this.loginTask = startLogin.call(this);
      return this.loginTask;
    });
    const polling = Promise.withResolvers()
    let signal
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.ok(url.startsWith('https://wechat.test/'))
      if (url.includes('/get_bot_qrcode?')) {
        return new Response(JSON.stringify({ qrcode: 'qr', qrcode_img_content: 'qr-url' }))
      }
      signal = options.signal
      polling.resolve()
      return new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    await bridge.start()
    try {
      await polling.promise
      await bridge[action]()
      assert.equal(signal?.aborted, true)
      await bridge.loginTask
      assert.notEqual(bridge.getLoginState().phase, 'failed')
      await assert.rejects(readFile(join(storageDir, 'auth/token.json')), { code: 'ENOENT' })
    } finally {
      await bridge.stop()
    }
  })
}

test('微信设置名称跟随界面语言', async () => {
  let plugin
  runInNewContext(await readFile(new URL('dist/client.js', installed), 'utf8'), {
    window: { __ModuleLoader__: { load: value => { plugin = value } } },
  })
  const client = plugin.factory(() => ({ createElement: () => {} }))
  let language = 'zh'
  let dictionaries
  let section
  client.apply({
    effect: setup => setup(),
    locale: {
      register: (namespace, value) => { dictionaries = value; return () => {} },
      bind: () => key => dictionaries[language][key],
    },
    slots: {
      inject: (name, setup) => setup(),
      register: options => { section = options; return () => {} },
    },
  })
  assert.ok(client.inject.includes('locale'))
  assert.equal(section.locale, 'dsh-wechat')
  assert.equal(section.label(), '微信')
  language = 'en'
  assert.equal(section.label(), 'WeChat')
})

test('停止指令使用当前 DSH 的取消原因', async () => {
  let cause
  await WeChatDSHBridge.prototype.handleStopCommand.call({
    agents: { get: () => ({ cancel: value => { cause = value } }) },
    sendReply: async () => {},
  }, 'peer', { sessionId: 'session-test' })
  assert.deepEqual(cause, { kind: 'user' })
})

test('默认 Preset 写入当前设置字段', async () => {
  let saved
  const ops = new DshOps({ get: () => ({ describe: () => [{ ns: 'agent-preset-registry' }], update: async (...args) => { saved = args } }) })
  assert.equal(await ops.saveDefaultPreset('standard'), true)
  assert.deepEqual(saved, ['agent-preset-registry', { selectedDefault: 'standard' }])
})

test('会话列表读取缓存时不传旧的数值参数', () => {
  const header = { id: 'session-test' }
  const ops = new DshOps({ get: () => ({ cachedSnapshot: (...args) => {
    assert.deepEqual(args, [header])
    return { values: { title: '微信试用', sessionListMetadata: { lastPromptAt: 10 } } }
  } }) })
  assert.deepEqual(ops.cachedListHint(header), { title: '微信试用', lastUserMessageTime: 10 })
})

test('Cordis 卸载 effect 会停止微信桥接', async t => {
  const storageDir = await mkdtemp(join(tmpdir(), 'dsh-wechat-compat-'))
  t.after(() => rm(storageDir, { recursive: true, force: true }))
  const start = t.mock.method(WeChatDSHBridge.prototype, 'start', async () => {})
  const stop = t.mock.method(WeChatDSHBridge.prototype, 'stop', async () => {})
  const cleanups = []
  apply({
    get: () => undefined,
    on: () => () => {},
    inject: () => {},
    effect: setup => { cleanups.push(setup()) },
  }, { storageDir })
  assert.equal(start.mock.callCount(), 1)
  assert.equal(cleanups.length, 1)
  await cleanups[0]()
  assert.equal(stop.mock.callCount(), 1)
})
