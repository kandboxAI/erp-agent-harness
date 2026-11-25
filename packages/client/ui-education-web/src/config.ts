/** Host-provided location and startup behavior for the embedded education application. */
import z from '@deepseek-ai/schemastery'

/** Resolved education panel configuration shared with the browser plugin. */
export interface Config {
  /** Mount only shared personal settings, without the iframe panel or navigation. */
  settingsOnly?: boolean
  /** HTTP(S) address loaded in the embedded frame. */
  url: string
  /** Whether a fresh Harness page selects the education panel after boot. */
  openOnStartup: boolean
  /** Maximum time to wait for the embedded application to acknowledge navigation. */
  navigationTimeoutMs: number
}

/** Validate and normalize one embedded application URL. */
function educationUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('education-web url must use HTTP or HTTPS')
  }
  return url.href
}

/** Deployment configuration embedded in the served Harness page. */
export const Config: z<Partial<Config>, Config> = z.object({
  settingsOnly: z.boolean().default(false),
  url: z.transform(z.string(), educationUrl).default('http://127.0.0.1:8848'),
  openOnStartup: z.boolean().default(true),
  navigationTimeoutMs: z.number().min(1_000).default(15_000),
})
