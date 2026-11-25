/** Launch the standard Web profile with optional ERP tools and no industry templates. */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const patch = fileURLToPath(new URL('./cordis.patch.yml', import.meta.url))
const child = spawn(process.execPath,
  ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--patch', patch, ...process.argv.slice(2)],
  { cwd: root, env: process.env, stdio: 'inherit', shell: false })
child.once('error', error => { console.error(error); process.exitCode = 1 })
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
