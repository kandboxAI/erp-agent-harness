/** Desktop-only settings contribution for shared ERP personal preferences. */
import type { Context } from '@deepseek-ai/cordis'
import { PersonalPromptSettings, type PersonalPromptFace } from './PersonalPromptSettings.tsx'
import { requestPersonalContext } from './personal-context.ts'

const loadPersonalContext = (signal: AbortSignal) => requestPersonalContext(undefined, signal)

/** @param ctx - Client context with slots and the educationWeb locale registered. */
export function registerPersonalPromptSettings(ctx: Context): void {
  const carrier = globalThis as { __DSH_USER_CONTEXT_PATH__?: string }
  if (carrier.__DSH_USER_CONTEXT_PATH__ !== '/api/erp-user-context') return
  const t = ctx.locale.bind('educationWeb')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'erp-personal-prompt', order: 20,
    label: () => t('personalPromptTitle'), locale: 'educationWeb',
    inject: (): PersonalPromptFace => ({ loadPersonalContext, savePersonalContext: requestPersonalContext }),
  }, PersonalPromptSettings))
}
