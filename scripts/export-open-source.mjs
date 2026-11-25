/** Export reviewed working-tree source without Git history, local configuration or customer assets. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const EXCLUDED = /^(?:\.git\/|\.vscode\/|\.codex\/|tmp\/|dist\/|node_modules\/|integrations\/education-web\/)|(?:^|\/)(?:node_modules|lib|\.desktop-build|\.dsh-build|\.sessions|\.storages|__pycache__)(?:\/|$)|(?:^|\/)\.env(?![^/]*\.example$)(?:\.|$)|\.(?:p12|pfx|key|tsbuildinfo)$/u
const NEW_SOURCE = /^(?:integrations\/erp\/|scripts\/(?:erp-branding|export-open-source)\.|apps\/desktop\/scripts\/desktop-erp-branding\.|apps\/desktop\/tests\/erp-branding\.spec\.ts$|apps\/desktop\/resources\/brand-source\.png$|docs\/cookbook\/preparing-open-source(?:\.|$)|docs\/upgrade-guide\/v0\.2\.2-rc\.1\/public-desktop-branding\/)/u
const CUSTOMER_MARKER = /\u0068angqi|\u822a\u542f|\u5c0f\u822a|kunyiai\.com|aiedu\.|[/\\]education\u005fweb[/\\]|school\u002dcrest/iu
const TEXT = /\.(?:[cm]?[jt]sx?|json|ya?ml|md|txt|py|sh|ps1|svg|html|css|nsh|nsi|toml)$/u

/** @param {string} root Repository root. @returns {string[]} Reviewed, portable relative source paths. Throws before export if a source path or customer marker is unsafe. */
export function sourceFiles(root) {
  const list = (...args) => execFileSync('git', ['ls-files', '-z', ...args], { cwd: root, maxBuffer: 32 * 1024 * 1024 }).toString('utf8').split('\0').filter(Boolean)
  const tracked = list('--cached')
  const additions = list('--others', '--exclude-standard').filter(name => !EXCLUDED.test(name))
  const unknown = additions.filter(name => !NEW_SOURCE.test(name))
  if (unknown.length) throw new Error(`Review untracked source before export: ${unknown.join(', ')}`)
  const selected = [...new Set([...tracked, ...additions])].filter(name => !EXCLUDED.test(name) && existsSync(join(root, name))).sort()
  if (selected.length === 0) throw new Error('No reviewed source files to export')
  const verified = new Set([root])
  for (const name of selected) {
    if (isAbsolute(name) || name.split('/').includes('..') || name === 'source-manifest.json') throw new Error(`Unsafe source path: ${name}`)
    const path = join(root, name)
    // Do not follow junctions or symlinks into the local environment.
    for (let parent = path; !verified.has(parent); parent = dirname(parent)) {
      if (lstatSync(parent).isSymbolicLink()) throw new Error(`Export cannot follow links: ${name}`)
      verified.add(parent)
    }
    if (!lstatSync(path).isFile()) throw new Error(`Export requires a regular file: ${name}`)
    if (TEXT.test(name) && CUSTOMER_MARKER.test(readFileSync(path, 'utf8'))) {
      throw new Error(`Customer branding remains in ${name}; sanitize this file before export`)
    }
  }
  return selected
}

/** @param {string} root Repository root. @param {string} output New directory below root/dist. @returns {number} Number of copied files. Never overwrites an existing export or includes Git metadata. */
export function exportSource(root, output) {
  root = resolve(root)
  output = resolve(output)
  const allowed = join(root, 'dist') + sep
  if (!output.startsWith(allowed) || existsSync(output)) throw new Error('Output must be a new directory inside this repository/dist')
  for (let parent = dirname(output); parent.startsWith(root); parent = dirname(parent)) {
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error('Output cannot pass through a directory link')
    if (parent === root) break
  }
  const files = sourceFiles(root)
  mkdirSync(dirname(output), { recursive: true })
  const staging = mkdtempSync(join(dirname(output), '.opensource-'))
  try {
    const manifest = {}
    for (const name of files) {
      const target = join(staging, name)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(join(root, name), target)
      manifest[name] = createHash('sha256').update(readFileSync(target)).digest('hex')
    }
    writeFileSync(join(staging, 'source-manifest.json'), JSON.stringify({ format_version: 1, files: manifest }, null, 2) + '\n')
    renameSync(staging, output)
    return files.length
  } finally {
    if (staging.startsWith(allowed) && existsSync(staging)) rmSync(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { output: { type: 'string' }, check: { type: 'boolean' } } })
    if (values.check) console.log(`Open-source source check passed: ${sourceFiles(ROOT).length} files; no export written`)
    else {
      if (!values.output) throw new Error('Use --check or --output dist/<new-directory>')
      const output = resolve(ROOT, values.output)
      console.log(`Exported ${exportSource(ROOT, output)} source files to ${relative(ROOT, output)}; Git history and local configuration excluded`)
    }
  } catch (error) {
    console.error(`Open-source export stopped: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
