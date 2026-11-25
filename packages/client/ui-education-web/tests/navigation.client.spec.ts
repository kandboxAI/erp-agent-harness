import { describe, expect, it, vi } from 'vitest'
import type { ILayout, MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { EducationNavigationController, parseNavigationCommand } from '../src/client/navigation-controller.ts'
import { NAVIGATION_ACK_PATH, NAVIGATION_EVENTS_PATH } from '../src/navigation-contract.ts'

class FakeEventSource {
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  readonly close = vi.fn()
}

describe('education navigation browser controller', () => {
  it('selects the education panel for a validated SSE command and posts acknowledgements', async () => {
    const source = new FakeEventSource()
    const selectPanel = vi.fn()
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }))
    const controller = new EducationNavigationController(
      { selectPanel } as unknown as ILayout,
      'education-web' as MainPanelId,
      (url) => {
        expect(url).toBe(NAVIGATION_EVENTS_PATH)
        return source as unknown as EventSource
      },
      fetcher,
    )
    const stop = controller.start()
    source.onmessage?.({ data: JSON.stringify({
      requestId: 'request-1', path: '/students/list', query: {}, replace: false,
    }) } as MessageEvent<string>)

    expect(selectPanel).toHaveBeenCalledWith('education-web')
    expect(controller.state.getSnapshot()).toMatchObject({ requestId: 'request-1', path: '/students/list' })
    await controller.acknowledge({ requestId: 'request-1', ok: true, actualPath: '/students/list' })
    expect(fetcher).toHaveBeenCalledWith(NAVIGATION_ACK_PATH, expect.objectContaining({ method: 'POST' }))

    stop()
    expect(source.close).toHaveBeenCalledOnce()
    expect(controller.state.getSnapshot()).toBeNull()
  })

  it('accepts system pages and drops malformed or unsafe commands', () => {
    expect(parseNavigationCommand('not-json')).toBeUndefined()
    expect(parseNavigationCommand(JSON.stringify({
      requestId: 'x', path: '/system/role/index', query: {}, replace: false,
    }))).toMatchObject({ path: '/system/role/index' })
    expect(parseNavigationCommand(JSON.stringify({
      requestId: 'x', path: '//example.com/system/role/index', query: {}, replace: false,
    }))).toBeUndefined()
    expect(parseNavigationCommand(JSON.stringify({
      requestId: 'x', path: '/students/list', query: { nested: {} }, replace: false,
    }))).toBeUndefined()
  })
})
