import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { resolveErpBranding, erpClientBuildEnvironment } from '../../../scripts/erp-branding.mjs'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import { resolveClientBuildEnvironment, officialClientBuildEnvironment, clientBuildValueDefines } from '../../../scripts/client-build-environment.ts'
import { resolveDesktopLocale, resolveDesktopStartupLocale } from '../src/locale.ts'
import { localMacOSPackageEnvironment } from '../scripts/desktop-package-environment.mjs'

const directory = mkdtempSync(join(tmpdir(), 'erp-branding-'))
afterEach(() => rmSync(directory, { recursive: true, force: true }))
const identity = { product_name: 'MES 智能助手', app_id: 'org.example.mes', artifact_prefix: 'mes-erp', assistant_name: '制造助手' }
const environment = () => {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'index.html'), '<html></html>')
  return { ERP_DIST_DIR: directory, ERP_API_URL: 'https://mes.example.com',
    DSH_ERP_BRANDING: JSON.stringify(identity), DSH_DESKTOP_UNSIGNED: '1', DSH_DESKTOP_APP_ID: 'org.example.previous' }
}

it('keeps suite identity through unsigned macOS presets and both client build profiles', () => {
  const env = environment()
  expect(localMacOSPackageEnvironment(env).DSH_DESKTOP_APP_ID).toBe(identity.app_id)
  const build = { ...env, DSH_CLIENT_COMMIT_HASH: '1234567', DSH_CLIENT_VERSION: '1.0.0' }
  for (const profile of ['local', 'official']) {
    expect(resolveClientBuildEnvironment(build, profile)).toMatchObject({ DSH_CLIENT_TITLE: 'MES 智能助手', DSH_CLIENT_ERP_BRAND: '1' })
  }
  expect(officialClientBuildEnvironment(resolve(import.meta.dirname, '../../..'), build)).toMatchObject({ DSH_CLIENT_TITLE: 'MES 智能助手' })
  expect(erpClientBuildEnvironment({})).toEqual({})
})

it('publishes consistent installer, application and runtime metadata', () => {
  const config = createElectronBuilderConfig({ ...environment(), DSH_DESKTOP_BUILD_VERSION: '1.0.0' }, 'darwin', 'arm64')
  expect(config.appId).toBe(identity.app_id)
  expect(config.productName).toBe(identity.product_name)
  expect(config.artifactName).toContain('mes-erp-${version}-dsh-')
  expect(config.extraMetadata.dshDesktopProductName).toBe(identity.product_name)
})

it('applies the product name to native menus, welcome and update messages in every locale', () => {
  for (const language of ['en', 'zh-CN', 'ja', 'es', 'fr', 'de', 'ru', 'pt']) {
    const locale = resolveDesktopLocale(language, identity.product_name)
    expect(locale.messages.aboutProduct).toBe(identity.product_name)
    expect(locale.messages.welcomeTitle).toBe(identity.product_name)
    expect(Object.values(locale.messages).join('\n')).not.toContain('DeepSeek Harness')
    expect(resolveDesktopStartupLocale(null, [language], identity.product_name)).toEqual(locale)
  }
  expect(resolveDesktopLocale('en').messages.aboutProduct).toBe('DeepSeek Harness')
})

it('rejects incomplete, unsafe and non-ERP configuration before building', () => {
  const env = environment()
  for (const change of [{ product_name: '../outside' }, { app_id: 'bad' }, { artifact_prefix: '../bad' }, { icon: '../missing.png' }, { secret: 'not-public' }]) {
    expect(() => resolveErpBranding({ ...env, DSH_ERP_BRANDING: JSON.stringify({ ...identity, ...change }) })).toThrow()
  }
  expect(() => resolveErpBranding({ DSH_ERP_BRANDING: JSON.stringify(identity) })).toThrow(/ERP_DIST_DIR/u)
})

it('inlines icon bytes only in bundler definitions and shares the selected asset with installers', () => {
  const env = environment()
  const icon = join(directory, 'brand.png')
  writeFileSync(icon, readFileSync(new URL('../resources/icon-windows.png', import.meta.url)))
  const selected = { ...env, DSH_ERP_BRANDING: JSON.stringify({ ...identity, icon }) }
  const publicEnvironment = erpClientBuildEnvironment(selected)
  expect(publicEnvironment.DSH_CLIENT_BRAND_ICON).toMatch(/^[a-f0-9]{64}$/u)
  const definitions = clientBuildValueDefines({ ...selected, ...publicEnvironment })
  expect(JSON.parse(definitions['process.env.DSH_CLIENT_BRAND_ICON'] ?? '')).toMatch(/^data:image\/png;base64,/u)
  expect(JSON.stringify(publicEnvironment)).not.toContain(directory)
  const config = createElectronBuilderConfig(selected, 'darwin', 'arm64')
  expect(config.extraResources[1]?.from).toBe(icon)
  expect(config.mac.icon).toBe(icon)
  expect(config.win.icon).toBe(icon)
  writeFileSync(icon, 'changed')
  expect(() => clientBuildValueDefines({ ...selected, ...publicEnvironment })).toThrow()
})
