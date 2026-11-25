/** Validated public identity supplied by an ERP suite. */
export interface ErpBranding {
  readonly product_name: string
  readonly app_id: string
  readonly artifact_prefix: string
  readonly assistant_name: string
  readonly icon?: string
  readonly iconDataUrl?: string
}
export function resolveErpBranding(env: NodeJS.ProcessEnv): ErpBranding | undefined
export function erpClientBuildEnvironment(env: NodeJS.ProcessEnv): Record<string, string>
export function erpClientIconDefine(env: NodeJS.ProcessEnv): string | undefined
