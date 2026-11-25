/** The built enterprise plugin renders its icon and /feedback in the real Web app without model calls. */
import { mkdtemp, readFile, writeFile, mkdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import { launchWebScaffold, seedSession, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot, scrollIntoView } from './support.ts'

let scaffold: WebScaffold
let browser: Browser
let page: Page
let overlayDirectory: string
const submissions: Record<string, unknown>[] = []
const reviews: Record<string, unknown>[] = []
let nextReviewVerdict = 'incomplete'
let reviewUnavailable = false

beforeAll(async () => {
  const product = loadOptionalPatches('enterprise-feedback-test', fileURLToPath(new URL('../../desktop-host/erp-llm.patch.yml', import.meta.url)))
  if (product === undefined) throw new Error('ERP feedback overlay is missing')
  const overlay = product.filter(row => ['ui-message-feedback', 'message-feedback', 'command-feedback'].includes(row.id ?? '')
    || row.insert?.some(entry => entry.id === 'enterprise-ai-feedback'))
  overlayDirectory = await mkdtemp(join(tmpdir(), 'dsh-enterprise-feedback-'))
  const overlayPath = join(overlayDirectory, 'feedback.json')
  await writeFile(overlayPath, JSON.stringify(overlay))
  // 与桌面生成项目一致：CLI 与 Host 均为安装依赖，不额外注册反馈插件。
  const runtimePackages = [
    ['@deepseek-ai/dsh', '../../cli/'],
    ['@deepseek-ai/dsh-desktop-host', '../../desktop-host/'],
    ['@deepseek-ai/dsh-base', '../../../packages/bundle/base/'],
    ['@deepseek-ai/dsh-web-app', '../../../packages/bundle/web-app/'],
  ]
  const scope = join(overlayDirectory, 'node_modules', '@deepseek-ai')
  await mkdir(scope, { recursive: true })
  for (const [name, source] of runtimePackages) {
    if (name === undefined || source === undefined) throw new Error('Missing runtime package fixture')
    await symlink(fileURLToPath(new URL(source, import.meta.url)), join(overlayDirectory, 'node_modules', name), 'junction')
  }
  const installAnchor = join(overlayDirectory, 'package.json')
  await writeFile(installAnchor, JSON.stringify({ name: '@deepseek-ai/dsh-desktop-runtime', private: true,
    dependencies: { '@deepseek-ai/dsh': '*', '@deepseek-ai/dsh-desktop-host': '*' } }))
  scaffold = await launchWebScaffold({ extraOverlayPath: overlayPath, installAnchor })
  const seed = await readFile(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url), 'utf8')
  await seedSession(scaffold, seed, 'enterprise-feedback-browser')
  const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
  browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  page = await newEnglishPage(browser)
  await page.route('**/api/erp-ai-control/submit', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    expect(body).not.toHaveProperty('reason')
    submissions.push(body)
    await route.fulfill({ json: { code: 0, data: { id: 'feedback-browser-1', status_code: 'pending' } } })
  })
  await page.route('**/api/erp-ai-control/status', route => route.fulfill({
    json: { code: 0, data: { feedback: { id: 'feedback-browser-1', status_code: 'processing', latest_reply: 'We are checking the source and will update the answer.' } } },
  }))
  await page.route('**/api/erp-ai-control/upload', async (route) => {
    const body = route.request().postDataJSON() as { file_name: string; content_type: string; content_base64: string }
    expect(body.content_type).toBe('image/png')
    expect(body.content_base64).toBeTruthy()
    await route.fulfill({ json: { code: 0, data: { id: 'image-browser-1', file_name: body.file_name } } })
  })
  await page.route('**/api/erp-ai-control/discard', route => route.fulfill({ json: { code: 0, data: { deleted: true } } }))
  await page.route('**/api/erp-ai-control/review', async (route) => {
    reviews.push(route.request().postDataJSON() as Record<string, unknown>)
    if (reviewUnavailable) { await route.fulfill({ status: 404, json: { code: 404, error_code: 'service_unavailable' } }); return }
    await route.fulfill({ json: { code: 0, data: { verdict: nextReviewVerdict,
      reason: nextReviewVerdict === 'incomplete' ? '权限不足，申请尚未提交' : '需要选择申请人', evidence: 'I cannot submit' } } })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const group = page.locator('[role="treeitem"]').first()
  await group.waitFor({ timeout: 30000 })
  if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
  await page.locator('[role="treeitem"]').nth(1).click()
  await page.getByText('DONE', { exact: true }).waitFor({ timeout: 30000 })
}, 120000)

afterAll(async () => {
  await browser?.close()
  await scaffold?.close()
  if (overlayDirectory !== undefined) {
    await rm(overlayDirectory, { recursive: true, force: true })
  }
})

it('shows a dislike icon, submits only after confirmation, and opens the same form with /feedback', async () => {
  onTestFailed(() => saveFailureShot(page, 'enterprise-feedback-browser'))
  // The plugin has no extra boot-global switch that could silently hide it.
  expect(await page.evaluate(() => Reflect.get(globalThis, '__DSH_AI_CONTROL_ENABLED__'))).toBeUndefined()
  expect(await page.getByRole('button', { name: 'Good response', exact: true }).count()).toBe(0)
  const action = page.getByRole('button', { name: 'Report response', exact: true }).first()
  await action.waitFor({ timeout: 15000 })
  await scrollIntoView(action)
  await action.hover()
  const screenshot = process.env.DSH_FEEDBACK_SCREENSHOT
  if (screenshot !== undefined) {
    const box = await action.boundingBox()
    if (box === null) throw new Error('Feedback action has no visible rectangle')
    await page.screenshot({ path: screenshot, clip: { x: Math.max(0, box.x - 64), y: Math.max(0, box.y - 48), width: 360, height: 120 } })
  }
  expect(await action.textContent()).toBe('')
  expect(await action.locator('svg').count()).toBe(1)
  await action.click()
  const dialog = page.getByRole('dialog', { name: 'Enterprise AI feedback' })
  await dialog.waitFor()
  expect(submissions).toHaveLength(0)
  await dialog.getByRole('textbox', { name: 'Notes', exact: true }).fill('Enterprise issue')
  // 粘贴事件只使用本页测试数据，不读写操作系统剪贴板。
  await dialog.getByRole('button', { name: 'Close', exact: true }).evaluate((element) => {
    const clipboard = new DataTransfer()
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBC0AAAAASUVORK5CYII='), c => c.charCodeAt(0))
    clipboard.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }))
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }))
  })
  await dialog.getByRole('img', { name: 'pasted.png' }).waitFor()
  expect(submissions).toHaveLength(0)
  await dialog.getByRole('button', { name: 'Remove image pasted.png', exact: true }).click()
  await dialog.getByRole('img', { name: 'pasted.png' }).waitFor({ state: 'detached' })
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'selected.png', mimeType: 'image/png', buffer: Buffer.from('image fixture') })
  await dialog.getByRole('img', { name: 'selected.png' }).waitFor()

  await dialog.getByRole('button', { name: 'Submit feedback', exact: true }).click()
  await dialog.getByText('Feedback submitted', { exact: true }).waitFor()
  await dialog.getByRole('region', { name: 'My feedback', exact: true }).getByText('Enterprise issue', { exact: true }).waitFor()
  const reply = dialog.getByRole('region', { name: 'Human reply', exact: true })
  await reply.getByText('No human reply yet', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: 'Refresh status', exact: true }).click()
  await reply.getByText('We are checking the source and will update the answer.', { exact: true }).waitFor()
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect.poll(() => page.locator('body').getAttribute('data-ds-dark-theme')).toBe(colorScheme === 'dark' ? '' : null)
    if (screenshot !== undefined) await dialog.screenshot({ path: screenshot.replace(/\.png$/, `-${colorScheme}-reply.png`) })
  }
  await page.setViewportSize({ width: 390, height: 720 })
  const bounds = await dialog.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(24)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(366)
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(696)
  if (screenshot !== undefined) await dialog.screenshot({ path: screenshot.replace(/\.png$/, '-narrow-reply.png') })
  await page.setViewportSize({ width: 1680, height: 1000 })
  expect(submissions).toHaveLength(1)
  expect(submissions[0]?.description).toBe('Enterprise issue')
  expect(submissions[0]?.attachment_ids).toEqual(['image-browser-1'])
  expect(submissions[0]).not.toHaveProperty('content_base64')
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click()
  const editor = page.locator('[contenteditable="true"]').first()
  await editor.fill('/feedback')
  await editor.press('Enter')
  await dialog.waitFor({ timeout: 10000 })
  expect(submissions).toHaveLength(1)
})


