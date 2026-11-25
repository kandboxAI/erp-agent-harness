/** Current user's ERP prompt settings; requests never contain login credentials. */
export interface PersonalContext {
  instructions: string
  role_names: string[]
  facts: string[]
  applied_templates: { id: string; template_name: string }[]
  prompt: string
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === 'string') }

/** @param value - Untrusted ERP response. @returns The validated current-user settings. */
export function parsePersonalContext(value: unknown): PersonalContext {
  if (!record(value) || value.code !== 0 || !record(value.data)) throw new Error('ERP personal context unavailable')
  const data = value.data
  if (typeof data.instructions !== 'string' || typeof data.prompt !== 'string' || !strings(data.role_names)
    || !strings(data.facts) || !Array.isArray(data.applied_templates)) throw new Error('Invalid ERP personal context')
  const templates = data.applied_templates.map((item: unknown) => {
    if (!record(item) || typeof item.id !== 'string' || typeof item.template_name !== 'string') throw new Error('Invalid ERP role template')
    return { id: item.id, template_name: item.template_name }
  })
  return { instructions: data.instructions, role_names: data.role_names, facts: data.facts,
    applied_templates: templates, prompt: data.prompt }
}

/**
 * @param instructions - Omit to read; provide text to save.
 * @param signal - Request cancellation.
 * @returns Settings returned by ERP after reading or saving.
 */
export async function requestPersonalContext(instructions?: string, signal?: AbortSignal): Promise<PersonalContext> {
  const response = await fetch('/api/erp-user-context', {
    method: instructions === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
    ...(instructions === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instructions }) }),
  })
  if (!response.ok) throw new Error('ERP personal context unavailable')
  return parsePersonalContext(await response.json())
}
