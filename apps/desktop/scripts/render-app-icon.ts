/** Build the Windows application icon from the committed source PNG. */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { packIco } from './render-tray-icon.ts'

const source = new URL('../resources/icon-windows.png', import.meta.url)
const output = new URL('../resources/icon-windows.ico', import.meta.url)
const sizes = [16, 24, 32, 48, 64, 128, 256] as const

const png = await readFile(source)
const entries = await Promise.all(sizes.map(async size => ({
  size,
  png: await sharp(png).resize(size, size).png().toBuffer(),
})))
await writeFile(output, packIco(entries))
console.info(`app icon: wrote ${fileURLToPath(output)} with ${sizes.join(', ')} px bitmaps`)
