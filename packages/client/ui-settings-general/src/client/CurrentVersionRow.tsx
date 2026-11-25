/** Installed client and bundled DSH versions in General Settings. */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useState } from 'react'
import css from './CurrentVersionRow.module.css'

/** Optional desktop-owned installed-version reader; Web uses its build metadata. */
export interface CurrentVersionRowInjected {
  readonly loadDesktopVersion?: (() => Promise<string>) | undefined
}

/**
 * Render separate installed-client and DSH build versions on Desktop, or the Web build version.
 * @param props - runtime share and localized copy.
 * @returns available version labels; missing or failed reads omit only their own label.
 */
export function CurrentVersionRow({ t, loadDesktopVersion }: PropsRuntime<'settings.general.item'> & PropsLocale<'settings'> & CurrentVersionRowInjected) {
  const [version, setVersion] = useState(loadDesktopVersion === undefined ? process.env.DSH_CLIENT_VERSION : undefined)
  useEffect(() => {
    if (loadDesktopVersion === undefined) return
    let active = true
    void loadDesktopVersion().then((value) => { if (active) setVersion(value) }).catch((error: unknown) => {
      console.error('desktop installed version: unavailable', error)
    })
    return () => { active = false }
  }, [loadDesktopVersion])
  if (loadDesktopVersion === undefined) {
    return version === undefined ? null : <div className={css.webRow}>{t('general.currentVersion', { version })}</div>
  }
  const dshVersion = process.env.DSH_CLIENT_VERSION
  if (version === undefined && dshVersion === undefined) return null
  return (
    <dl className={css.versions}>
      {version !== undefined && <div className={css.row}>
        <dt className={css.label}>{t('general.clientVersionLabel')}</dt>
        <dd className={css.value}>{version}</dd>
      </div>}
      {dshVersion !== undefined && <div className={css.row}>
        <dt className={css.label}>{t('general.dshVersionLabel')}</dt>
        <dd className={css.value}>{dshVersion}</dd>
      </div>}
    </dl>
  )
}
