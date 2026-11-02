/**
 * [enterprise] T0 企业扩展 - 登录管理器
 * 定向恢复：管理端 PKCE OAuth。系统浏览器授权 + /api/token 换取，回调改走 meacowork://auth 深链
 * （由 ProtocolService case 'auth' 分发到 handleAuthCallback）。
 */
import { createHash, randomBytes } from 'node:crypto'

import { shell } from 'electron'

import { application } from '@application'
import { loggerService } from '@logger'

import { OrgApiClient, ORG_AUTH_MODE, ORG_SERVER_BASE_URL } from './OrgApiClient'
import { OrgCredentialStore, type OrgSession } from './OrgCredentialStore'
// import { orgStateStore } from './OrgStateStore' // [enterprise] copy 模式不再按登录态管理已安装资源
import { parseOrgAuthCallback, type OrgAuthPhase } from './types'

const logger = loggerService.withContext('OrgAuthManager')

const ORG_BASE_URL = ORG_SERVER_BASE_URL
// const CLIENT_ID = 'cherry-desktop' // [enterprise] 早期客户端标识已删除
// const CLIENT_ID = 'meacowork-desktop' // [enterprise] 中期企业版标识已替换
const CLIENT_ID = 'cn.xuelangyun.meacowork.desktop'
const REDIRECT_URI = 'meacowork://auth/sso/callback'

interface PendingAuth {
  state: string
  codeVerifier: string
  createdAt: number
  deadline: number
  authorizationUrl: string
  timer: ReturnType<typeof setTimeout> | null
  exchangeTimer: ReturnType<typeof setTimeout> | null
  exchangeDeadline: number | null
  controller: AbortController
  exchanging: boolean
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
  private loginError: 'timeout' | 'failed' | 'denied' | null = null

  // [enterprise] 修复 401：apiClient 改用 getValidSession（过期自动刷新）。
  // 原裸会话注入注释保留：apiClient = new OrgApiClient(() => this.session)
  apiClient = new OrgApiClient(() => this.getValidSession())

  constructor() {
    // 定向恢复：仅接受本端签发的 management-oauth 会话；旧官网/管理端-exchange 或 authOrigin
    // 不匹配一律忽略（不删凭据文件，旧无标记会话自然失效要求重新登录）。
    // 原构造（冷启动直接恢复任意持久化会话）：this.session = this.credentialStore.load()
    const loaded = this.credentialStore.load()
    this.session =
      loaded && loaded.authMode === 'management-oauth' && loaded.authOrigin === ORG_BASE_URL ? loaded : null
  }

  getPhase(): OrgAuthPhase {
    this.expirePending()
    if (this.pending) return 'authorizing'
    return this.session ? 'signed-in' : 'signed-out'
  }

  getStatus() {
    return {
      phase: this.getPhase(),
      authMode: ORG_AUTH_MODE,
      displayName: this.session?.displayName ?? null,
      phone: this.session?.phone ?? null,
      role: this.session?.role ?? null,
      loginAttemptId: this.pending?.state ?? null,
      loginStartedAt: this.pending?.createdAt ?? null,
      loginError: this.loginError
    }
  }

