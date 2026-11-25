import { describe, expect, it } from 'vitest'
import { buildAssistantPrompt } from '../src/client/assistant-controller.ts'

describe('ERP quick assistant prompt context', () => {
  it('keeps the user request first and appends compact router context', () => {
    const prompt = buildAssistantPrompt('更新这个学生的联系电话', {
      path: '/students/list/profile/42',
      fullPath: '/students/list/profile/42?tab=basic',
      title: '学生档案',
      entity: 'student',
      params: { id: '42' },
      query: { tab: 'basic' },
    })

    expect(prompt.startsWith('更新这个学生的联系电话\n')).toBe(true)
    expect(prompt).toContain('<erp_page_context>')
    expect(prompt).toContain('"path":"/students/list/profile/42"')
    expect(prompt).toContain('"id":"42"')
  })

  it('does not add an envelope before the iframe reports context', () => {
    expect(buildAssistantPrompt('打开学生列表', null)).toBe('打开学生列表')
  })
})
