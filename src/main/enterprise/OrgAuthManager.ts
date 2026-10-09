/**
 * [enterprise] T0 企业扩展 - 登录管理器
 * 官网 SSO：系统浏览器登录 + 官网 token 回调，回调改走 meacowork://auth 深链
 * （由 ProtocolService case 'auth' 分发到 handleAuthCallback）。
 */
import { shell } from 'electron'

import { application } from '@application'
import { loggerService } from '@logger'

import { OrgApiClient, ORG_AUTH_MODE, OFFICIAL_API_BASE_URL, ORG_SERVER_BASE_URL } from './OrgApiClient'
import { OrgCredentialStore, type OrgSession } from './OrgCredentialStore'
// import { orgStateStore } from './OrgStateStore' // [enterprise] copy 模式不再按登录态管理已安装资源
import { parseOrgAuthCallback, type OrgAuthPhase } from './types'

const logger = loggerService.withContext('OrgAuthManager')

const ORG_BASE_URL = ORG_SERVER_BASE_URL
const OFFICIAL_LOGIN_URL = import.meta.env.MAIN_VITE_OFFICIAL_LOGIN_URL?.trim() || 'https://mro.xuelangyun.com/login'
const REDIRECT_URI = 'meacowork://auth/sso/callback'

interface PendingAuth {
  createdAt: number
}

/** verifier 暂存 10 分钟，超时作废（页面登录成功但回调丢失时自动过期） */
const PENDING_TTL_MS = 10 * 60 * 1000
/** access token 提前 60s 判过期，留刷新窗口 */
const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000

export class OrgAuthManager {
  private credentialStore = new OrgCredentialStore()
  private session: OrgSession | null = null
  private pending: PendingAuth | null = null
  private refreshing: Promise<void> | null = null

  // [enterprise] 修复 401：apiClient 改用 getValidSession（过期自动刷新）。
  // 原裸会话注入注释保留：apiClient = new OrgApiClient(() => this.session)
  apiClient = new OrgApiClient(() => this.getValidSession())

  constructor() {
    // 启动时恢复持久化会话（冷启动恢复）
    this.session = this.credentialStore.load()
  }

  getPhase(): OrgAuthPhase {
    if (this.pending) return 'authorizing'
    return this.session ? 'signed-in' : 'signed-out'
  }

  getStatus() {
    return {
      phase: this.getPhase(),
      authMode: ORG_AUTH_MODE,
      phone: this.session?.phone ?? null,
      role: this.session?.role ?? null
    }
  }

  /** 开始登录：打开官网登录页，官网完成后回调自定义协议地址 */
  async startLogin(): Promise<{ authorizationUrl: string }> {
    this.pending = { createdAt: Date.now() }
    this.emitStatus()

    // const params = new URLSearchParams({ redirect_uri: REDIRECT_URI })
    const authorizationUrl = OFFICIAL_LOGIN_URL

    // 摘要日志，不落 verifier
    logger.info('starting org login, opening system browser')
    await shell.openExternal(authorizationUrl)
    return { authorizationUrl }
  }

  /** ProtocolService case 'auth' 转发进来 */
  async handleAuthCallback(url: URL): Promise<void> {
    const callback = parseOrgAuthCallback(url)
    if (!callback) {
      logger.warn('org auth callback rejected')
      return
    }
    const { token } = callback

    const pending = this.pending
    if (!pending) {
      logger.warn('org auth callback without pending login')
      return
    }
    if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
      logger.warn('org auth pending expired')
      this.pending = null
      this.emitStatus()
      return
    }

