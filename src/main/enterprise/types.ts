/**
 * [enterprise] T0 企业扩展 - 客户端主进程侧类型定义
 * 仅供 EnterprisePlugin 消费，不进入通用 shared 类型。
 */
/** [enterprise] 技能分类/标签 facet：仅保留展示与筛选所需字段，服务端多余字段由类型层丢弃 */
export interface OrgSkillFacet {
  code: string
  name: string
}

export interface OrgSkillCatalogItem {
  slug: string
  name: string
  description: string
  version: string
  contentHash: string
  downloadUrl: string
  iconUrl?: string | null
  categories?: OrgSkillFacet[]
  tags?: OrgSkillFacet[]
}

/**
 * [enterprise] 服务端 /api/skills 的 tags/categories 有两种形态：
 * 对象数组（管理台文档样例，含 id/sort_order/enabled）或纯字符串数组（线上实测 ["规范","设计"]）。
 */
export type RawOrgSkillFacet = string | { code?: string; name?: string }

export interface OrgConnectorCatalogItem {
  slug: string
  name: string
  description: string
  /** 目录 v2 与管理台快速创建对齐：stdio/sse/streamableHttp（旧服务端恒为 sse） */
  type: 'stdio' | 'sse' | 'streamableHttp'
  baseUrl: string
  /** 完整客户端 MCP DTO（服务端已白名单化并拒绝密钥字段）；旧服务端为 {} */
  config: Record<string, unknown>
}

/** [enterprise] 当前仅支持管理端 PKCE OAuth 认证。 */
export type OrgAuthMode = 'management-oauth'
// [enterprise] 已删除的旧类型：
// export type OrgAuthMode = 'management-oauth' | 'management-exchange' | 'official-direct'
// export type OrgAuthMode = 'management-exchange' | 'official-direct'

export interface OrgSession {
  authMode: OrgAuthMode
  /** 签发该会话的管理端 origin，恢复时用于匹配，避免错端会话被沿用 */
  authOrigin: string
  userId: string
  officialUserId: string
  displayName: string | null
  phone: string
  role: string
  accessToken: string
  refreshToken: string
  /** access token 过期时间（epoch ms），提前 60s 视为过期以触发刷新 */
  expiresAt: number
}
// [enterprise] 原 OrgSession（无 authOrigin 字段，签名由 old enum 决定）：
// export interface OrgSession {
//   authMode: OrgAuthMode
//   userId: string
//   officialUserId: string
//   displayName: string | null
//   phone: string
//   role: string
//   accessToken: string
//   refreshToken: string
//   expiresAt: number
// }

export type OrgAuthPhase = 'signed-out' | 'authorizing' | 'signed-in'

/**
 * [enterprise] PKCE OAuth 回调 URL 解析：meacowork://auth/sso/callback?code=..&state=..
 * 仅接受该 scheme/host/path；官网 token 回调不在此模式中处理。
 */
export function parseOrgAuthCallback(url: URL): { code: string; state: string } | null {
  if (url.protocol !== 'meacowork:' || url.hostname.toLowerCase() !== 'auth' || url.pathname !== '/sso/callback') {
    return null
  }
  const params = new URLSearchParams(url.search)
  const code = params.get('code')
  const state = params.get('state')
  if (!code || !state) return null
  return { code, state }
}

// [enterprise] 旧官网 token 回调解析（已停用，保留以备追溯，不再被调用）：
// export function parseOrgAuthCallback(url: URL): { token: string } | null {
//   if (url.protocol !== 'meacowork:' || url.hostname.toLowerCase() !== 'auth' || url.pathname !== '/sso/callback') {
//     return null
//   }
//   const params = new URLSearchParams(url.search)
//   const token = params.get('token')
//   if (!token) return null
//   return { token }
// }
