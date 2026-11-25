/** Host locale preference and Desktop model-language guidance. */
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-system-prompt'

import type { Volatile, Context } from '@deepseek-ai/cordis'

import z from '@deepseek-ai/schemastery'
import { LOCALE_PREFERENCE_FIELD } from './locale-settings.ts'

import { LocaleSettingsFields } from './locale-settings.ts'

export {
  LOCALE_IDS, LOCALE_PREFERENCE_FIELD, LOCALE_SETTINGS_NAMESPACE,
  type BuiltInLocaleId, type LocaleId, type LocaleSettings,
} from './locale-settings.ts'

/** Runtime preferences projected to the browser. */
export interface Config {
  /** Explicit locale; omission follows the browser. */
  preference: Volatile<string | undefined>
}

/** Live preferences projected to the browser. */
export const Config = z.object({
  preference: LocaleSettingsFields[LOCALE_PREFERENCE_FIELD].volatile(),
})

/** Host preferences control client copy and the default language of model output.
 * @param ctx Plugin context that registers settings and model guidance.
 * @param config Live locale preference.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  ctx.inject(['systemPrompt'], (child) => {
    child.systemPrompt.section({
      name: 'locale:response-language',
      order: child.systemPrompt.getSectionOrder('RESPONSE_LANGUAGE'),
      text: () => {
        const systemLanguage = process.env.DSH_DESKTOP_SYSTEM_LOCALE
        if (systemLanguage === undefined) return ''
        const language = config.preference.get() ?? systemLanguage
        const responseLanguage = /^zh(?:-|$)/iu.test(language) ? 'Chinese' : 'English'
        return `Use ${responseLanguage} by default for your own reasoning and final answers. Follow explicit language instructions from the active persona or user. Keep tool names, quoted text, code, and plugin-defined content in their original language.`
      },
    })
  })
}
