/** Browser plugin registering the ERP application as a global main panel. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Config } from '../config.ts'
import { EducationPanel, type EducationPanelFace } from './EducationPanel.tsx'
import { EducationAssistant, type EducationAssistantFace } from './EducationAssistant.tsx'
import { EducationPanelIcon } from './EducationPanelIcon.tsx'
import { EducationNavigationController } from './navigation-controller.ts'
import { EducationAssistantController } from './assistant-controller.ts'
import { EducationCredentialBinding } from './credential-binding.ts'
import type { NavigationAck } from '../navigation-contract.ts'
import { en, zh } from './locales.ts'
import { registerPersonalPromptSettings } from './personal-prompt-registration.ts'

export type { EducationPanelFace, EducationPanelProps } from './EducationPanel.tsx'
export type { EducationWebLocaleKey } from './locales.ts'

/** Services required by the panel, sidebar entry, and startup selection. */
export const inject = ['slots', 'locale', 'layout', 'sessions', 'uiConversation', 'conversation']

const NS = 'educationWeb'
const PANEL_ID = 'education-web' as MainPanelId

/** Read the Host-injected configuration from the current Web page. */
function browserConfig(): Config {
  const carrier = globalThis as { __DSH_EDUCATION_WEB_CONFIG__?: unknown }
  return Config(carrier.__DSH_EDUCATION_WEB_CONFIG__ ?? {})
}

/**
 * Register the embedded education application and select it on a fresh page when configured.
 * @param ctx - Browser plugin context with slots, locale, and layout services.
 */
export function apply(ctx: ClientContext): void {
  const config = browserConfig()
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-education-web: dictionaries')
  registerPersonalPromptSettings(ctx)
  if (config.settingsOnly) return
  const navigation = new EducationNavigationController(ctx.layout, PANEL_ID)
  const assistant = new EducationAssistantController(ctx)
  const credentialBinding = new EducationCredentialBinding(assistant.state)

  ctx.effect(() => navigation.start(), 'ui-education-web: navigation stream')
  ctx.effect(() => assistant.start(), 'ui-education-web: quick assistant')
  ctx.effect(() => credentialBinding.start(), 'ui-education-web: ERP credential binding')
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: -10,
    label: () => t('panel'),
    locale: NS,
  }, EducationPanelIcon))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'education-assistant',
    order: 10,
    locale: NS,
    inject: (): EducationAssistantFace => ({
      hooks: { assistant: assistant.state },
      openAssistant: () => { assistant.open() },
      closeAssistant: () => { assistant.close() },
      openConversation: () => { assistant.openConversation() },
      sendAssistantPrompt: async (prompt, includeEducationContext) => {
        await credentialBinding.reconcile(true)
        await assistant.send(prompt, includeEducationContext)
      },
    }),
  }, EducationAssistant))
  ctx.slots.inject('main', () => {
    const dispose = ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: NS,
      inject: (): EducationPanelFace => ({
        url: config.url,
        hooks: { navigation: navigation.state },
        acknowledgeNavigation: (ack: NavigationAck) => navigation.acknowledge(ack),
        openAssistant: () => { assistant.open() },
        updatePageContext: (context) => { assistant.setPageContext(context) },
        updateCredential: accessToken => credentialBinding.update(accessToken),
      }),
    }, EducationPanel)
    if (config.openOnStartup) ctx.layout.selectPanel(PANEL_ID)
    return dispose
  })
}
