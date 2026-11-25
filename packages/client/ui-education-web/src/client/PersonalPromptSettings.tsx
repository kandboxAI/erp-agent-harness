/** Personal prompt editor backed by the current ERP account. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, PropsLocale, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from './locales.ts'
import type { PersonalContext } from './personal-context.ts'
import css from './PersonalPromptSettings.module.css'

export interface PersonalPromptFace {
  loadPersonalContext: (signal: AbortSignal) => Promise<PersonalContext>
  savePersonalContext: (instructions: string) => Promise<PersonalContext>
}
type Props = PropsRuntime<'settings.section'> & PropsLocale<'educationWeb'> & InjectFace<PersonalPromptFace>

/** @param props - Settings callbacks and localized copy. @returns The current-account personal prompt form. */
export function PersonalPromptSettings({ t, loadPersonalContext, savePersonalContext }: Props): ReactNode {
  const [context, setContext] = useState<PersonalContext | null>(null)
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'error'>('loading')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')
    setContext(null)
    void loadPersonalContext(controller.signal).then((value) => {
      if (controller.signal.aborted) return
      setContext(value); setDraft(value.instructions); setStatus('ready')
    }).catch(() => { if (!controller.signal.aborted) setStatus('error') })
    return () => { controller.abort() }
  }, [loadPersonalContext, reload])
  const save = async () => {
    setStatus('saving')
    try {
      const value = await savePersonalContext(draft)
      setContext(value); setDraft(value.instructions); setStatus('saved')
    } catch { setStatus('error') }
  }
  return <section className={css.page}>
    <h2>{t('personalPromptTitle')}</h2>
    <p className={css.hint}>{t('personalPromptHint')}</p>
    {status === 'loading' && <p role="status">{t('personalPromptLoading')}</p>}
    {status === 'error' && <div role="alert"><p>{t('personalPromptError')}</p>
      <Button variant="outline" onClick={() => { setReload(value => value + 1) }}>{t('personalPromptRetry')}</Button></div>}
    {context !== null && <>
      <h3>{t('personalPromptIdentity')}</h3>
      {context.role_names.length > 0 && <p>{context.role_names.join('、')}</p>}
      {context.facts.length > 0 && <ul>{context.facts.map(fact => <li key={fact}>{fact}</li>)}</ul>}
      {context.role_names.length === 0 && context.facts.length === 0 && <p className={css.hint}>{t('personalPromptNoIdentity')}</p>}
      <h3>{t('personalPromptRoles')}</h3>
      <p>{context.applied_templates.map(item => item.template_name).join('、') || t('personalPromptNoRoles')}</p>
      <label className={css.label} htmlFor="erp-personal-prompt">{t('personalPromptPreferences')}</label>
      <textarea id="erp-personal-prompt" className={css.editor} value={draft} rows={7} maxLength={2000}
        disabled={status === 'saving'} placeholder={t('personalPromptPlaceholder')}
        onChange={(event) => { setDraft(event.target.value); setStatus('ready') }} />
      <div className={css.count}>{draft.length}/2000</div>
      <div className={css.actions}><Button variant="primary" disabled={status === 'saving'} onClick={() => { void save() }}>
        {t(status === 'saving' ? 'personalPromptSaving' : 'personalPromptSave')}</Button>
      {status === 'saved' && <span role="status">{t('personalPromptSaved')}</span>}
      </div>
      <details className={css.preview}><summary>{t('personalPromptPreview')}</summary><pre>{context.prompt}</pre></details>
    </>}
  </section>
}