    try {
      if (ORG_AUTH_MODE === 'official-direct') {
        this.session = await this.exchangeOfficialToken(token)
      } else {
        if (!ORG_BASE_URL) throw new Error('management server URL is not configured')
        const res = await fetch(`${ORG_BASE_URL}/api/auth/exchange`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ officialToken: token })
        })
        if (!res.ok) throw new Error(`org auth exchange failed (${res.status})`)
        const data = (await res.json()) as {
          accessToken: string
          refreshToken: string
          expiresIn: number
          user: { id: string; phone: string; role: string; officialUserId?: string }
        }

        this.session = {
          authMode: 'management-exchange',
          userId: data.user.id,
          officialUserId: data.user.officialUserId ?? '',
          phone: data.user.phone,
          role: data.user.role,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          expiresAt: Date.now() + data.expiresIn * 1000
        }
      }
      this.credentialStore.save(this.session)
      this.pending = null
      // [enterprise] copy 模式：已安装资源属于本地，登录只恢复组织目录访问。
      // orgStateStore.markAvailable()
      logger.info('org login succeeded', { phone: this.session.phone, role: this.session.role })
      this.emitStatus()
    } catch (error) {
      logger.error('org auth callback failed', error as Error)
      this.pending = null
      this.emitStatus()
      throw error
    }
  }

  private async exchangeOfficialToken(token: string): Promise<OrgSession> {
    const res = await fetch(`${OFFICIAL_API_BASE_URL}/xlyApi/business/user/userInfo`, {
      headers: { authorization: `Bearer ${token}` }
    })
    if (!res.ok) throw new Error(`official userInfo failed (${res.status})`)
    const body = (await res.json()) as {
      code?: number
      data?: {
        userId?: number | string
        userNickname?: string | null
        userPhone?: string | null
      } | null
    }
    if (body.code !== 200 || body.data?.userId === undefined || body.data?.userId === null) {
      throw new Error('official userInfo invalid')
    }
    return {
      authMode: 'official-direct',
      userId: String(body.data.userId),
      officialUserId: String(body.data.userId),
      phone: body.data.userPhone ?? '',
      role: '',
      accessToken: token,
      refreshToken: '',
      expiresAt: Number.MAX_SAFE_INTEGER
    }
  }

  /** 退出登录：清内存 + 清文件（T0 不调服务端 revoke，refresh 14 天自然过期） */
  logout(): void {
    this.session = null
    this.pending = null
    this.credentialStore.clear()
    // [enterprise] copy 模式：登出仅结束目录访问，已安装的本地副本继续可用。
    // orgStateStore.markUnavailable()
    logger.info('org logout')
    this.emitStatus()
  }

  /** 供 HTTP 客户端取有效 access token；过期自动刷新 */
  async getValidSession(): Promise<OrgSession | null> {
    if (!this.session) return null
    if (this.session.authMode === 'official-direct' || Date.now() < this.session.expiresAt - TOKEN_EXPIRY_MARGIN_MS) return this.session
    await this.refreshSession()
    return this.session
  }

  private async refreshSession(): Promise<void> {
    // 并发去重：同时多个请求过期时只刷一次
    this.refreshing ||= this.doRefresh().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async doRefresh(): Promise<void> {
    const current = this.session
    if (!current) return
    if (current.authMode === 'official-direct') return
    if (!ORG_BASE_URL) throw new Error('management server URL is not configured')
    try {
      const res = await fetch(`${ORG_BASE_URL}/api/auth/token/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken })
      })
      if (!res.ok) throw new Error(`refresh failed (${res.status})`)
      const data = (await res.json()) as { accessToken: string; refreshToken: string; expiresIn: number }
      // 轮换语义：服务端已作废旧 refresh，必须一并替换
      this.session = {
        ...current,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresAt: Date.now() + data.expiresIn * 1000
      }
      this.credentialStore.save(this.session)
    } catch (error) {
      logger.warn('org session refresh failed, signing out locally', { error: String(error) })
      this.logout()
    }
  }

  private emitStatus() {
    // 广播给渲染层（设置卡片据此刷新 UI）
    try {
      application.get('IpcApiService').broadcast('enterprise.status_changed', this.getStatus())
    } catch (error) {
      logger.warn('failed to broadcast org status', { error: String(error) })
    }
  }
}
