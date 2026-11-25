/** Launch the single Electron process in ERP development mode. Start ERP Vite and FastAPI separately. */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { parseEnv } from 'node:util'

const packageManager = process.env.npm_execpath
if (!packageManager) throw new Error('Run this command with pnpm run dev:desktop:erp')

const root = new URL('../..', import.meta.url)
let localEnv = {}
try {
  localEnv = parseEnv(readFileSync(new URL('.env', root), 'utf8'))
} catch (error) {
  if (error?.code !== 'ENOENT') throw new Error('Cannot read the Harness root .env')
}

const executable = extname(packageManager).toLowerCase() === '.exe' ? packageManager : process.execPath
const arguments_ = executable === packageManager ? ['run', 'dev:desktop'] : [packageManager, 'run', 'dev:desktop']
const child = spawn(executable, arguments_, {
  cwd: root,
  env: {
    ...process.env,
    ERP_DEV_URL: process.env.ERP_DEV_URL || localEnv.ERP_DEV_URL || 'http://127.0.0.1:8848/',
    ERP_API_URL: process.env.ERP_API_URL || localEnv.ERP_API_URL,
    DSH_DESKTOP_OPEN_DEVTOOLS: process.env.DSH_DESKTOP_OPEN_DEVTOOLS || '0',
  },
  stdio: 'inherit',
})
child.once('error', error => { console.error(error); process.exitCode = 1 })
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
