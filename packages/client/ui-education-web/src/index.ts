/** Host configuration bridge for the embedded ERP Web panel. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import type { Config } from './config.ts'
import { registerEducationNavigation } from './navigation-host.ts'

export { Config } from './config.ts'

/** Host services required by the navigation transport and model tool. */
export const inject = ['webServer', 'tools']

/**
 * Embed the validated education panel settings in each served Web page.
 * @param ctx - Host context serving the Harness Web application.
 * @param config - Education panel URL and startup behavior.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: '__DSH_EDUCATION_WEB_CONFIG__', value: config })
  })
  if (config.settingsOnly) return
  ctx.effect(
    () => registerEducationNavigation(ctx, config),
    'ui-education-web: navigation transport and tool',
  )
}
