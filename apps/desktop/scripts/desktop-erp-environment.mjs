/** Validate the ERP frontend resources and backend origin shared by packaging stages. */

import { accessSync, constants, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/**
 * Resolve the ERP inputs before building or copying application resources.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {boolean} unsigned - Whether loopback HTTP is allowed for a local test package.
 * @returns {{ dist: string, apiUrl: string } | undefined} Validated ERP inputs, or undefined for ordinary Desktop.
 */
export function resolveDesktopErpEnvironment(env, unsigned) {
  const dist = env.ERP_DIST_DIR
  const apiUrl = env.ERP_API_URL
  if (dist === undefined && apiUrl === undefined) return undefined
  if (!dist) throw new Error('ERP desktop package: ERP_DIST_DIR is required when ERP_API_URL is set')
  if (!isAbsolute(dist)) throw new Error(`ERP desktop package: ERP_DIST_DIR must be absolute: ${dist}`)
  if (!apiUrl) throw new Error('ERP desktop package: ERP_API_URL is required when ERP_DIST_DIR is set')
  const entry = join(dist, 'index.html')
  try {
    if (!statSync(entry).isFile()) throw new Error('not a file')
    accessSync(entry, constants.R_OK)
  } catch (error) {
    throw new Error(`ERP desktop package: missing or unreadable frontend entry ${entry}; build the ERP frontend and set ERP_DIST_DIR to its output directory`, { cause: error })
  }
  let api
  try { api = new URL(apiUrl) }
  catch { throw new Error('ERP desktop package: ERP_API_URL must be a valid backend origin') }
  const localHttp = unsigned && api.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname)
  if ((!localHttp && api.protocol !== 'https:') || api.pathname !== '/'
    || api.search || api.hash || api.username || api.password) {
    throw new Error('ERP desktop package: ERP_API_URL must be HTTPS or unsigned local-test loopback HTTP')
  }
  return { dist, apiUrl }
}
