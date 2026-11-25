import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exportSource } from './export-open-source.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-public-source-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  function file(name, content) { mkdirSync(join(root, name, '..'), { recursive: true }); writeFileSync(join(root, name), content) }
  file('package.json', '{"name":"test-source"}')
  file('apps/desktop/.env.windows', 'PRIVATE_TEST_VALUE=fixture')
  file('integrations/education-web/skills/customer.txt', 'fixture')
  execFileSync('git', ['add', '.'], { cwd: root })
  return { root, file }
}

test('exports source and hashes, omitting history, environment and private integration', () => {
  const { root } = fixture()
  try {
    const output = join(root, 'dist/public')
    assert.equal(exportSource(root, output), 1)
    assert.ok(existsSync(join(output, 'package.json')))
    assert.equal(existsSync(join(output, '.git')), false)
    assert.equal(existsSync(join(output, 'apps/desktop/.env.windows')), false)
    assert.equal(existsSync(join(output, 'integrations')), false)
    assert.match(JSON.parse(readFileSync(join(output, 'source-manifest.json'))).files['package.json'], /^[a-f0-9]{64}$/u)
    assert.throws(() => exportSource(root, output), /new directory/u)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('fails before writing on customer branding, unknown files and an outside output', () => {
  const { root, file } = fixture()
  try {
    file('apps/desktop/private-note.md', 'customer: \u822a\u542f')
    execFileSync('git', ['add', '.'], { cwd: root })
    assert.throws(() => exportSource(root, join(root, 'dist/public')), /Customer branding/u)
    assert.equal(existsSync(join(root, 'dist/public')), false)
    file('apps/desktop/private-note.md', 'const bridge = window.\u0068angqiDesktop')
    assert.throws(() => exportSource(root, join(root, 'dist/public')), /Customer branding/u)
    file('apps/desktop/private-note.md', 'generic')
    file('local-customer-record.json', '{}')
    assert.throws(() => exportSource(root, join(root, 'dist/public')), /Review untracked/u)
    assert.throws(() => exportSource(root, join(root, '..', 'outside')), /inside this repository/u)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