it('reviews a newly finished turn and opens an editable draft only for an incomplete verdict', async () => {
  await page.reload({ waitUntil: 'load' })
  await page.getByText('DONE', { exact: true }).waitFor({ timeout: 30000 })
  expect(reviews).toHaveLength(0)
  const agent = scaffold.ctx.agents.get(SessionId('enterprise-feedback-browser'))
  if (agent === undefined) throw new Error('Seeded feedback session is not live')
  const appendAnswer = (turn: number, answer: string) => {
    agent.session.append('turn/start', { turn })
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Please submit my application.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    agent.session.append('step/start', { turn, step: 0 })
    agent.session.append('assistant/message', { turn, step: 0, stream: [], message: createMessage({ role: 'assistant',
      content: [{ type: 'text', text: answer }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } }) }, { surfaceOp: 'append' })
    agent.session.append('step/end', { turn, step: 0 })
    agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  const firstTurn = Math.max(...agent.session.snapshotEvents().flatMap(event => event.type === 'turn/start' ? [event.data.turn] : [])) + 1
  let before = submissions.length
  const reviewReady = Promise.withResolvers<undefined>()
  await page.route('**/api/erp-ai-control/review', async (route) => {
    await reviewReady.promise
    await route.fallback()
  }, { times: 1 })
  try {
    appendAnswer(firstTurn, 'I cannot submit the application because access is missing.')
    const checking = page.getByRole('status', { name: 'Task completion' })
    await checking.getByText('Checking task completion…', { exact: true }).waitFor()
    expect(await checking.locator('svg[data-state="ongoing"]').count()).toBe(1)
    expect(await checking.evaluate(element => getComputedStyle(element).borderTopStyle)).toBe('none')
    expect((await checking.boundingBox())!.height).toBeLessThan(40)
  } finally { reviewReady.resolve(undefined) }
  const prompt = page.getByRole('dialog', { name: 'This task may be incomplete. Send feedback?' })
  await prompt.waitFor({ timeout: 10000 })
  expect(await page.getByRole('status', { name: 'Task completion' }).count()).toBe(0)
  expect(await page.getByRole('button', { name: 'Write feedback', exact: true }).count()).toBe(1)
  expect(submissions).toHaveLength(before)
  await prompt.getByRole('button', { name: 'Write feedback', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Enterprise AI feedback' })
  await dialog.waitFor()
  expect(reviews).toEqual([{ question_snapshot: 'Please submit my application.', answer_snapshot: 'I cannot submit the application because access is missing.' }])
  expect(await dialog.getByRole('textbox', { name: 'Notes', exact: true }).inputValue()).toBe('权限不足，申请尚未提交')
  expect(await dialog.getByRole('combobox', { name: 'Issue type' }).inputValue()).toBe('not_resolved')
  expect(submissions).toHaveLength(before)
  await page.setViewportSize({ width: 720, height: 560 })
  await page.route('**/api/erp-ai-control/status', route => route.fulfill({
    json: { code: 0, data: { feedback: null } },
  }), { times: 1 })
  await dialog.getByRole('button', { name: 'Check feedback status', exact: true }).click()
  const noFeedback = dialog.getByText('You have not submitted feedback for this message.', { exact: true })
  await noFeedback.waitFor()
  expect(await noFeedback.isVisible()).toBe(true)
  await page.route('**/api/erp-ai-control/submit', route => route.fulfill({
    status: 422, json: { detail: [{ type: 'extra_forbidden', loc: ['body', 'reason'] }] },
  }), { times: 1 })
  await dialog.getByRole('button', { name: 'Submit feedback', exact: true }).click()
  const failure = dialog.getByRole('alert')
  await failure.waitFor()
  const failureBounds = await failure.boundingBox()
  expect(failureBounds!.y).toBeGreaterThanOrEqual(24)
  expect(failureBounds!.y + failureBounds!.height).toBeLessThanOrEqual(536)
  expect(await dialog.getByRole('textbox', { name: 'Notes', exact: true }).inputValue()).toBe('权限不足，申请尚未提交')
  await dialog.getByRole('button', { name: 'Submit feedback', exact: true }).click()
  await dialog.getByText('Feedback submitted', { exact: true }).waitFor()
  before += 1
  expect(submissions).toHaveLength(before)
  expect(submissions.at(-1)?.description).toBe('权限不足，申请尚未提交')
  await page.setViewportSize({ width: 1680, height: 1000 })
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click()
  nextReviewVerdict = 'needs_input'
  appendAnswer(firstTurn + 1, 'Which applicant should I use?')
  await page.getByText('This turn needs your input or confirmation.', { exact: false }).waitFor()
  expect(await dialog.count()).toBe(0)
  expect(reviews).toHaveLength(2)
  expect(submissions).toHaveLength(before)
  reviewUnavailable = true
  appendAnswer(firstTurn + 2, 'I cannot submit because access is missing.')
  const notice = page.getByRole('status', { name: 'Task completion' })
  await notice.getByText('The automatic check did not finish. Report manually?', { exact: true }).waitFor()
  expect(await notice.getByRole('button', { name: 'Report manually', exact: true }).count()).toBe(1)
  expect(await notice.getByRole('button', { name: 'Retry check', exact: true }).count()).toBe(1)
  const card = await notice.boundingBox()
  const input = await page.locator('[contenteditable="true"]').first().boundingBox()
  expect(card!.y + card!.height).toBeLessThanOrEqual(input!.y)
  reviewUnavailable = false
  nextReviewVerdict = 'incomplete'
  await notice.getByRole('button', { name: 'Retry check', exact: true }).click()
  await prompt.waitFor()
  expect(await notice.count()).toBe(0)
  await prompt.getByText('Not now', { exact: true }).click()
  await notice.waitFor({ state: 'detached' })
  expect(await page.getByRole('dialog').count()).toBe(0)
  expect(submissions).toHaveLength(before)
})
