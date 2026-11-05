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

/** [enterprise] 新增 management-java：服务端 Sa-Token 原生认证，使用 username+password(RSA) 登录，token 头而非 Bearer。旧模式仅用于识别历史凭据文件。 */
export type OrgAuthMode =
  | 'management-exchange'
  | 'management-oauth'
  | 'management-cookie'
  | 'official-direct'
  | 'management-java'

// export interface OrgSession {
//   authMode: OrgAuthMode
//   accountKind: 'management' | 'official'
//   issuerId: string
//   authOrigin: string
//   userId: string
//   officialUserId: string
//   groupId: string | null
//   displayName: string | null
//   phone: string
//   role: string
//   status: string
//   accessToken: string
//   refreshToken: string
//   /** access token 过期时间（epoch ms），提前 60s 视为过期以触发刷新 */
//   expiresAt: number
// }
import type { OrgSession as StoredOrgSession } from './OrgCredentialStore'
export type OrgSession = StoredOrgSession

// 原 /api/server-identity 契约已停用；modern 由 /api/currentuser 一次返回服务实例与当前用户。
// export interface OrgServerIdentity { server_instance_id: string }
export interface OrgCurrentUser {
  server_instance_id: string
  user: {
    id: number | string
    group_id: number | string
    role: string
    status: string
    username?: string | null
    displayName?: string | null
    phone?: string | null
    officialUserId?: string | null
  }
}

export type OrgAuthPhase = 'signed-out' | 'authorizing' | 'signed-in' | 'switching'

export type OrgAuthCallback = { token: string } | { code: string; state: string }

/** [enterprise] 解析官网 SSO token 或管理端 OAuth code 回调。 */
export function parseOrgAuthCallback(url: URL): OrgAuthCallback | null {
  if (url.protocol !== 'meacowork:' || url.hostname.toLowerCase() !== 'auth') return null

  const params = new URLSearchParams(url.search)
  if (url.pathname === '/sso/callback') {
    const token = params.get('token')
    return token ? { token } : null
  }
  if (url.pathname === '/callback') {
    const code = params.get('code')
    const state = params.get('state')
    return code && state ? { code, state } : null
  }
  return null
}

/**
 * [enterprise] Java Sa-Token 原生认证响应契约。
 * 原定义：登录与 /me 均以 { code, message, data } 信封返回；code=200 才成功。
 * Java 原生实际使用 { code, msg, data, requestId }；业务码优先于提示文本，10007 表示无权限。
 * 10008 表示登录失效（需重登），普通 10007 不视为全局账号失效。
 * 字段由类型层统一归一化；id 仅接受合法字符串或安全整数，拒绝精度已丢失的 JSON 数字。
 */
export interface JavaAuthEnvelope<T = unknown> {
  code: number
  // message?: string
  msg?: string
  data?: T
  requestId?: string | null
}

/** 登录成功后 data 必含 accessToken；currentTenant.tenantId 用于与 /me 的企业一致性校验。 */
export interface JavaLoginData {
  accessToken: string
  refreshToken?: string
  currentTenant?: { tenantId?: string | null } | null
  tenantId?: string | null
}

/** /me 返回的用户与授权信息；serverInstanceId/id/tenantId/role 必需，groupId 允许真实 null。 */
export interface JavaMeData {
  serverInstanceId?: string | number | null
  // 兼容 id 或 userId 两种命名。
  id?: string | number | null
  userId?: string | number | null
  username?: string | null
  showName?: string | null
  tenantId?: string | null
  roleCode?: string | null
  role?: string | null
  groupId?: string | number | null
  group_id?: string | number | null
}

/** 归一化后的 Java 身份与授权，供 ProfileAuthBroker 构造 management-java 会话。 */
export interface JavaAuthProfile {
  serverInstanceId: string
  userId: string
  username: string | null
  tenantId: string
  roleCode: string
  groupId: string | null
}
