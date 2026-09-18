/**
 * [enterprise] T0 企业扩展 - 客户端主进程侧类型定义
 * 仅供 EnterprisePlugin 消费，不进入通用 shared 类型。
 */
export interface OrgSkillCatalogItem {
  slug: string
  name: string
  description: string
  version: string
  contentHash: string
  downloadUrl: string
}

export interface OrgConnectorCatalogItem {
  slug: string
  name: string
  description: string
  type: 'sse'
  baseUrl: string
  config: Record<string, unknown>
}

export interface OrgSession {
  userId: string
  phone: string
  role: string
  accessToken: string
  refreshToken: string
  /** access token 过期时间（epoch ms），提前 60s 视为过期以触发刷新 */
  expiresAt: number
}

export type OrgAuthPhase = 'signed-out' | 'authorizing' | 'signed-in'

/** [enterprise] OAuth 回调 URL 解析：meacowork://auth/callback?code=..&state=.. */
export function parseOrgAuthCallback(
  url: URL
): { code: string; state: string } | null {
  if (url.protocol !== 'meacowork:' || url.hostname.toLowerCase() !== 'auth') return null
  const params = new URLSearchParams(url.search)
  const code = params.get('code')
  const state = params.get('state')
  if (!code || !state) return null
  return { code, state }
}
