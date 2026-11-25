/** Public ERP suite identity shared by client builds and Desktop packaging. */
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'

/** @param {NodeJS.ProcessEnv} env Build environment. @returns {{product_name:string,app_id:string,artifact_prefix:string,assistant_name:string,icon?:string,iconDataUrl?:string}|undefined} Validated suite identity. */
export function resolveErpBranding(env) {
  if (env.DSH_ERP_BRANDING === undefined) return undefined
  if (!env.ERP_DIST_DIR) throw new Error('ERP branding requires ERP_DIST_DIR')
  const value = JSON.parse(env.DSH_ERP_BRANDING)
  const required = ['product_name', 'app_id', 'artifact_prefix', 'assistant_name']
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => typeof value[key] !== 'string' || !value[key].trim() || value[key] !== value[key].trim())
    || Object.keys(value).some(key => ![...required, 'icon'].includes(key))) throw new Error('ERP branding fields are invalid')
  if (/[<>:"/\\|?*\u0000-\u001f]/u.test(value.product_name) || value.product_name.length > 80
    || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(value.app_id)
    || !/^[a-z][a-z0-9-]*$/u.test(value.artifact_prefix)) throw new Error('ERP branding product name, app ID or artifact prefix is invalid')
  if (value.icon === undefined) return value
  if (typeof value.icon !== 'string' || !isAbsolute(value.icon)) throw new Error('ERP branding icon must be an absolute PNG file')
  const bytes = readFileSync(value.icon)
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    || bytes.readUInt32BE(16) < 256 || bytes.readUInt32BE(16) !== bytes.readUInt32BE(20)) {
    throw new Error('ERP branding icon must be a square PNG of at least 256 pixels')
  }
  return { ...value, iconDataUrl: `data:image/png;base64,${bytes.toString('base64')}` }
}

/** @param {NodeJS.ProcessEnv} env Build environment. @returns {Record<string,string>} Public build identity; icon bytes stay out of child-process environments. */
export function erpClientBuildEnvironment(env) {
  const branding = resolveErpBranding(env)
  return branding === undefined ? {} : {
    DSH_CLIENT_ERP_BRAND: '1',
    DSH_CLIENT_TITLE: branding.product_name,
    ...(branding.iconDataUrl === undefined ? {} : { DSH_CLIENT_BRAND_ICON: createHash('sha256').update(branding.iconDataUrl).digest('hex') }),
  }
}

/** @param {NodeJS.ProcessEnv} env Build environment. @returns {string|undefined} Verified icon data to inline directly at the bundler boundary. */
export function erpClientIconDefine(env) {
  const marker = env.DSH_CLIENT_BRAND_ICON
  if (marker === undefined) return undefined
  const branding = resolveErpBranding(env)
  if (branding?.iconDataUrl === undefined || erpClientBuildEnvironment(env).DSH_CLIENT_BRAND_ICON !== marker) {
    throw new Error('ERP branding icon changed after build selection; restart the build')
  }
  return branding.iconDataUrl
}
