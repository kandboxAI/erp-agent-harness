/** Harness-global quick assistant palette and conversation drawer. */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { IconCloseOutlineRegular, IconSearchOutlineRegular, IconSendOutlineRegular, IconSparkleRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { EducationAssistantState } from './assistant-controller.ts'
import css from './EducationPanel.module.css'

/** Root-overlay dependencies for the Harness-global assistant. */
export interface EducationAssistantFace {
  readonly hooks: { readonly assistant: HostObservable<EducationAssistantState> }
  readonly openAssistant: () => void
  readonly closeAssistant: () => void
  readonly openConversation: () => void
  readonly sendAssistantPrompt: (prompt: string, includeEducationContext: boolean) => Promise<void>
}

export type EducationAssistantProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'educationWeb'>
  & InjectFace<EducationAssistantFace>

/** Render the discoverable launcher and the multi-turn quick-assistant surface. */
export function EducationAssistant({
  useAssistant, usePanelInfo, t, openAssistant, closeAssistant, openConversation, sendAssistantPrompt,
}: EducationAssistantProps): ReactNode {
  const state = useAssistant(value => value)
  const educationActive = usePanelInfo(info => String(info.activePanelId) === 'education-web')
  const [draft, setDraft] = useState('')
  const paletteInputRef = useRef<HTMLInputElement>(null)
  const drawerInputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (state.mode === 'palette') paletteInputRef.current?.focus()
    if (state.mode === 'drawer') drawerInputRef.current?.focus()
  }, [state.mode])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [state.turns, state.busy])

  useEffect(() => {
    if (state.mode === 'closed') return
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeAssistant()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => { window.removeEventListener('keydown', closeOnEscape) }
  }, [closeAssistant, state.mode])

  useEffect(() => {
    const openOnShortcut = (event: globalThis.KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'k' || (!event.ctrlKey && !event.metaKey) || event.altKey) return
      event.preventDefault()
      openAssistant()
    }
    window.addEventListener('keydown', openOnShortcut)
    return () => { window.removeEventListener('keydown', openOnShortcut) }
  }, [openAssistant])

  const submit = (event?: FormEvent): void => {
    event?.preventDefault()
    const prompt = draft.trim()
    if (prompt === '' || state.busy) return
    setDraft('')
    void sendAssistantPrompt(prompt, educationActive)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    submit()
  }

  if (state.mode === 'closed') {
    return (
      <button className={css.assistantLauncher} type="button" onClick={openAssistant} aria-label={t('assistantOpen')}>
        <IconSparkleRegular />
        <span>{t('assistantShort')}</span>
        <kbd>{t('assistantShortcut')}</kbd>
      </button>
    )
  }

  const contextLabel = educationActive
    ? state.pageContext?.title || state.pageContext?.path || t('assistantUnknownPage')
    : t('assistantHarnessPage')

  const errorMessage = state.errorCode !== undefined
    ? t(state.errorCode === 'no-session'
      ? 'assistantNoSessionError'
      : state.errorCode === 'session-busy'
        ? 'assistantSessionBusy'
        : state.errorCode === 'max-tokens'
          ? 'assistantMaxTokens'
          : 'assistantTurnFailed')
    : state.error

  if (state.mode === 'palette') {
    return (
      <div className={css.assistantBackdrop} role="presentation" onMouseDown={closeAssistant}>
        <form
          className={css.assistantPalette}
          role="dialog"
          aria-modal="true"
          aria-label={t('assistantTitle')}
          onSubmit={submit}
          onMouseDown={(event) => { event.stopPropagation() }}
        >
          <div className={css.paletteInputRow}>
            <IconSearchOutlineRegular size={20} />
            <input
              ref={paletteInputRef}
              value={draft}
              onChange={(event) => { setDraft(event.target.value) }}
              placeholder={educationActive ? t('assistantPaletteEducationPlaceholder') : t('assistantPalettePlaceholder')}
              aria-label={t('assistantPalettePlaceholder')}
              autoComplete="off"
            />
            <button
              className={css.paletteSendButton}
              type="submit"
              disabled={draft.trim() === '' || state.busy || state.sessionId === undefined}
              aria-label={t('assistantSend')}
            >
              <IconSendOutlineRegular />
            </button>
          </div>
          <div className={css.paletteMeta}>
            <div className={css.paletteContext} title={educationActive ? state.pageContext?.fullPath : undefined}>
              <IconSparkleRegular size={14} />
              <span>{t('assistantCurrentPage')}</span>
              <strong>{contextLabel}</strong>
            </div>
            <div className={css.paletteHints}>
              <span><kbd>{t('assistantPaletteEnterKey')}</kbd> {t('assistantPaletteSendHint')}</span>
              <span><kbd>{t('assistantPaletteEscapeKey')}</kbd> {t('assistantPaletteCloseHint')}</span>
            </div>
          </div>
          {errorMessage !== undefined && <p className={css.paletteError}>{errorMessage}</p>}
        </form>
      </div>
    )
  }

  return (
    <aside className={css.assistantDrawer} aria-label={t('assistantTitle')}>
      <header className={css.assistantHeader}>
        <div className={css.assistantHeading}>
          <span className={css.assistantMark}><IconSparkleRegular /></span>
          <div>
            <h2>{t('assistantTitle')}</h2>
            <p>{state.sessionTitle ?? t('assistantNoSession')}</p>
          </div>
        </div>
        <button className={css.iconButton} type="button" onClick={closeAssistant} aria-label={t('assistantClose')}>
          <IconCloseOutlineRegular />
        </button>
      </header>

      <div className={css.contextBar} title={educationActive ? state.pageContext?.fullPath : undefined}>
        <span>{t('assistantCurrentPage')}</span>
        <strong>{contextLabel}</strong>
      </div>

      <div ref={scrollRef} className={css.assistantMessages}>
        {state.turns.length === 0 && (
          <div className={css.assistantWelcome}>
            <IconSparkleRegular size={22} />
            <h3>{t('assistantWelcomeTitle')}</h3>
            <p>{t('assistantWelcomeBody')}</p>
          </div>
        )}
        {state.turns.map(turn => (
          <div className={css.turn} key={turn.id}>
            <div className={css.userBubble}>{turn.prompt}</div>
            <div className={css.assistantBubble}>
              {turn.response !== '' && <p>{turn.response}</p>}
              {turn.status === 'error' && <p className={css.errorText}>{turn.error}</p>}
              {(turn.status === 'sending' || turn.status === 'working') && (
                <div className={css.workingRow}>
                  <span className={css.workingDot} />
                  <span>{turn.toolName === undefined ? t('assistantWorking') : `${t('assistantCalling')} ${turn.toolName}`}</span>
                </div>
              )}
              {turn.status === 'complete' && turn.response === '' && <p>{t('assistantCompleted')}</p>}
            </div>
          </div>
        ))}
        {errorMessage !== undefined && <p className={css.drawerError}>{errorMessage}</p>}
      </div>

      <form className={css.assistantComposer} onSubmit={submit}>
        <textarea
          ref={drawerInputRef}
          value={draft}
          onChange={(event) => { setDraft(event.target.value) }}
          onKeyDown={onKeyDown}
          placeholder={t('assistantPlaceholder')}
          rows={3}
          disabled={state.sessionId === undefined}
        />
        <div className={css.composerFooter}>
          <button className={css.fullConversationButton} type="button" onClick={openConversation}>
            {t('assistantOpenConversation')}
          </button>
          <button
            className={css.sendButton}
            type="submit"
            disabled={draft.trim() === '' || state.busy || state.sessionId === undefined}
            aria-label={t('assistantSend')}
          >
            <IconSendOutlineRegular />
          </button>
        </div>
      </form>
    </aside>
  )
}
