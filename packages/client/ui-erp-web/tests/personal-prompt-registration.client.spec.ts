import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { resolveSlotLabel, type PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'

it('adds the Desktop settings section only with its authenticated endpoint and removes it on disposal', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SlotRegistry).await()
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
    vi.stubGlobal('__DSH_ERP_WEB_CONFIG__', { settingsOnly: true })
    ctx.slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } },
      ({ renderSlot }: PropsRenderSlots<'settings.section'>) => renderSlot('settings.section', { close: () => {} }))
    vi.stubGlobal('__DSH_USER_CONTEXT_PATH__', undefined)
    const absent = ctx.plugin({ name: 'no-erp-settings', inject: ['slots', 'locale'], apply })
    await absent.await()
    expect(ctx.slots.entries('settings.section')).toHaveLength(0)
    await absent.dispose()
    vi.stubGlobal('__DSH_USER_CONTEXT_PATH__', '/api/erp-user-context')
    const page = ctx.plugin({ name: 'erp-settings', inject: ['slots', 'locale'], apply })
    await page.await()
    const entry = ctx.slots.entries('settings.section')[0]!
    expect(entry.options.id).toBe('erp-personal-prompt')
    expect(resolveSlotLabel(entry.options.label)).toBe(en.personalPromptTitle)
    locale.setLocale('zh')
    expect(resolveSlotLabel(entry.options.label)).toBe(zh.personalPromptTitle)
    await page.dispose()
    expect(ctx.slots.entries('settings.section')).toHaveLength(0)
  } finally { await ctx.fiber.dispose(); vi.unstubAllGlobals() }
})
