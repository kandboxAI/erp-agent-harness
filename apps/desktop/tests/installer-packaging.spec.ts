import { readInstallerLocales } from '../scripts/installer-locales.mjs'
import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Arch, Platform } from 'electron-builder'
import { AppInfo, Packager } from 'app-builder-lib'
import { expandMacro } from 'app-builder-lib/out/util/macroExpander.js'
import { describe, expect, it, vi } from 'vitest'

const dshVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

const { execute, write } = vi.hoisted(() => ({ execute: vi.fn(async () => undefined), write: vi.fn(async () => undefined) }))
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  return { ...original, execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) }
})

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(), writeFile: write,
}))

describe('installer preparation preserves application dependencies', () => {
  it.each(['win32', 'darwin'] as const)('rejects a missing production policy before signing on %s', async (platform) => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    expect(() => createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://test.example.com',
    }, platform, 'x64')).toThrow('DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN')
  })
  it.each(['win32', 'darwin'] as const)('preserves installer metadata and dependency ownership on %s', async (platform) => {
    execute.mockClear()
    write.mockClear()
    const env = {
      DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
      DSH_DESKTOP_TARGET_PLATFORM: platform,
      DSH_DESKTOP_TARGET_ARCH: 'x64',
      DSH_DESKTOP_UNSIGNED: platform === 'win32' ? '1' : '0',
      DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
      DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
      APPLE_KEYCHAIN_PROFILE: 'installer-test',
      DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com', DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef',
    }
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    try {
      const { createElectronBuilderConfig } = await import('../electron-builder.config.mjs')
      const config = createElectronBuilderConfig(env, platform, 'x64')
      expect(config.productName).toBe('DeepSeek Harness')
      const metadataPackager = new Packager({ projectDir: tmpdir() })
      const metadata: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
      Object.defineProperties(metadataPackager, {
        config: { value: config },
        metadata: { value: metadata },
      })
      const appInfo = new AppInfo(metadataPackager, undefined)
      expect(appInfo.companyName).toBe('Hangzhou DeepSeek Artificial Intelligence Co., Ltd.')
      expect(appInfo.copyright).toBe(`Copyright © ${new Date().getFullYear()} DeepSeek Harness`)
      if (platform === 'win32') {
        expect(expandMacro(config.nsis.uninstallDisplayName, null, appInfo, {}, false)).toBe('DeepSeek Harness')
        expect(config.nsis.installerLanguages).toEqual(readInstallerLocales().map(locale => locale.id))
      }
      const aboutIcon = config.extraResources.find(resource => resource.to === 'icon.png')
      expect(aboutIcon).toBeDefined()
      expect(readFileSync(aboutIcon!.from)).toEqual(readFileSync(new URL('../resources/icon-windows.png', import.meta.url)))
      // Only the Windows package carries the tray bitmaps; macOS keeps the Dock.
      const trayIcon = config.extraResources.find(resource => resource.to === 'tray.ico')
      if (platform === 'win32') {
        const { unpackIco } = await import('../scripts/render-tray-icon.ts')
        expect(config.win.icon).toBe(fileURLToPath(new URL('../resources/icon-windows.ico', import.meta.url)))
        expect(unpackIco(readFileSync(config.win.icon)).map(entry => entry.size))
          .toEqual([16, 24, 32, 48, 64, 128, 256])
        expect(readFileSync(trayIcon!.from)).toEqual(readFileSync(new URL('../resources/tray-windows.ico', import.meta.url)))
      } else {
        expect(trayIcon).toBeUndefined()
      }
      const packager = new Packager({ projectDir: tmpdir() })
      // A foreign source-build target avoids rebuilding modules; the real dependency ownership decision still runs.
      Object.defineProperties(packager, {
        config: { value: { beforeBuild: config.beforeBuild, buildDependenciesFromSource: true } },
        framework: { value: { isNpmRebuildRequired: true, version: '42.0.0' } },
        appInfo: { value: { type: 'module' } },
      })
      vi.spyOn(packager, 'getWorkspaceRoot').mockResolvedValue(tmpdir())
      await packager.installAppDependencies(process.platform === 'win32' ? Platform.LINUX : Platform.WINDOWS, Arch.x64)
      expect(packager.areNodeModulesHandledExternally).toBe(false)
      expect(execute).toHaveBeenCalledTimes(platform === 'win32' ? 1 : 0)
      expect(write).toHaveBeenCalledTimes(platform === 'win32' ? 1 : 0)
      if (platform === 'win32') {
        expect(write).toHaveBeenCalledWith(expect.stringMatching(/installer-ui[\\/]strings\.nsh$/u),
          expect.stringContaining('LangString INSTALLER_INSTALL ${LANG_JAPANESE}'), 'utf8')
      }
    } finally {
      vi.unstubAllEnvs()
      vi.restoreAllMocks()
    }
  })

  it('names unsigned Windows artifacts so they cannot pass for release builds', async () => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
      DSH_DESKTOP_TARGET_PLATFORM: 'win32',
      DSH_DESKTOP_TARGET_ARCH: 'x64',
      DSH_DESKTOP_UNSIGNED: '1',
    }, 'win32', 'x64')
    expect(config.artifactName).toBe('deepseek-harness-${version}-${os}-${arch}-unsigned.${ext}')
  })

  it('allows local FastAPI only in an unsigned ERP test package', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const path = await import('node:path')
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const dist = mkdtempSync(path.join(tmpdir(), 'dsh-erp-package-'))
    writeFileSync(path.join(dist, 'index.html'), '<!doctype html>')
    const env = {
      DSH_DESKTOP_APP_ID: 'org.example.erp.localtest',
      DSH_DESKTOP_TARGET_PLATFORM: 'win32',
      DSH_DESKTOP_TARGET_ARCH: 'x64',
      ERP_DIST_DIR: dist,
      ERP_API_URL: 'http://127.0.0.1:8000/',
    }
    try {
      expect(() => createElectronBuilderConfig({ ...env, DSH_DESKTOP_UNSIGNED: '0' }, 'win32', 'x64'))
        .toThrow('HTTPS')
      expect(() => createElectronBuilderConfig({ ...env, ERP_API_URL: 'http://example.com/',
        DSH_DESKTOP_UNSIGNED: '1' }, 'win32', 'x64')).toThrow('loopback HTTP')
      const config = createElectronBuilderConfig({ ...env, DSH_DESKTOP_UNSIGNED: '1' }, 'win32', 'x64')
      expect(config.productName).toBe('DeepSeek Harness')
      expect(config.extraMetadata).toMatchObject({ erpApiUrl: env.ERP_API_URL, erpLocalTest: true })
      expect(config.artifactName).toContain('erp-client-')
      const independent = createElectronBuilderConfig({ ...env, DSH_DESKTOP_UNSIGNED: '1', DSH_DESKTOP_BUILD_VERSION: '1.0.0' }, 'win32', 'x64')
      expect(independent.extraMetadata).toMatchObject({ version: '1.0.0' })
      expect(independent.artifactName.replace('${version}', '1.0.0')
        .replace('${os}', 'win').replace('${arch}', 'x64').replace('${ext}', 'exe'))
        .toBe(`erp-client-1.0.0-dsh-${dshVersion}-win-x64-unsigned.exe`)
      execute.mockClear()
      await config.beforeBuild()
      expect(execute.mock.calls[0]).toEqual(expect.arrayContaining([
        'powershell.exe', expect.arrayContaining(['-BrandName', 'DeepSeek Harness']),
      ]))
    } finally { rmSync(dist, { recursive: true, force: true }) }
  })

  it.each(['arm64', 'x64'])('packages ERP for macOS %s with both versions and an HTTPS backend', async (arch) => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
    const path = await import('node:path')
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const dist = mkdtempSync(path.join(tmpdir(), 'dsh-erp-mac-package-'))
    writeFileSync(path.join(dist, 'index.html'), '<!doctype html>')
    try {
      const config = createElectronBuilderConfig({
        DSH_DESKTOP_APP_ID: 'org.example.erp',
        DSH_DESKTOP_TARGET_PLATFORM: 'darwin',
        DSH_DESKTOP_TARGET_ARCH: arch,
        DSH_DESKTOP_UNSIGNED: '1',
        DSH_DESKTOP_BUILD_VERSION: '0.0.4',
        ERP_DIST_DIR: dist,
        ERP_API_URL: 'https://erp.example.com/',
      }, 'darwin', arch)
      expect(config.productName).toBe('DeepSeek Harness')
      expect(config.mac).toMatchObject({ identity: '-', forceCodeSigning: false, notarize: false })
      expect(config.dmg.sign).toBe(false)
      expect(config.artifactName).toContain('erp-client-')
      expect(config.extraMetadata).toMatchObject({ version: '0.0.4' })
      for (const extension of ['dmg', 'zip']) {
        expect(config.artifactName.replace('${version}', '0.0.4').replace('${os}', 'mac')
          .replace('${arch}', arch).replace('${ext}', extension))
          .toBe(`erp-client-0.0.4-dsh-${dshVersion}-mac-${arch}-unsigned.${extension}`)
      }
      expect(config.directories.output).toContain('unsigned-artifacts')
    } finally { rmSync(dist, { recursive: true, force: true }) }
  })

  it('adds a minute timestamp to ERP artifacts when requested by the packaging wrapper', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
    const path = await import('node:path')
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const dist = mkdtempSync(path.join(tmpdir(), 'dsh-erp-timestamp-'))
    writeFileSync(path.join(dist, 'index.html'), '<!doctype html>')
    try {
      const config = createElectronBuilderConfig({
        DSH_DESKTOP_APP_ID: 'org.example.erp',
        DSH_DESKTOP_TARGET_PLATFORM: 'darwin',
        DSH_DESKTOP_TARGET_ARCH: 'arm64',
        DSH_DESKTOP_UNSIGNED: '1',
        DSH_DESKTOP_ARTIFACT_TIMESTAMP: '202611091625',
        ERP_DIST_DIR: dist,
        ERP_API_URL: 'https://erp.example.com/',
      }, 'darwin', 'arm64')
      expect(config.artifactName).toBe(`erp-client-\${version}-dsh-${dshVersion}-\${os}-\${arch}-202611091625-unsigned.\${ext}`)
    } finally { rmSync(dist, { recursive: true, force: true }) }
  })

  it('packages every preload entry point the shell loads', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const sourceDirectory = new URL('../src/', import.meta.url)
    const referenced = new Set<string>()
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      for (const match of readFileSync(new URL(entry.name, sourceDirectory), 'utf8').matchAll(/preload-[a-z-]+\.cjs/gu)) referenced.add(match[0])
    }
    expect(referenced.size).toBeGreaterThan(0)
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://harness-test.deepseek.com',
      DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
      DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
      APPLE_KEYCHAIN_PROFILE: 'installer-test',
    }, 'darwin', 'arm64')
    const packaged = new Set(config.files.filter((entry): entry is string => typeof entry === 'string'))
    for (const name of referenced) expect(packaged.has(`lib/${name}`)).toBe(true)
  })
})
