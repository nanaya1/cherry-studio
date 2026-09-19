/**
 * [enterprise] T0 企业扩展 - 登录管理器
 * 参考 CherryCloudService：系统浏览器授权 + PKCE，回调改走 meacowork://auth 深链
 * （由 ProtocolService case 'auth' 分发到 handleAuthCallback）。
 */
import { createHash, randomBytes } from 'node:crypto'
import { shell } from 'electron'
import { application } from '@application'
import { loggerService } from '@logger'
import { OrgApiClient } from './OrgApiClient'
import { OrgCredentialStore, type OrgSession } from './OrgCredentialStore'
import { orgStateStore } from './OrgStateStore'
import type { OrgAuthPhase } from './types'

const logger = loggerService.withContext('OrgAuthManager')

// T0 联调固定地址；M 里程碑移入配置
const ORG_BASE_URL = 'http://127.0.0.1:3000'
const CLIENT_ID = 'cherry-desktop'
const REDIRECT_URI = 'meacowork://auth/callback'

interface PendingAuth {
  state: string
  codeVerifier: string
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
      phone: this.session?.phone ?? null,
      role: this.session?.role ?? null
    }
  }

  /** 开始登录：生成 PKCE + 跳系统浏览器 */
  async startLogin(): Promise<{ authorizationUrl: string }> {
    const state = randomBytes(16).toString('base64url')
    const codeVerifier = randomBytes(32).toString('base64url')
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')

    this.pending = { state, codeVerifier, createdAt: Date.now() }
    this.emitStatus()

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    })
    const authorizationUrl = `${ORG_BASE_URL}/authorize?${params}`

    // 摘要日志，不落 verifier
    logger.info('starting org login, opening system browser')
    await shell.openExternal(authorizationUrl)
    return { authorizationUrl }
  }

  /** ProtocolService case 'auth' 转发进来 */
  async handleAuthCallback(url: URL): Promise<void> {
    const params = new URLSearchParams(url.search)
    const code = params.get('code')
    const state = params.get('state')
    if (!code || !state) {
      logger.warn('org auth callback missing code/state')
      return
    }

    const pending = this.pending
    if (!pending || pending.state !== state) {
      logger.warn('org auth callback state mismatch or expired')
      this.pending = null
      this.emitStatus()
      return
    }
    if (Date.now() - pending.createdAt > PENDING_TTL_MS) {
      logger.warn('org auth pending expired')
      this.pending = null
      this.emitStatus()
      return
    }

    try {
      const res = await fetch(`${ORG_BASE_URL}/api/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: pending.codeVerifier,
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI
        })
      })
      if (!res.ok) throw new Error(`token exchange failed (${res.status})`)
      const data = (await res.json()) as {
        access_token: string
        refresh_token: string
        expires_in: number
        user: { id: string; phone: string; role: string }
      }

      this.session = {
        userId: data.user.id,
        phone: data.user.phone,
        role: data.user.role,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + data.expires_in * 1000
      }
      this.credentialStore.save(this.session)
      this.pending = null
      // [enterprise] C3：重新登录成功 → 恢复 org 资源可用标记
      orgStateStore.markAvailable()
      logger.info('org login succeeded', { phone: this.session.phone, role: this.session.role })
      this.emitStatus()
    } catch (error) {
      logger.error('org auth callback failed', error as Error)
      this.pending = null
      this.emitStatus()
      throw error
    }
  }

  /** 退出登录：清内存 + 清文件（T0 不调服务端 revoke，refresh 14 天自然过期） */
  logout(): void {
    this.session = null
    this.pending = null
    this.credentialStore.clear()
    // [enterprise] C3：登出 → org 技能/连接器标记"组织不可用"（保留本地文件，重登恢复）
    orgStateStore.markUnavailable()
    logger.info('org logout')
    this.emitStatus()
  }

  /** 供 HTTP 客户端取有效 access token；过期自动刷新 */
  async getValidSession(): Promise<OrgSession | null> {
    if (!this.session) return null
    if (Date.now() < this.session.expiresAt - TOKEN_EXPIRY_MARGIN_MS) return this.session
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
    try {
      const res = await fetch(`${ORG_BASE_URL}/api/auth/token/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken })
      })
      if (!res.ok) throw new Error(`refresh failed (${res.status})`)
      const data = (await res.json()) as { accessToken: string; refreshToken: string }
      // 轮换语义：服务端已作废旧 refresh，必须一并替换
      this.session = {
        ...current,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken
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
