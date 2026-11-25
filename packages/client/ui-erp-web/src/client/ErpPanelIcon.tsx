/** Sidebar icon for the embedded ERP application panel. */
import type { ReactNode } from 'react'
import { IconGlobeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the ERP panel glyph at the size requested by the sidebar.
 * @param props - Sidebar icon rendering parameters.
 * @returns The globe icon element.
 */
export function ErpPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconGlobeOutlineRegular size={size} />
}
