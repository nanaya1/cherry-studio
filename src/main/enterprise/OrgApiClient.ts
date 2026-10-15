/**
 * [enterprise] T0 企业扩展 - 企业服务 HTTP 客户端
 * 薄封装：base URL 常量 + 统一 Authorization 头 + json 解析。
 */
import { loggerService } from '@logger'

import type {
  OrgConnectorCatalogItem,
  OrgCurrentUser,
  OrgSession,
  OrgSkillCatalogItem,
  RawOrgSkillFacet
} from './types'

const logger = loggerService.withContext('OrgApiClient')

/**
 * 管理端地址（区别于雪浪网关 XUELANG_API_ORIGIN / Cherry Cloud MAIN_VITE_CHERRY_CLOUD_API_ORIGIN）。
 * 有值时启用管理端 Exchange；无值时启用官网直连模式。
 */
function resolveOrgServerBaseUrl(): string | null {
  const configured = import.meta.env.MAIN_VITE_ORG_SERVER_BASE_URL?.trim()
  if (!configured) return null
  try {
    return new URL(configured).origin
  } catch {
    throw new Error(`MAIN_VITE_ORG_SERVER_BASE_URL 不是合法 URL: ${configured}`)
  }
}

function resolveOfficialApiBaseUrl(): string {
  const configured = import.meta.env.MAIN_VITE_OFFICIAL_API_BASE_URL?.trim()
  if (configured) {
    try {
      return new URL(configured).origin
    } catch {
      throw new Error(`MAIN_VITE_OFFICIAL_API_BASE_URL 不是合法 URL: ${configured}`)
    }
  }

  const loginUrl = import.meta.env.MAIN_VITE_OFFICIAL_LOGIN_URL?.trim() || 'https://mro.xuelangyun.com/login'
  try {
    return new URL(loginUrl).origin
  } catch {
    throw new Error(`MAIN_VITE_OFFICIAL_LOGIN_URL 不是合法 URL: ${loginUrl}`)
  }
}

export type OrgAuthMode = 'management-exchange' | 'management-oauth' | 'management-cookie' | 'official-direct'
export const ORG_SERVER_BASE_URL = resolveOrgServerBaseUrl()
export const OFFICIAL_LOGIN_CONFIGURED = Boolean(import.meta.env.MAIN_VITE_OFFICIAL_LOGIN_URL?.trim())
export const ORG_AUTH_MODE: OrgAuthMode = OFFICIAL_LOGIN_CONFIGURED
  ? ORG_SERVER_BASE_URL
    ? 'management-exchange'
    : 'official-direct'
  : ORG_SERVER_BASE_URL
    ? 'management-oauth'
    : 'official-direct'
export const OFFICIAL_API_BASE_URL = resolveOfficialApiBaseUrl()

export function getOrgApiBaseUrl(): string {
  return ORG_SERVER_BASE_URL ?? OFFICIAL_API_BASE_URL
}

export class OrgApiClient {
  // [enterprise] 修复 401：改为异步取「有效期内的会话」（过期自动刷新）。
  // 原同步裸取：constructor(private readonly getSession: () => OrgSession | null) {}
  constructor(
    private readonly getValidSession: () => Promise<OrgSession | null>,
    private readonly cookieFetch?: (url: string, init: RequestInit) => Promise<Response>
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const session = await this.getValidSession()
    if (!session) throw new Error('未登录')
    if (session.authMode === 'management-cookie') {
      if (!this.cookieFetch) throw new Error('Cookie transport is unavailable')
      const response = await this.cookieFetch(`${getOrgApiBaseUrl()}${path}`, {
        ...init,
        credentials: 'include',
        redirect: 'error',
        headers: { 'content-type': 'application/json', ...init.headers }
      })
      if (!response.ok) throw new Error(`账户服务请求失败 (${response.status})`)
      return (await response.json()) as T
    }
    const res = await this.send(path, session.accessToken, init)
    // [enterprise] 修复 401：access token 被服务端提前吊销时兜底——刷新一次重试一次
    if (res.status === 401) {
      const refreshed = await this.getValidSession()
      if (!refreshed || refreshed.accessToken === session.accessToken) {
        throw new Error(`账户服务请求失败 (${res.status})`)
      }
      const retry = await this.send(path, refreshed.accessToken, init)
      if (!retry.ok) {
        const body = await retry.text().catch(() => '')
        logger.warn('org api request failed', { path, status: retry.status, body: body.slice(0, 200) })
        throw new Error(`账户服务请求失败 (${retry.status})`)
      }
      return (await retry.json()) as T
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      logger.warn('org api request failed', { path, status: res.status, body: body.slice(0, 200) })
      throw new Error(`账户服务请求失败 (${res.status})`)
    }
    return (await res.json()) as T
  }

  private requireCookieFetch() {
    if (!this.cookieFetch) throw new Error('Cookie transport is unavailable')
    return this.cookieFetch
  }

