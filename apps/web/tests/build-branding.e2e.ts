/** Product identity from the verified client build in the shipped Web composition. */
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { readClientBuildRecord } from '../../../scripts/client-build-environment.ts'
import { launchWebScaffold } from './scaffold.ts'

it('renders the selected product title and icon in light and dark embedded chat', async () => {
  const root = resolve(import.meta.dirname, '../../..')
  const { environment } = readClientBuildRecord(root)
  const requested: { product_name: string; icon?: string } | undefined = process.env.DSH_ERP_BRANDING === undefined
    ? undefined : JSON.parse(process.env.DSH_ERP_BRANDING)
  if (requested !== undefined) {
    expect(environment.DSH_CLIENT_TITLE).toBe(requested.product_name)
    if (requested.icon !== undefined) {
      const icon = await readFile(requested.icon)
      expect(environment.DSH_CLIENT_BRAND_ICON).toBe(createHash('sha256').update(`data:image/png;base64,${icon.toString('base64')}`).digest('hex'))
    }
  }
  const title = environment.DSH_CLIENT_TITLE ?? 'DeepSeek Harness'
  const iconDigest = environment.DSH_CLIENT_BRAND_ICON
  const scaffold = await launchWebScaffold({ extraOverlayPath: resolve(import.meta.dirname, 'fixtures/build-branding.patch.yml') })
  try {
    const browser = await chromium.launch()
    try {
      for (const colorScheme of ['light', 'dark'] as const) {
        const page = await browser.newPage({ viewport: { width: 1000, height: 720 }, colorScheme, locale: 'en-US' })
        try {
          await page.goto(scaffold.authenticatedUrl)
          await page.locator('[data-slot="sidebar"]').waitFor()
          const url = new URL(scaffold.baseUrl)
          url.searchParams.set('erp_client', '1')
          url.searchParams.set('erp_chat_only', '1')
          url.searchParams.set('erp_embedded_chat', '1')
          await page.goto(url.href)
          const sidebar = page.locator('[data-slot="sidebar"]')
          expect(new URL(page.url()).searchParams.has('erp_embedded_chat')).toBe(true)
          await sidebar.getByText(title, { exact: true }).waitFor()
          expect(await page.title()).toBe(title)
          if (requested !== undefined) expect(await sidebar.getByText('DeepSeek Harness', { exact: true }).count()).toBe(0)
          if (iconDigest !== undefined) {
            const icon = sidebar.locator('img').first()
            const src = await icon.getAttribute('src')
            expect(src).toMatch(/^data:image\/png;base64,/u)
            expect(createHash('sha256').update(src!).digest('hex')).toBe(iconDigest)
            await expect.poll(() => icon.evaluate(image =>
              image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
            )).toBe(true)
          }
          const artifact = resolve(root, '.artifacts/suite-branding')
          await mkdir(artifact, { recursive: true })
          await page.screenshot({ path: resolve(artifact, `embedded-${colorScheme}.png`), animations: 'disabled' })
          const titleBox = await sidebar.getByText(title, { exact: true }).boundingBox()
          const sidebarBox = await sidebar.locator('..').boundingBox()
          expect(titleBox).not.toBeNull()
          expect(sidebarBox).not.toBeNull()
          expect(titleBox!.x + titleBox!.width).toBeLessThanOrEqual(sidebarBox!.x + sidebarBox!.width)
        } catch (error) {
          const artifact = resolve(root, '.artifacts/suite-branding')
          await mkdir(artifact, { recursive: true })
          await page.screenshot({ path: resolve(artifact, `failed-${colorScheme}.png`) })
          throw error
        } finally {
          await page.close()
        }
      }
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})
