import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'

/**
 * Render the official mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the official whale mark.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  const icon = process.env.DSH_CLIENT_BRAND_ICON
  return icon === undefined ? <FishLogo size={size} />
    : <img src={icon} alt="" aria-hidden style={{ width: size, height: size, objectFit: 'contain' }} />
}

/**
 * Render the localized product name beside its independently slotted crest.
 * @param props - Framework-supplied common dictionary.
 * @returns the product name.
 */
export function OfficialBrandName({ t }: PropsLocale<'common'>) {
  return <span style={{ fontSize: 18, fontWeight: 500, whiteSpace: 'nowrap' }}>{process.env.DSH_CLIENT_TITLE ?? t('brand.localBuild')}</span>
}
