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

export type OrgAuthMode = 'management-exchange' | 'official-direct'

export interface OrgSession {
  authMode: OrgAuthMode
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

export type OrgAuthPhase = 'signed-out' | 'authorizing' | 'signed-in'

/** [enterprise] 官网 SSO 回调 URL 解析：meacowork://auth/sso/callback?token=.. */
export function parseOrgAuthCallback(url: URL): { token: string } | null {
  if (
    url.protocol !== 'meacowork:' ||
    url.hostname.toLowerCase() !== 'auth' ||
    url.pathname !== '/sso/callback'
  ) {
    return null
  }
  const params = new URLSearchParams(url.search)
  const token = params.get('token')
  if (!token) return null
  return { token }
}
