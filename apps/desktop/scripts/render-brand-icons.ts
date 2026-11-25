/** Regenerate desktop brand assets from the committed neutral PNG. */
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { packIco, renderTrayIconEntries } from './render-tray-icon.ts'

const crestPath = new URL('../resources/brand-source.png', import.meta.url)
const resources = new URL('../resources/', import.meta.url)
const installer = new URL('../installer/assets/', import.meta.url)
const installerArtwork = new URL('../installer/artwork/', import.meta.url)

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--source')) {
    throw new Error('Usage: render-brand-icons.ts [--source <official PNG>]')
  }
  const original = await readFile(args[1] === undefined ? crestPath : resolve(args[1]))
  const metadata = await sharp(original).metadata()
  if (metadata.format !== 'png' || metadata.width !== metadata.height || !metadata.width) {
    throw new Error('Brand artwork must be a square PNG; its proportions are preserved.')
  }
  if (args[1] !== undefined) await writeFile(crestPath, original)
  const crest = await sharp(original).resize(1024, 1024).png().toBuffer()
  const dataUrl = `data:image/png;base64,${crest.toString('base64')}`

  // Preserve each platform's existing canvas, safe area and rounded background.
  for (const name of ['icon', 'icon-windows', 'icon-macos']) {
    const svgPath = new URL(`${name}.svg`, resources)
    const svg = await readFile(svgPath, 'utf8')
    if (!svg.includes('data:image/png;base64,')) throw new Error(`${name}.svg has no embedded brand image`)
    const updated = svg.replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/g, dataUrl)
    await writeFile(svgPath, updated)
    await sharp(Buffer.from(updated)).png().toFile(fileURLToPath(new URL(`${name}.png`, resources)))
  }
  const welcomePath = new URL('../renderer/assets/welcome-brand.svg', import.meta.url)
  await writeFile(welcomePath, `<svg xmlns="http://www.w3.org/2000/svg" width="472" height="40" viewBox="0 0 472 40"><style>text{fill:#0f1115}@media(prefers-color-scheme:dark){text{fill:#f9fafb}}</style><image href="${dataUrl}" x="0" y="0" width="40" height="40"/><text x="54" y="28" font-family="Arial,sans-serif" font-size="24" font-weight="500">DeepSeek Harness</text></svg>`)

  const application = await readFile(new URL('icon-windows.png', resources))
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const frames = await Promise.all(sizes.map(async size => ({ size, png: await sharp(application).resize(size, size).png().toBuffer() })))
  await writeFile(new URL('icon-windows.ico', resources), packIco(frames))
  const traySource = await readFile(new URL('icon-windows.svg', resources))
  await writeFile(new URL('tray-windows.ico', resources), packIco(await renderTrayIconEntries(traySource)))

  // Regenerate the wordmark too: a raster text asset must not retain a customer name.
  for (const name of ['brand', 'brand-dark', 'brand-2x', 'brand-dark-2x']) {
    const path = new URL(`${name}.png`, installer)
    const scale = name.endsWith('-2x') ? 2 : 1
    const ink = name.includes('dark') ? '#f9fafb' : '#0f1115'
    const wordmark = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${600 * scale}" height="${56 * scale}" viewBox="0 0 600 56"><text x="300" y="38" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" font-weight="500" fill="${ink}">DeepSeek Harness</text></svg>`)).png().toBuffer()
    await writeFile(new URL(`${name}-wordmark.png`, installerArtwork), wordmark)
    const mark = await sharp(original).resize(120 * scale, 120 * scale).png().toBuffer()
    await sharp({ create: { width: 600 * scale, height: 196 * scale, channels: 4, background: '#00000000' } })
      .composite([{ input: mark, left: 240 * scale, top: 16 * scale }, { input: wordmark, left: 0, top: 140 * scale }])
      .png().toFile(fileURLToPath(path))
  }
  const sidebar = `<svg xmlns="http://www.w3.org/2000/svg" width="164" height="314"><rect width="164" height="314" fill="#f3f4f6"/><rect x="22" y="89" width="120" height="120" rx="8" fill="#fbfbfb"/><image href="${dataUrl}" x="34" y="101" width="96" height="96" preserveAspectRatio="xMidYMid meet"/></svg>`
  await sharp(Buffer.from(sidebar)).flatten({ background: '#f3f4f6' }).png().toFile(fileURLToPath(new URL('uninstaller-sidebar.png', installer)))
  console.info('Brand icons regenerated: application, tray, installer and welcome.')
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
