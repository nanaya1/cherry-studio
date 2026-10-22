import { createHash, randomBytes } from 'node:crypto'

// import { session as electronSession, shell } from 'electron'
import { shell } from 'electron'

import { application } from '@application'
import { loggerService } from '@logger'
import {
  getProfileLaunchContext,
  // resolveAuthSessionPath,
  clearAllowedCookies,
  profileSwitchFence,
  profileBusinessAccessGate,
  ProfileAuthEpoch,
  type ProfileRecordV1,
  type ProfileSessionService
} from '@main/core/profiles'
import { runAuthSessionOperation, getProfileAuthSession } from '@main/core/profiles'

import { OrgApiClient, ORG_AUTH_MODE, OFFICIAL_API_BASE_URL, ORG_SERVER_BASE_URL } from './OrgApiClient'
import type { OrgCredentialStore, OrgSession } from './OrgCredentialStore'
import { createStartupCurrentUserTransport } from './orgCurrentUserTransport'
import { orgStateStore } from './OrgStateStore'
import { ProfileAuthBroker, type CompletedAuthentication } from './ProfileAuthBroker'
import { parseOrgAuthCallback, type OrgAuthPhase } from './types'

const logger = loggerService.withContext('OrgAuthManager')
const OFFICIAL_LOGIN_URL = import.meta.env.MAIN_VITE_OFFICIAL_LOGIN_URL?.trim() || 'https://mro.xuelangyun.com/login'
const CLIENT_ID = 'cherry-desktop'
// const REDIRECT_URI = 'meacowork://auth/callback'
const REDIRECT_URI = 'meacowork-enterprise://auth/callback'
const PENDING_TTL_MS = 10 * 60 * 1000
const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000

class SessionRefreshError extends Error {
  constructor(
    message: string,
    readonly authenticationInvalid: boolean
  ) {
    super(message)
    this.name = 'SessionRefreshError'
  }
}

interface PendingAuth {
  state?: string
  codeVerifier?: string
  createdAt: number
  generation: number
}

export interface OrgAuthManagerDependencies {
  credentialStore: OrgCredentialStore
  currentProfile?: () => Promise<ProfileRecordV1>
  profileSession?: ProfileSessionService
  fence?: Pick<typeof profileSwitchFence, 'assertTaskStartAllowed' | 'assertWritable'>
}

export class OrgAuthManager {
  private session: OrgSession | null = null
  private pending: PendingAuth | null = null
  private refreshing: Promise<void> | null = null
  private credentialMutation: Promise<unknown> = Promise.resolve()
  private switching = false
  private generation = 0
  private readonly epoch = new ProfileAuthEpoch()
  readonly apiClient: OrgApiClient
  private readonly broker: ProfileAuthBroker

  constructor(private readonly dependencies?: OrgAuthManagerDependencies) {
    // this.apiClient = new OrgApiClient(() => this.getValidSession())
    this.apiClient = new OrgApiClient(
      () => this.getValidSession(),
      (url, init) => {
        const context = getProfileLaunchContext()
        if (!context || context.kind !== 'authenticated') throw new Error('No authenticated cookie profile')
        return getProfileAuthSession(context.profileRoot).fetch(url, init)
      }
    )
    this.broker = new ProfileAuthBroker(this.apiClient, ORG_SERVER_BASE_URL ?? 'management')
  }

  async initialize(): Promise<void> {
    if (!this.dependencies) return
    const snapshot = this.epoch.snapshot()
    // await this.dependencies.credentialStore.discardQuarantined()
    await this.mutateCredentials(() => this.dependencies!.credentialStore.discardQuarantined())
    this.epoch.assertCurrent(snapshot)
    let stored = await this.dependencies.credentialStore.load()
    this.epoch.assertCurrent(snapshot)
    if (!stored && this.dependencies.currentProfile) {
      const profile = await this.dependencies.currentProfile()
      this.epoch.assertCurrent(snapshot)
      // stored = await this.dependencies.credentialStore.migrateLegacy(profile)
      stored = await this.mutateCredentials(() => this.dependencies!.credentialStore.migrateLegacy(profile))
      this.epoch.assertCurrent(snapshot)
    }
    if (!stored) return
    // const expectedOrigin = ORG_AUTH_MODE === 'official-direct' ? OFFICIAL_API_BASE_URL : ORG_SERVER_BASE_URL
    const expectedOrigin =
      stored.authMode === 'management-cookie'
        ? ORG_SERVER_BASE_URL
        : ORG_AUTH_MODE === 'official-direct'
          ? OFFICIAL_API_BASE_URL
          : ORG_SERVER_BASE_URL
    // if (stored.authMode !== ORG_AUTH_MODE || stored.authOrigin !== expectedOrigin) {
    if (
      (stored.authMode !== ORG_AUTH_MODE && stored.authMode !== 'management-cookie') ||
      stored.authOrigin !== expectedOrigin
    ) {
      // await this.dependencies.credentialStore.clear()
      await this.mutateCredentials(() => this.dependencies!.credentialStore.clear())
      return
    }
    this.session = stored
    await this.revalidateAuthority()
  }

