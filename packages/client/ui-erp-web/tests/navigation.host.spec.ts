import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { ErpNavigationBroker } from '../src/navigation-host.ts'
import { isAllowedErpPath, type NavigationCommand } from '../src/navigation-contract.ts'

class FakeResponse extends EventEmitter {
  destroyed = false
  writableEnded = false
  readonly writes: string[] = []

  writeHead(): void {}
  write(value: string): void { this.writes.push(value) }
  end(): void { this.writableEnded = true }
}

const command: NavigationCommand = {
  requestId: 'request-1',
  path: '/students/list',
  query: { keyword: '张三' },
  replace: false,
}

describe('ERP navigation Host broker', () => {
  it('streams a command and settles it from the iframe acknowledgement', async () => {
    const broker = new ErpNavigationBroker(1_000)
    const response = new FakeResponse()
    broker.connect(response as unknown as ServerResponse)

    const result = broker.dispatch(command, new AbortController().signal)
    expect(response.writes.join('')).toContain('"path":"/students/list"')
    expect(broker.acknowledge({ requestId: command.requestId, ok: true, actualPath: '/students/list' })).toBe(true)
    await expect(result).resolves.toEqual({ requestId: command.requestId, ok: true, actualPath: '/students/list' })

    response.emit('close')
    await expect(broker.dispatch({ ...command, requestId: 'request-2' }, new AbortController().signal))
      .resolves.toMatchObject({ ok: false, message: expect.stringContaining('Harness Web') })
    broker.dispose()
  })

  it('accepts every internal ERP route and rejects external-shaped or embedded-query paths', () => {
    expect(isAllowedErpPath('/education/course-schedule')).toBe(true)
    expect(isAllowedErpPath('/system/role/index')).toBe(true)
    expect(isAllowedErpPath('/future-module/page')).toBe(true)
    expect(isAllowedErpPath('/login')).toBe(true)
    expect(isAllowedErpPath('//example.com/education')).toBe(false)
    expect(isAllowedErpPath('/education/list?unsafe=true')).toBe(false)
    expect(isAllowedErpPath('/%5cexample.com')).toBe(false)
  })
})
