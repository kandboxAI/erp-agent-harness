import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as HostPlugin from '../src/index.ts'
import { liveConfig, omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'
import { plainConfig } from '../../../settings/settings/src/schema.ts'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import {
  Config, apply,
} from '@deepseek-ai/dsh-client-locale'


describe('locale host', () => {
  it('leaves model language unchanged outside Desktop', async () => {
    const previous = process.env.DSH_DESKTOP_SYSTEM_LOCALE
    delete process.env.DSH_DESKTOP_SYSTEM_LOCALE
    try {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, { personaPrefix: '' })
      const configuration = await liveConfig(ctx, { Config, apply }, { preference: 'zh' })
      expect(renderPrompt(await ctx.systemPrompt.assemble())).not.toContain('Use Chinese by default')
      await configuration.fiber.dispose()
    } finally {
      if (previous !== undefined) process.env.DSH_DESKTOP_SYSTEM_LOCALE = previous
    }
  })

  it('updates the model language from the system locale and explicit preference', async () => {
    const previous = process.env.DSH_DESKTOP_SYSTEM_LOCALE
    process.env.DSH_DESKTOP_SYSTEM_LOCALE = 'zh-CN'
    try {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, { personaPrefix: '' })
      const configuration = await liveConfig(ctx, { Config, apply })
      const prompt = async () => renderPrompt(await ctx.systemPrompt.assemble())
      expect(await prompt()).toContain('Use Chinese by default for your own reasoning and final answers.')
      await configuration.update({ preference: 'en' })
      expect(await prompt()).toContain('Use English by default for your own reasoning and final answers.')
      await configuration.update({ preference: 'zh-Hant' })
      expect(await prompt()).toContain('Use Chinese by default for your own reasoning and final answers.')
      await configuration.fiber.dispose()
    } finally {
      if (previous === undefined) delete process.env.DSH_DESKTOP_SYSTEM_LOCALE
      else process.env.DSH_DESKTOP_SYSTEM_LOCALE = previous
    }
  })

  it('registers an open locale preference with the Host settings lifecycle', async () => {
    const ctx = new Context()
    const configuration = await liveConfig(ctx, { Config, apply })
    const { fiber } = configuration
    expect(plainConfig(configuration.fiber.effectiveConfig)).toEqual({})
    await configuration.update({ preference: 'en' })
    expect(plainConfig(configuration.fiber.effectiveConfig)).toEqual({ preference: 'en' })
    await configuration.update({ preference: 'pt-BR' })
    expect(plainConfig(configuration.fiber.effectiveConfig)).toEqual({ preference: 'pt-BR' })
    await expect(configuration.update({ preference: 'bad locale' })).rejects.toThrow()
    await expect(configuration.update({ preference: '123' })).rejects.toThrow()
    await fiber.dispose()
  })
})

it('keeps its own instance off the generated Settings pages', () => omitsGeneratedPage(ctx => ctx.plugin(HostPlugin)))
