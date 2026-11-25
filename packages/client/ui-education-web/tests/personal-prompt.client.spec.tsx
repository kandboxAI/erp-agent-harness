// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PersonalPromptSettings } from '../src/client/PersonalPromptSettings.tsx'
import { requestPersonalContext } from '../src/client/personal-context.ts'
import { en, zh } from '../src/client/locales.ts'
import { makeTranslate } from '../../../test-support/client-runtime/src/translate.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

// This form does not consume Session, Workspace, resource, or panel selectors.
// Supply the framework seats so the fixture also checks the complete client type aggregate.
const unusedGlobalHook = (): never => { throw new Error('Unexpected global selector read') }
const standardProps = {
  useRemoteAccess: unusedGlobalHook,
  useSessionAccess: unusedGlobalHook,
  useWorkspaceAccess: unusedGlobalHook,
  useContextMenu: unusedGlobalHook,
  usePanelInfo: unusedGlobalHook,
  useSessions: unusedGlobalHook,
  useSessionStatus: unusedGlobalHook,
  useSessionRetainInfo: unusedGlobalHook,
  useWorkspaces: unusedGlobalHook,
  useResource: unusedGlobalHook,
}

const current = { instructions: '简洁回答', role_names: ['班主任'], facts: ['负责班级：一班；任教：语文'],
  applied_templates: [{ id: 'role-template', template_name: '班主任·工作指导' }], prompt: '班主任指导\n简洁回答' }

it.each([zh, en])('renders current identity and saves only personal preferences: %s', async (copy) => {
  let saved = { ...current }
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === 'POST') {
      const payload = JSON.parse(init.body as string) as { instructions: string }
      expect(Object.keys(payload)).toEqual(['instructions'])
      saved = { ...saved, instructions: payload.instructions, prompt: '班主任指导\n' + payload.instructions }
    }
    return Response.json({ code: 0, data: saved })
  })
  vi.stubGlobal('fetch', fetcher)
  const load = (signal: AbortSignal) => requestPersonalContext(undefined, signal)
  const view = render(<PersonalPromptSettings {...standardProps} close={() => {}} t={makeTranslate(copy)}
    loadPersonalContext={load} savePersonalContext={requestPersonalContext} />)
  await screen.findByRole('textbox', { name: copy.personalPromptPreferences })
  expect(view.container.textContent).toContain(current.facts[0])
  expect(screen.queryByRole('combobox')).toBeNull()
  await expect(view.container.textContent + '\n').toMatchFileSnapshot(`./expected/personal-prompt-${copy === zh ? 'zh' : 'en'}.txt`)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '通知先给正文' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: copy.personalPromptSave })) })
  expect(saved.instructions).toBe('通知先给正文')
  expect(saved.applied_templates).toEqual(current.applied_templates)
  expect(screen.getByRole('status').textContent).toBe(copy.personalPromptSaved)
  expect(fetcher.mock.calls.map(row => row[1].method)).toEqual(['GET', 'POST'])
  expect(fetcher.mock.calls.every(row => row[0] === '/api/erp-user-context')).toBe(true)
})

it('retains an unsaved draft after save failure and does not show success', async () => {
  const save = vi.fn(async () => { throw new Error('offline') })
  render(<PersonalPromptSettings {...standardProps} close={() => {}} t={makeTranslate(zh)}
    loadPersonalContext={async () => current} savePersonalContext={save} />)
  const textbox = await screen.findByRole('textbox')
  fireEvent.change(textbox, { target: { value: '保留我的草稿' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.personalPromptSave })) })
  expect(screen.getByRole('alert').textContent).toContain(zh.personalPromptError)
  expect((textbox as HTMLTextAreaElement).value).toBe('保留我的草稿')
  expect(screen.queryByText(zh.personalPromptSaved)).toBeNull()
})

it('reports login or load failure without opening a writable form', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })))
  render(<PersonalPromptSettings {...standardProps} close={() => {}} t={makeTranslate(zh)}
    loadPersonalContext={signal => requestPersonalContext(undefined, signal)} savePersonalContext={requestPersonalContext} />)
  await screen.findByRole('alert')
  expect(screen.queryByRole('textbox')).toBeNull()
})