  private async send(path: string, accessToken: string, init: RequestInit): Promise<Response> {
    return fetch(`${getOrgApiBaseUrl()}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
        ...init.headers
      }
    })
  }

  // modern 未提供 /api/server-identity；server_instance_id 由 /api/currentuser 返回。
  // getServerIdentity(): Promise<OrgServerIdentity> { return this.request('/api/server-identity') }
  getCurrentUser(): Promise<OrgCurrentUser> {
    return this.request('/api/currentuser')
  }

  async revoke(refreshToken: string, logoutSession?: OrgSession): Promise<unknown> {
    if (logoutSession) {
      const init = {
        method: 'POST',
        body: JSON.stringify({ refreshToken }),
        signal: AbortSignal.timeout(10_000)
      }
      const response =
        logoutSession.authMode === 'management-cookie'
          ? await this.requireCookieFetch()(`${getOrgApiBaseUrl()}/api/auth/logout`, {
              ...init,
              credentials: 'include',
              redirect: 'error',
              headers: { 'content-type': 'application/json' }
            })
          : await this.send('/api/auth/logout', logoutSession.accessToken, init)
      if (!response.ok) throw new Error(`账户服务请求失败 (${response.status})`)
      return
    }
    // modern 未提供 /api/auth/revoke；登出接口负责撤销 refresh 及其关联 access token。
    // return this.request('/api/auth/revoke', {
    return this.request('/api/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken })
    })
  }

  // 原 publicRequest 匿名目录读取已停用：modern 服务端必须根据 Bearer token 的实时 group_id 做权限裁剪。
  // private async publicRequest<T>(path: string, init: RequestInit = {}): Promise<T> { ... }

  // [enterprise] tags/categories 服务端有字符串数组与对象数组两种形态，归一化在 OrgSkillCatalog.list
  async listSkills() {
    type SkillItem = Omit<OrgSkillCatalogItem, 'categories' | 'tags'> & {
      status?: string
      categories?: RawOrgSkillFacet[]
      tags?: RawOrgSkillFacet[]
    }
    const skills: SkillItem[] = []
    const pageSize = 100
    for (let page = 1; ; page += 1) {
      const result = await this.request<{ items: SkillItem[]; total?: number }>(
        `/api/library-items?page=${page}&pageSize=${pageSize}`
      )
      skills.push(...result.items.filter((item) => item.status === undefined || item.status === 'ready'))
      if (result.items.length < pageSize || page * pageSize >= (result.total ?? 0)) break
    }
    return { skills }
  }

  async listConnectors() {
    const result = await this.request<{
      items: Array<{ id: number; key: string; config: Record<string, unknown> }>
    }>('/api/mcp-servers')
    return {
      connectors: result.items.map((item): OrgConnectorCatalogItem => {
        const config = item.config
        const type = config.type === 'stdio' || config.type === 'streamableHttp' ? config.type : 'sse'
        return {
          slug: item.key || String(item.id),
          name: typeof config.name === 'string' ? config.name : item.key,
          description: typeof config.description === 'string' ? config.description : '',
          type,
          baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : '',
          config
        }
      })
    }
  }

  /**
   * 下载技能包到指定目录。返回本地 tar.gz 路径。
   * hash 校验由调用方（OrgSkillCatalog）完成后解包。
   */
  async downloadSkill(slug: string, destPath: string, expectedHash: string): Promise<void> {
    const { createWriteStream } = await import('node:fs')
    const { createHash } = await import('node:crypto')

    // [enterprise] 修复 401：与 request() 一致改走异步 getValidSession（原裸 getSession 注释保留）
    // const session = this.getSession()
    const session = await this.getValidSession()
    if (!session) throw new Error('未登录')
    // const res = await fetch(url, { headers: { authorization: `Bearer ${session.accessToken}` } })
    const url = `${getOrgApiBaseUrl()}/api/skills/${slug}/download`
    const res =
      session.authMode === 'management-cookie'
        ? await this.requireCookieFetch()(url, { credentials: 'include', redirect: 'error' })
        : await fetch(url, { headers: { authorization: `Bearer ${session.accessToken}` }, credentials: 'omit' })
    if (!res.ok || !res.body) throw new Error(`技能包下载失败 (${res.status})`)

    const hash = createHash('sha256')
    const file = createWriteStream(destPath)
    // 边写边算 hash，落盘完成后与目录声明的 contentHash 比对
    const reader = res.body.getReader()
    const chunks: Buffer[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const buf = Buffer.from(value)
      chunks.push(buf)
      hash.update(buf)
    }
    await new Promise<void>((resolve, reject) => {
      file.on('finish', () => resolve())
      file.on('error', reject)
      for (const chunk of chunks) file.write(chunk)
      file.end()
    })
    const actual = hash.digest('hex')
    if (actual !== expectedHash) {
      throw new Error(`技能包校验失败：期望 ${expectedHash.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`)
    }
  }

  reportLifecycle(skillSlug: string, event: string, detail: Record<string, unknown> = {}) {
    // 上报失败不阻塞主流程。不在此处预取会话：会话获取与 401 刷新重试完全由 request() 驱动，
    // 预取会多消耗一次 getValidSession 并干扰 request() 的「token 未变化则不重试」判断。
    // 匿名（未登录）时 request() 抛「未登录」，这里等价于跳过上报。
    return this.request('/api/skills/lifecycle', {
      method: 'POST',
      body: JSON.stringify({ skillSlug, event, detail })
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      if (message === '未登录') {
        logger.info('lifecycle report skipped: signed out', { skillSlug, event })
        return undefined
      }
      logger.warn('lifecycle report failed', { skillSlug, event, error: message })
      return undefined
    })
  }
}