  getPhase(): OrgAuthPhase {
    if (this.switching) return 'switching'
    if (this.pending) return 'authorizing'
    return this.session ? 'signed-in' : 'signed-out'
  }

  getStatus() {
    return {
      phase: this.getPhase(),
      generation: this.generation,
      authMode: ORG_AUTH_MODE,
      groupId: this.session?.groupId ?? null,
      displayName: this.session?.displayName ?? null,
      phone: this.session?.phone ?? null,
      role: this.session?.role ?? null
    }
  }

  async startLogin(): Promise<{ authorizationUrl: string }> {
    if (this.dependencies?.profileSession && this.switching) throw new Error('Profile transition requires restart')
    // profileSwitchFence.assertTaskStartAllowed()
    ;(this.dependencies?.fence ?? profileSwitchFence).assertTaskStartAllowed()
    let authorizationUrl = OFFICIAL_LOGIN_URL
    const generation = ++this.generation
    this.epoch.advanceAuth()
    this.broker.invalidate()
    let pending: PendingAuth
    if (ORG_AUTH_MODE === 'management-oauth') {
      const state = randomBytes(16).toString('base64url')
      const codeVerifier = randomBytes(32).toString('base64url')
      const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
      })
      pending = { state, codeVerifier, createdAt: Date.now(), generation }
      authorizationUrl = `${this.requireManagementBaseUrl()}/authorize?${params}`
    } else {
      pending = { createdAt: Date.now(), generation }
    }
    this.pending = pending
    this.emitStatus()
    try {
      await shell.openExternal(authorizationUrl)
      return { authorizationUrl }
    } catch (error) {
      if (this.pending === pending) this.pending = null
      this.emitStatus()
      throw error
    }
  }

  async handleAuthCallback(url: URL): Promise<void> {
    const callback = parseOrgAuthCallback(url)
    const pending = this.pending
    if (!callback || !pending || Date.now() - pending.createdAt > PENDING_TTL_MS) {
      this.pending = null
      this.emitStatus()
      return
    }
    if (pending.generation !== this.generation) return
    if (
      (ORG_AUTH_MODE === 'management-oauth' && (!('code' in callback) || callback.state !== pending.state)) ||
      (ORG_AUTH_MODE !== 'management-oauth' && !('token' in callback))
    ) {
      return
    }

    try {
      const completed = await this.exchangeAndValidate(callback, pending)
      if (pending.generation !== this.generation) throw new Error('stale authentication response')
      // profileSwitchFence.assertWritable()
      ;(this.dependencies?.fence ?? profileSwitchFence).assertWritable()
      this.pending = null
      this.switching = true
      if (this.dependencies?.profileSession) {
        const result = await this.dependencies.profileSession.completeAuthentication(completed)
        // relaunching (process restart) and activated (same-process business
        // start) are both successful transitions; anything else is a failure.
        if (result.kind !== 'relaunching' && result.kind !== 'activated') {
          throw new Error(`profile switch failed: ${result.kind}`)
        }
        this.switching = false
        this.emitStatus()
      } else if (this.dependencies) {
        // await this.dependencies.credentialStore.save(completed.session)
        await this.mutateCredentials(() => this.dependencies!.credentialStore.save(completed.session))
        this.session = completed.session
      } else {
        this.session = completed.session
      }
      if (!this.dependencies?.profileSession) {
        this.switching = false
        this.emitStatus()
      }
    } catch (error) {
      // 旧回调不能清理后来发起的登录。
      if (pending.generation !== this.generation) throw error
      this.session = null
      this.pending = null
      this.switching = false
      this.emitStatus()
      throw error
    }
  }

  async logout(): Promise<{ state: 'switching' | 'signed-out'; revocationWarning: string | null }> {
    const current = this.session
    ++this.generation
    this.epoch.advanceAuth()
    this.broker.invalidate()
    this.pending = null
    const snapshot = this.epoch.snapshot()
    await this.dependencies?.profileSession?.beginLogout()
    if (this.dependencies?.profileSession) this.switching = true
    profileBusinessAccessGate.recordVerificationFailure('Logout requested')
    this.session = null
    let revocationWarning: string | null = null
    if (current?.accountKind === 'management' && current.refreshToken) {
      try {
        await this.apiClient.revoke(current.refreshToken, current)
      } catch (error) {
        revocationWarning = error instanceof Error ? error.message : String(error)
      }
    }
    if (current?.authMode === 'management-cookie') {
      const context = getProfileLaunchContext()
      if (!context || !ORG_SERVER_BASE_URL) throw new Error('Cookie logout context is missing')
      try {
        await this.apiClient.revoke('', current)
      } catch {
        revocationWarning = 'Remote cookie logout failed'
      }
      try {
        await runAuthSessionOperation({
          operation: 'replace',
          profileRoot: context.profileRoot,
          baseUrl: ORG_SERVER_BASE_URL,
          cookies: []
        })
        await clearAllowedCookies(getProfileAuthSession(context.profileRoot), ORG_SERVER_BASE_URL, ['sid'])
      } catch {
        revocationWarning = 'Local cookie cleanup failed; restart is required'
      }
    }
    await this.credentialMutation
    this.epoch.assertCurrent(snapshot)
    this.session = null
    if (this.dependencies?.profileSession) {
      this.switching = true
      const result = await this.dependencies.profileSession.logout()
      if (result.kind === 'relaunching' || result.kind === 'signed-out')
        return { state: 'switching', revocationWarning }
      // Keep the transition closed until the durable logout is recovered on restart.
      // this.session = current; this.switching = false
      this.emitStatus()
      throw new Error(`profile logout failed: ${result.kind}`)
    }
    // await this.dependencies?.credentialStore.clear()
    await this.mutateCredentials(async () => this.dependencies?.credentialStore.clear())
    this.switching = false
    this.emitStatus()
    return { state: 'signed-out', revocationWarning }
  }

  async getValidSession(): Promise<OrgSession | null> {
    if (!this.session) return null
    if (
      this.session.authMode !== 'official-direct' &&
      this.session.authMode !== 'management-cookie' &&
      Date.now() >= this.session.expiresAt - TOKEN_EXPIRY_MARGIN_MS
    ) {
      await this.refreshSession()
    }
    return this.session
  }

  async verifyOnlineAuthority(): Promise<void> {
    const snapshot = this.epoch.snapshot()
    const current = await this.getValidSession()
    this.epoch.assertCurrent(snapshot)
    if (!current || current.accountKind !== 'management') throw new Error('Management session is unavailable')
    const context = getProfileLaunchContext()
    const transport = createStartupCurrentUserTransport(current, {
      electronSession:
        current.authMode === 'management-cookie' && context ? getProfileAuthSession(context.profileRoot) : undefined
    })
    const broker = new ProfileAuthBroker(transport, current.authOrigin)
    const completed = await broker.revalidateManagement(
      current.authMode as 'management-exchange' | 'management-oauth' | 'management-cookie',
      current
    )
    this.epoch.assertCurrent(snapshot)
    if (completed.session.userId !== current.userId || completed.session.issuerId !== current.issuerId) {
      throw new Error('Runtime identity changed; explicit login is required')
    }
    if (
      completed.session.groupId !== current.groupId ||
      completed.session.role !== current.role ||
      completed.session.status !== current.status
    ) {
      throw new Error('Runtime authorization changed; restart is required')
    }
  }

  async revalidateAuthority(): Promise<void> {
    const current = this.session
    if (!current || current.accountKind !== 'management') return
    const snapshot = this.epoch.snapshot()
    const completed = await this.broker.revalidateManagement(
      current.authMode as 'management-exchange' | 'management-oauth' | 'management-cookie',
      current
    )
    this.epoch.assertCurrent(snapshot)
    const userChanged = completed.session.userId !== current.userId || completed.session.issuerId !== current.issuerId
    const authorizationChanged =
      completed.session.groupId !== current.groupId ||
      completed.session.role !== current.role ||
      completed.session.status !== current.status
    if ((userChanged || authorizationChanged) && getProfileLaunchContext()?.mode === 'business') {
      profileBusinessAccessGate.recordVerificationFailure('Runtime identity or authorization changed')
      throw new Error('Runtime identity or authorization changed; restart is required')
    }
    if (userChanged && this.dependencies?.profileSession) {
      this.switching = true
      const result = await this.dependencies.profileSession.completeAuthentication(completed)
      if (result.kind !== 'relaunching' && result.kind !== 'activated') {
        this.switching = false
        throw new Error(`profile switch failed: ${result.kind}`)
      }
      return
    }
    if (authorizationChanged) {
      ++this.generation
      orgStateStore.invalidateEntitlements(this.generation)
      await application.get('McpRuntimeService').stopUnauthorizedOrgConnectors()
      this.epoch.assertCurrent(snapshot)
      await this.dependencies?.profileSession?.updateAuthorizationContext(
        completed.identity,
        completed.authorizationContext
      )
    }
    this.epoch.assertCurrent(snapshot)
    this.session = completed.session
    // await this.dependencies?.credentialStore.save(completed.session)
    await this.mutateCredentials(async () => this.dependencies?.credentialStore.save(completed.session))
  }

  acquireLease(): { generation: number; issuerId: string; groupId: string | null; userId: string } {
    if (!this.session || this.switching) throw new Error('enterprise session is unavailable')
    return {
      generation: this.generation,
      issuerId: this.session.issuerId,
      groupId: this.session.groupId,
      userId: this.session.userId
    }
  }

  assertLease(lease: ReturnType<OrgAuthManager['acquireLease']>): void {
    const current = this.acquireLease()
    if (
      current.generation !== lease.generation ||
      current.issuerId !== lease.issuerId ||
      current.groupId !== lease.groupId ||
      current.userId !== lease.userId
    ) {
      throw new Error('enterprise authorization lease is stale')
    }
  }

  private async exchangeAndValidate(
    callback: NonNullable<ReturnType<typeof parseOrgAuthCallback>>,
    pending: PendingAuth
  ): Promise<CompletedAuthentication> {
    const snapshot = this.epoch.snapshot()
    if (ORG_AUTH_MODE === 'official-direct') {
      if (!('token' in callback)) throw new Error('official auth callback is invalid')
      return this.exchangeOfficialToken(callback.token)
    }
    const baseUrl = this.requireManagementBaseUrl()
    if (ORG_AUTH_MODE === 'management-exchange') {
      if (!('token' in callback)) throw new Error('official auth callback is invalid')
      const response = await fetch(`${baseUrl}/api/auth/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ officialToken: callback.token })
      })
      if (!response.ok) throw new Error(`org auth exchange failed (${response.status})`)
      const data = (await response.json()) as {
        accessToken: string
        refreshToken: string
        expiresIn: number
        user: { id: number | string }
      }
      this.epoch.assertCurrent(snapshot)
      const tokenSubject = String(data.user.id)
      // 原调用直接传 data.user.id；modern 返回 SQLite 数字主键，内部 session 统一使用字符串。
      this.session = this.provisionalManagementSession('management-exchange', tokenSubject, {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresAt: Date.now() + data.expiresIn * 1000
      })
      return this.broker.completeManagement('management-exchange', this.session, tokenSubject, this.broker.generation)
    }
    if (!('code' in callback) || !pending.state || !pending.codeVerifier || callback.state !== pending.state) {
      throw new Error('org auth callback state mismatch or expired')
    }
    const response = await fetch(`${baseUrl}/api/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: callback.code,
        code_verifier: pending.codeVerifier,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI
      })
    })
    if (!response.ok) throw new Error(`token exchange failed (${response.status})`)
    const data = (await response.json()) as {
      access_token: string
      refresh_token: string
      expires_in: number
      user: { id: number | string }
    }
    this.epoch.assertCurrent(snapshot)
    const tokenSubject = String(data.user.id)
    // 原调用直接传 data.user.id；modern 返回 SQLite 数字主键，内部 session 统一使用字符串。
    this.session = this.provisionalManagementSession('management-oauth', tokenSubject, {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000
    })
    return this.broker.completeManagement('management-oauth', this.session, tokenSubject, this.broker.generation)
  }

  private async exchangeOfficialToken(token: string): Promise<CompletedAuthentication> {
    const response = await fetch(`${OFFICIAL_API_BASE_URL}/xlyApi/business/user/userInfo`, {
      headers: { authorization: `Bearer ${token}` }
    })
    if (!response.ok) throw new Error(`official userInfo failed (${response.status})`)
    const body = (await response.json()) as {
      code?: number
      data?: {
        userId?: number | string
        userCode?: string | null
        userNickname?: string | null
        userPhone?: string | null
      } | null
    }
    if (body.code !== 200 || body.data?.userId == null) throw new Error('official userInfo invalid')
    return this.broker.completeOfficial({
      issuerId: OFFICIAL_API_BASE_URL,
      userId: String(body.data.userId),
      accessToken: token,
      displayName: body.data.userNickname?.trim() || body.data.userCode?.trim() || null,
      phone: body.data.userPhone ?? ''
    })
  }

  private provisionalManagementSession(
    authMode: 'management-exchange' | 'management-oauth',
    userId: string,
    tokens: Pick<OrgSession, 'accessToken' | 'refreshToken' | 'expiresAt'>
  ): OrgSession {
    return {
      authMode,
      accountKind: 'management',
      issuerId: ORG_SERVER_BASE_URL ?? '',
      authOrigin: ORG_SERVER_BASE_URL ?? '',
      userId,
      officialUserId: '',
      groupId: null,
      displayName: null,
      phone: '',
      role: '',
      status: '',
      ...tokens
    }
  }

  private async refreshSession(): Promise<void> {
    this.refreshing ||= this.doRefresh().finally(() => (this.refreshing = null))
    return this.refreshing
  }

  private async doRefresh(): Promise<void> {
    const current = this.session
    if (!current || current.authMode === 'official-direct') return
    const snapshot = this.epoch.snapshot()
    try {
      const response = await fetch(`${this.requireManagementBaseUrl()}/api/auth/token/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken })
      })
      if (!response.ok) {
        throw new SessionRefreshError(`refresh failed (${response.status})`, response.status === 401)
      }
      const data = (await response.json()) as { accessToken: string; refreshToken: string; expiresIn: number }
      this.epoch.assertCurrent(snapshot)
      this.session = {
        ...current,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresAt: Date.now() + data.expiresIn * 1000
      }
      await this.revalidateAuthority()
    } catch (error) {
      try {
        this.epoch.assertCurrent(snapshot)
      } catch {
        return
      }
      const authenticationInvalid =
        error instanceof SessionRefreshError
          ? error.authenticationInvalid
          : error instanceof Error && /(?:401|invalid.*(?:token|credential)|token.*(?:revok|invalid)|revok)/i.test(error.message)
      if (!authenticationInvalid) {
        logger.warn('org session refresh unavailable; retaining local session', { error: String(error) })
        this.emitStatus()
        return
      }
      logger.warn('org session refresh failed, signing out locally', { error: String(error) })
      await this.logout()
    }
  }

  private mutateCredentials<T>(operation: () => Promise<T>): Promise<T> {
    const snapshot = this.epoch.snapshot()
    const result = this.credentialMutation.then(async () => {
      this.epoch.assertCurrent(snapshot)
      const value = await operation()
      this.epoch.assertCurrent(snapshot)
      return value
    })
    this.credentialMutation = result.catch(() => undefined)
    return result
  }

  private requireManagementBaseUrl(): string {
    if (!ORG_SERVER_BASE_URL) throw new Error('management server URL is not configured')
    return ORG_SERVER_BASE_URL
  }

  private emitStatus(): void {
    try {
      application.get('IpcApiService').broadcast('enterprise.status_changed', this.getStatus())
    } catch (error) {
      logger.warn('failed to broadcast org status', { error: String(error) })
    }
  }
}