  /** 开始登录：生成 PKCE + 跳系统浏览器到管理端 /authorize */
  async startLogin(): Promise<{ authorizationUrl: string }> {
    this.expirePending()
    if (this.pending) return { authorizationUrl: this.pending.authorizationUrl }
    const state = randomBytes(16).toString('base64url')
    const codeVerifier = randomBytes(32).toString('base64url')
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')

    // this.pending = { state, codeVerifier, createdAt: Date.now() }
    // this.emitStatus()

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    })
    const authorizationUrl = `${ORG_BASE_URL}/authorize?${params}`

    // 摘要日志，不落 verifier
    logger.info('starting org login, opening system browser')
    const createdAt = Date.now()
    const pending: PendingAuth = {
      state,
      codeVerifier,
      createdAt,
      deadline: createdAt + PENDING_TTL_MS,
      authorizationUrl,
      timer: null,
      exchangeTimer: null,
      exchangeDeadline: null,
      controller: new AbortController(),
      exchanging: false
    }
    this.pending = pending
    this.loginError = null
    pending.timer = setTimeout(() => this.finishAttempt(pending, 'timeout'), PENDING_TTL_MS)
    pending.timer.unref()
    this.emitStatus()
    // await shell.openExternal(authorizationUrl)
    try {
      await shell.openExternal(authorizationUrl)
    } catch (error) {
      this.finishAttempt(pending, 'failed')
      throw error
    }
    return { authorizationUrl }
  }

  /** ProtocolService case 'auth' 转发进来 */
  async handleAuthCallback(url: URL): Promise<void> {
    const callback = parseOrgAuthCallback(url)
    if (!callback) {
      logger.warn('org auth callback rejected: not a PKCE code+state callback')
      return
    }
    // const { code, state } = callback
    const { state } = callback
    this.expirePending()
    const pending = this.pending
    if (!pending || pending.state !== state) {
      logger.warn('org auth callback state mismatch or expired')
      // this.pending = null
      // this.emitStatus()
      return
    }
    // if (Date.now() - pending.createdAt > PENDING_TTL_MS) { logger.warn('org auth pending expired')
    //   this.pending = null; this.emitStatus(); return }

    // MEA:enterprise-login 绝对截止时间统一由 expirePending 校验，旧回调不能结束新尝试。
    if (pending.exchanging) return
    if ('error' in callback) {
      this.finishAttempt(pending, callback.error === 'access_denied' ? 'denied' : 'failed')
      return
    }
    const { code } = callback
    pending.exchanging = true
    pending.exchangeDeadline = Date.now() + 30_000
    pending.exchangeTimer = setTimeout(() => this.finishAttempt(pending, 'timeout'), 30_000)
    pending.exchangeTimer.unref()
    const aborted = new Promise<never>((_, reject) => {
      pending.controller.signal.addEventListener('abort', () => reject(new Error('org login aborted')), { once: true })
    })
    try {
      // const res = await fetch(`${ORG_BASE_URL}/api/token`, {
      const res = await Promise.race([
        fetch(`${ORG_BASE_URL}/api/token`, {
          signal: pending.controller.signal,
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            code_verifier: pending.codeVerifier,
            client_id: CLIENT_ID,
            redirect_uri: REDIRECT_URI
          })
          // })
        }),
        aborted
      ])
      if (!res.ok) throw new Error(`token exchange failed (${res.status})`)
      // const data = (await res.json()) as {
      const data = (await Promise.race([res.json(), aborted])) as {
        access_token: string
        refresh_token: string
        expires_in: number
        user: {
          id: string | number
          username?: string | null
          displayName?: string | null
          phone?: string | null
          role?: string | null
        }
      }

      this.expirePending()
      if (this.pending !== pending || pending.controller.signal.aborted) return
      this.session = {
        authMode: 'management-oauth',
        authOrigin: ORG_BASE_URL,
        userId: String(data.user.id),
        officialUserId: '',
        displayName: data.user.displayName?.trim() || data.user.username?.trim() || null,
        phone: data.user.phone ?? '',
        role: data.user.role ?? '',
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + data.expires_in * 1000
      }
      this.credentialStore.save(this.session)
      // this.pending = null
      this.finishAttempt(pending, null)
      // [enterprise] copy 模式：已安装资源属于本地，登录只恢复组织目录访问。
      // orgStateStore.markAvailable()
      logger.info('org login succeeded', { phone: this.session.phone, role: this.session.role })
      this.emitStatus()
    } catch (error) {
      this.expirePending()
      if (this.pending !== pending || pending.controller.signal.aborted) return
      logger.error('org auth callback failed', error as Error)
      // this.pending = null
      // this.emitStatus()
      this.finishAttempt(pending, 'failed')
      throw error
    }
  }

  cancelLogin(attemptId: string): { ok: boolean } {
    this.expirePending()
    const pending = this.pending
    if (!pending || pending.state !== attemptId) return { ok: false }
    this.finishAttempt(pending, null)
    return { ok: true }
  }

  private expirePending(): void {
    const pending = this.pending
    if (
      pending &&
      (Date.now() >= pending.deadline || (pending.exchangeDeadline !== null && Date.now() >= pending.exchangeDeadline))
    ) {
      this.finishAttempt(pending, 'timeout')
    }
  }

  private finishAttempt(pending: PendingAuth, error: typeof this.loginError): void {
    if (this.pending !== pending) return
    this.pending = null
    this.loginError = error
    if (pending.timer) clearTimeout(pending.timer)
    if (pending.exchangeTimer) clearTimeout(pending.exchangeTimer)
    pending.controller.abort()
    this.emitStatus()
  }

  /** 退出登录：清内存 + 清文件（T0 不调服务端 revoke，refresh 14 天自然过期） */
  logout(): void {
    this.session = null
    // this.pending = null
    if (this.pending) this.finishAttempt(this.pending, null)
    this.loginError = null
    this.credentialStore.clear()
    // [enterprise] copy 模式：登出仅结束目录访问，已安装的本地副本继续可用。
    // orgStateStore.markUnavailable()
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
    if (!ORG_BASE_URL) throw new Error('management server URL is not configured')
    try {
      const res = await fetch(`${ORG_BASE_URL}/api/auth/token/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken })
      })
      if (!res.ok) throw new Error(`refresh failed (${res.status})`)
      const data = (await res.json()) as { accessToken: string; refreshToken: string; expiresIn: number }
      // MEA:enterprise-login 旧刷新不得在登出或换会话后写回凭据。
      if (this.session !== current) return
      // 轮换语义：服务端已作废旧 refresh，必须一并替换；保持现有 expiresIn 更新
      this.session = {
        ...current,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresAt: Date.now() + data.expiresIn * 1000
      }
      this.credentialStore.save(this.session)
    } catch (error) {
      if (this.session !== current) return
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
