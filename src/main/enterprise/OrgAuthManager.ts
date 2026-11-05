// import { createHash } from 'node:crypto'
import { randomBytes } from 'node:crypto'

// import { session as electronSession, shell } from 'electron'
// import { shell } from 'electron'

import { application } from '@application'
import { loggerService } from '@logger'
// import { orgStateStore } from './OrgStateStore'
import { Emitter, type Disposable } from '@main/core/lifecycle'
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

// import { OrgApiClient, ORG_AUTH_MODE, OFFICIAL_API_BASE_URL, ORG_SERVER_BASE_URL } from './OrgApiClient'
import { OrgApiClient, ORG_AUTH_MODE, ORG_SERVER_BASE_URL } from './OrgApiClient'
import type { OrgCredentialStore, OrgSession } from './OrgCredentialStore'
import { JavaAuthClient } from './JavaAuthClient'
import { createStartupCurrentUserTransport } from './orgCurrentUserTransport'
// import { orgStateStore } from './OrgStateStore'
import { ProfileAuthBroker } from './ProfileAuthBroker'
// import { parseOrgAuthCallback, type OrgAuthPhase } from './types'
import type { OrgAuthPhase } from './types'
import {
  VerificationError,
  // verificationHttpError,
  isDefinitiveVerificationError,
  type VerificationReason
} from './verification'

const logger = loggerService.withContext('OrgAuthManager')
// const OFFICIAL_LOGIN_URL = import.meta.env.MAIN_VITE_OFFICIAL_LOGIN_URL?.trim() || 'https://mro.xuelangyun.com/login'
// const CLIENT_ID = 'meacowork-desktop'
// const REDIRECT_URI = 'meacowork://auth/callback'
// const PENDING_TTL_MS = 10 * 60 * 1000
const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000

// MEA:profile-verification-network-tolerance Only structured, authoritative evidence may invalidate an account.
/*
class SessionRefreshError extends Error {
  constructor(
    message: string,
    readonly authenticationInvalid: boolean
  ) {
    super(message)
    this.name = 'SessionRefreshError'
  }
}
*/

export interface OrgVerificationStatus {
  owner: string
  revision: number
  state: 'unknown' | 'verified' | 'unavailable' | 'blocked' | 'switching'
  reason?: VerificationReason
}

type LogoutResult = { state: 'switching' | 'signed-out'; revocationWarning: string | null }

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
  onLogoutFailure?: (stage: string) => void
  fence?: Pick<typeof profileSwitchFence, 'assertTaskStartAllowed' | 'assertWritable'>
}

export class OrgAuthManager {
  private session: OrgSession | null = null
  private pending: PendingAuth | null = null
  // private refreshing: Promise<void> | null = null
  private verifying: Promise<void> | null = null
  private logoutTask: Promise<LogoutResult> | null = null
  private credentialVersion = 0
  private disposed = false
  private readonly requests = new AbortController()
  private readonly verificationChanged = new Emitter<OrgVerificationStatus>()
  private readonly authorizationChanged = new Emitter<void>()
  private verificationStatus: OrgVerificationStatus = {
    owner: `${getProfileLaunchContext()?.profileId ?? 'unscoped'}:${randomBytes(16).toString('hex')}`,
    revision: 0,
    state: 'unknown'
  }
  private credentialMutation: Promise<unknown> = Promise.resolve()
  private switching = false
  private generation = 0
  private readonly epoch = new ProfileAuthEpoch()
  private readonly gate = profileBusinessAccessGate
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
      },
      () => {
        ++this.generation
        this.epoch.advanceAuth()
        profileBusinessAccessGate.recordVerificationFailure('企业会话已失效，请重新登录')
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
    if (stored.authMode !== 'management-java') return
    // const expectedOrigin = ORG_AUTH_MODE === 'official-direct' ? OFFICIAL_API_BASE_URL : ORG_SERVER_BASE_URL
    /* const expectedOrigin =
      stored.authMode === 'management-cookie'
        ? ORG_SERVER_BASE_URL
        : ORG_AUTH_MODE === 'official-direct'
          ? OFFICIAL_API_BASE_URL
          : ORG_SERVER_BASE_URL */
    // if (stored.authMode !== ORG_AUTH_MODE || stored.authOrigin !== expectedOrigin) {
    // 原模式选择保留：历史会话不再放行。
    // if ((stored.authMode !== ORG_AUTH_MODE && stored.authMode !== 'management-cookie') || stored.authOrigin !== expectedOrigin) {
    if (stored.authOrigin !== ORG_SERVER_BASE_URL) {
      // await this.dependencies.credentialStore.clear()
      await this.mutateCredentials(() => this.dependencies!.credentialStore.clear())
      return
    }
    this.session = stored
    ++this.credentialVersion
    // await this.revalidateAuthority()
    try {
      await this.retryVerification()
    } catch (error) {
      if (this.disposed || this.switching) throw error
      // if (isDefinitiveVerificationError(error) || !this.gate.isAllowed()) throw error
      // MEA:profile-online-login Keep the host control plane alive to present blocked or unavailable verification state.
      logger.warn('startup recheck did not verify authority', { state: this.verificationStatus.state })
    }
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

  getVerificationStatus(): OrgVerificationStatus {
    return { ...this.verificationStatus }
  }

  onVerificationChanged(listener: (status: OrgVerificationStatus) => void): Disposable {
    return this.verificationChanged.event(listener)
  }

  onAuthorizationChanged(listener: () => void): Disposable {
    return this.authorizationChanged.event(listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.epoch.advanceAuth()
    this.broker.invalidate()
    this.requests.abort()
    this.verificationChanged.dispose()
    this.authorizationChanged.dispose()
  }

  async startLogin(): Promise<{ authorizationUrl: string }> {
    // if (this.dependencies?.profileSession && this.switching) throw new Error('Profile transition requires restart')
    if (this.switching) throw new Error('Profile transition requires restart')
    // profileSwitchFence.assertTaskStartAllowed()
    ;(this.dependencies?.fence ?? profileSwitchFence).assertTaskStartAllowed()
    throw new Error('浏览器登录已停用，请使用用户名和密码登录')
    /* let authorizationUrl = OFFICIAL_LOGIN_URL
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
    } */
  }

  async handleAuthCallback(url: URL): Promise<void> {
    // MEA:enterprise-java-auth 旧深链不得恢复任何会话。
    void url
    throw new Error('旧登录回调已停用，请使用用户名和密码登录')
    /* const callback = parseOrgAuthCallback(url)
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
        ++this.credentialVersion
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
    } */
  }

  // MEA:profile-verification-network-tolerance The user logout owns one synchronous fence and one durable transition.
  /*
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
    if (current?.authMode === 'management-java') {
      try {
        await this.apiClient.revoke('', current)
      } catch {
        revocationWarning = '远端注销未确认，已退出本地账号'
      }
    }
    // if (current?.accountKind === 'management' && current.refreshToken) {
    if (current?.authMode !== 'management-java' && current?.accountKind === 'management' && current.refreshToken) {
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

  */
  logout(): Promise<LogoutResult> {
    if (this.logoutTask) return this.logoutTask
    const current = this.session ? { ...this.session } : null
    const context = getProfileLaunchContext()
    this.switching = true
    ++this.generation
    ++this.credentialVersion
    this.epoch.advanceAuth()
    this.broker.invalidate()
    this.pending = null
    this.session = null
    const operation = Promise.resolve().then(() => this.finishLogout(current, context))
    this.logoutTask = operation
    this.gate.recordVerificationFailure('Logout requested')
    application.beginProfileLogout()
    this.setVerificationStatus('switching')
    void operation
      .finally(() => {
        if (!this.dependencies?.profileSession && !this.switching) this.logoutTask = null
      })
      .catch(() => undefined)
    return operation
  }

  private async finishLogout(
    current: OrgSession | null,
    context: ReturnType<typeof getProfileLaunchContext>
  ): Promise<LogoutResult> {
    let stage = 'logout-intent'
    let revocationWarning: string | null = null
    try {
      await this.dependencies?.profileSession?.beginLogout()
      stage = 'logout-credential-queue'
      await this.credentialMutation
      if (current?.authMode === 'management-java') {
        stage = 'logout-java-revocation'
        try {
          const revoked = await new JavaAuthClient({ baseUrl: current.authOrigin }).logout(current.accessToken)
          if (!revoked) revocationWarning = '远端注销未确认，已退出本地账号'
        } catch (error) {
          revocationWarning = error instanceof Error ? error.message : '远端注销未确认，已退出本地账号'
        }
      } else if (current?.authMode === 'management-cookie') {
        stage = 'logout-cookie-cleanup'
        if (!context || !ORG_SERVER_BASE_URL) throw new Error('Cookie logout context is missing')
        // Cookie revocation finishes before local cleanup or a new login can own this partition.
        revocationWarning = await this.revokeSnapshot(current, context)
        await runAuthSessionOperation({
          operation: 'replace',
          profileRoot: context.profileRoot,
          baseUrl: ORG_SERVER_BASE_URL,
          cookies: []
        })
        await clearAllowedCookies(getProfileAuthSession(context.profileRoot), ORG_SERVER_BASE_URL, ['sid'])
      } else if (current?.accountKind === 'management' && current.refreshToken) {
        revocationWarning = await this.revokeSnapshot(current, context)
      }
      if (!this.dependencies?.profileSession) {
        stage = 'logout-credential-clear'
        await this.mutateCredentials(async () => this.dependencies?.credentialStore.clear())
      }
    } catch (error) {
      this.dependencies?.onLogoutFailure?.(stage)
      throw error
    }
    if (this.dependencies?.profileSession) {
      const result = await this.dependencies.profileSession.logout()
      if (result.kind !== 'relaunching' && result.kind !== 'signed-out') {
        this.emitStatus()
        throw new Error(`profile logout failed: ${result.kind}`)
      }
      return { state: 'switching', revocationWarning }
    }
    // await this.mutateCredentials(async () => this.dependencies?.credentialStore.clear())
    this.switching = false
    this.emitStatus()
    return { state: 'signed-out', revocationWarning }
  }

  private async revokeSnapshot(
    current: OrgSession,
    context: ReturnType<typeof getProfileLaunchContext>
  ): Promise<string | null> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (current.authMode === 'management-java') return null
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('Remote logout timed out'))
        }, 10_000)
      })
      const revoke =
        current.authMode === 'management-cookie'
          ? (async () => {
              const cookies = await getProfileAuthSession(context!.profileRoot).cookies.get({ url: current.authOrigin })
              if (controller.signal.aborted) return
              const cookie = cookies
                .filter((item) => item.name === 'sid')
                .map((item) => `${item.name}=${item.value}`)
                .join('; ')
              // MEA:profile-online-login A snapshot request cannot accept Set-Cookie into a newer login's cookie jar.
              const response = await fetch(`${current.authOrigin}/api/auth/logout`, {
                method: 'POST',
                credentials: 'omit',
                redirect: 'error',
                signal: controller.signal,
                headers: { 'content-type': 'application/json', cookie },
                body: JSON.stringify({ refreshToken: '' })
              })
              if (!response.ok) throw new Error(`Remote cookie logout failed (${response.status})`)
            })()
          : this.apiClient.revoke(current.refreshToken, current)
      await Promise.race([revoke, timeout])
      return null
    } catch (error) {
      return error instanceof Error ? error.message : 'Remote logout failed'
    } finally {
      clearTimeout(timer)
    }
  }

  async getValidSession(): Promise<OrgSession | null> {
    if (!this.session || this.switching || this.disposed) return null
    const snapshot = this.epoch.snapshot()
    if (
      this.session.authMode !== 'management-java' &&
      this.session.authMode !== 'official-direct' &&
      this.session.authMode !== 'management-cookie' &&
      Date.now() >= this.session.expiresAt - TOKEN_EXPIRY_MARGIN_MS
    ) {
      try {
        // Java Sa-Token 会话由在线 /me 校验续活，不执行旧 refresh-token 流程。
        await this.retryVerification()
      } catch (error) {
        try {
          this.epoch.assertCurrent(snapshot)
        } catch {
          return null
        }
        if (!this.disposed && !this.switching) this.recordVerificationError(error)
      }
    }
    try {
      this.epoch.assertCurrent(snapshot)
    } catch {
      return null
    }
    return this.session
  }

  // MEA:profile-online-login Verification uses a credential snapshot, never an API getter that can recurse through refresh.
  /*
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
    if (current.authMode !== 'management-java' || !transport.getCurrentJavaProfile)
      throw new Error('旧会话需要重新登录')
    const completed = await broker.javaRevalidate(() => transport.getCurrentJavaProfile!(), current.accessToken)
    this.epoch.assertCurrent(snapshot)
    if (completed.session.userId !== current.userId || completed.session.issuerId !== current.issuerId) {
      ++this.generation
      this.epoch.advanceAuth()
      profileBusinessAccessGate.recordVerificationFailure('在线身份已变化')
      // throw new Error('Runtime identity changed; explicit login is required')
      throw new Error('在线身份已变化，请重新登录')
    }
    if (
      completed.session.groupId !== current.groupId ||
      completed.session.role !== current.role ||
      // completed.session.status !== current.status
      completed.session.tenantId !== current.tenantId
    ) {
      ++this.generation
      this.epoch.advanceAuth()
      profileBusinessAccessGate.recordVerificationFailure('企业授权已变化')
      // throw new Error('Runtime authorization changed; restart is required')
      throw new Error('企业授权已变化，请重新登录')
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
    if (current.authMode !== 'management-java') throw new Error('旧会话需要重新登录')
    const transport = createStartupCurrentUserTransport(current)
    const completed = await this.broker.javaRevalidate(() => transport.getCurrentJavaProfile!(), current.accessToken)
    this.epoch.assertCurrent(snapshot)
    const userChanged = completed.session.userId !== current.userId || completed.session.issuerId !== current.issuerId
    const authorizationChanged =
      completed.session.groupId !== current.groupId ||
      completed.session.role !== current.role ||
      // completed.session.status !== current.status
      completed.session.tenantId !== current.tenantId
    // if ((userChanged || authorizationChanged) && getProfileLaunchContext()?.mode === 'business') {
    if (userChanged || authorizationChanged) {
      ++this.generation
      this.epoch.advanceAuth()
      profileBusinessAccessGate.recordVerificationFailure('Runtime identity or authorization changed')
      throw new Error('Runtime identity or authorization changed; restart is required')
    }
    // if (userChanged && this.dependencies?.profileSession) {
    //   this.switching = true
    //   const result = await this.dependencies.profileSession.completeAuthentication(completed)
    //   if (result.kind !== 'relaunching' && result.kind !== 'activated') {
    //     this.switching = false
    //     throw new Error(`profile switch failed: ${result.kind}`)
    //   }
    //   return
    // }
    // if (authorizationChanged) {
    //   ++this.generation
    //   orgStateStore.invalidateEntitlements(this.generation)
    //   await application.get('McpRuntimeService').stopUnauthorizedOrgConnectors()
    //   this.epoch.assertCurrent(snapshot)
    //   await this.dependencies?.profileSession?.updateAuthorizationContext(
    //     completed.identity,
    //     completed.authorizationContext
    //   )
    // }
    this.epoch.assertCurrent(snapshot)
    this.session = completed.session
    // await this.dependencies?.credentialStore.save(completed.session)
    await this.mutateCredentials(async () => this.dependencies?.credentialStore.save(completed.session))
  }

  */
  verifyOnlineAuthority(): Promise<void> {
    return this.retryVerification()
  }

  revalidateAuthority(): Promise<void> {
    return this.retryVerification()
  }

  retryVerification(): Promise<void> {
    if (this.verifying) return this.verifying
    if (this.disposed || this.switching) return Promise.reject(new Error('Profile verification owner is stale'))
    if (this.verificationStatus.state === 'blocked') {
      return Promise.reject(
        new VerificationError('Explicit authentication is required', {
          stage: 'session',
          endpoint: '',
          kind: 'invalid',
          reason: this.verificationStatus.reason
        })
      )
    }
    const snapshot = this.epoch.snapshot()
    const operation = this.performVerification().catch((error: unknown) => {
      this.epoch.assertCurrent(snapshot)
      if (!this.disposed && !this.switching) this.recordVerificationError(error)
      throw error
    })
    this.verifying = operation
    void operation
      .finally(() => {
        if (this.verifying === operation) this.verifying = null
      })
      .catch(() => undefined)
    return operation
  }

  private async performVerification(): Promise<void> {
    const snapshot = this.epoch.snapshot()
    const current = this.session
    if (!current)
      throw new VerificationError('Management session is unavailable', {
        stage: 'session',
        endpoint: '',
        kind: 'uncertain'
      })
    if (current.accountKind !== 'management') return
    if (current.authMode !== 'management-java') {
      throw new VerificationError('旧会话需要重新输入用户名和密码', {
        stage: 'session',
        endpoint: '',
        kind: 'invalid',
        reason: 'credentials-invalid'
      })
    }
    const version = this.credentialVersion
    const transport = createStartupCurrentUserTransport({ ...current }, { baseUrl: current.authOrigin })
    if (!transport.getCurrentJavaProfile) {
      throw new VerificationError('缺少企业认证传输', {
        stage: 'session',
        endpoint: '',
        kind: 'uncertain'
      })
    }
    const broker = new ProfileAuthBroker(transport, current.authOrigin)
    const completed = await broker
      .javaRevalidate(transport.getCurrentJavaProfile, current.accessToken)
      .catch((error: unknown) => {
        this.epoch.assertCurrent(snapshot)
        if (version !== this.credentialVersion) {
          throw new VerificationError('Verification credential snapshot was superseded', {
            stage: 'session',
            endpoint: '',
            kind: 'uncertain'
          })
        }
        throw error
      })
    this.epoch.assertCurrent(snapshot)
    if (version !== this.credentialVersion)
      throw new VerificationError('Verification credential snapshot was superseded', {
        stage: 'session',
        endpoint: '',
        kind: 'uncertain'
      })
    if (completed.session.userId !== current.userId || completed.session.issuerId !== current.issuerId) {
      throw new VerificationError('Runtime identity changed; explicit login is required', {
        stage: 'identity',
        endpoint: `${current.authOrigin}/api/currentuser`,
        kind: 'invalid',
        reason: 'identity-changed'
      })
    }
    const authorizationChanged =
      completed.session.tenantId !== current.tenantId ||
      completed.session.groupId !== current.groupId ||
      completed.session.role !== current.role
    if (authorizationChanged) {
      throw new VerificationError('企业授权已变化，请重新登录', {
        stage: 'identity',
        endpoint: `${current.authOrigin}/api/v1/auth/me`,
        kind: 'invalid',
        reason: 'identity-changed'
      })
    }
    await this.mutateCredentials(async () => {
      this.epoch.assertCurrent(snapshot)
      if (version !== this.credentialVersion || !this.session) throw new Error('Credential version is stale')
      if (authorizationChanged) {
        await this.dependencies?.profileSession?.updateAuthorizationContext(
          completed.identity,
          completed.authorizationContext
        )
        this.epoch.assertCurrent(snapshot)
        if (version !== this.credentialVersion) throw new Error('Credential version is stale')
      }
      const updated = {
        ...this.session,
        groupId: completed.session.groupId,
        role: completed.session.role,
        displayName: completed.session.displayName,
        phone: completed.session.phone,
        officialUserId: completed.session.officialUserId
      }
      await this.dependencies?.credentialStore.save(updated)
      this.epoch.assertCurrent(snapshot)
      if (version !== this.credentialVersion) throw new Error('Credential version is stale')
      this.session = updated
      if (authorizationChanged) {
        ++this.generation
        this.authorizationChanged.fire()
        this.emitStatus()
      }
    })
    this.epoch.assertCurrent(snapshot)
    this.gate.recordVerificationSuccess()
    this.setVerificationStatus('verified')
  }

  private recordVerificationError(error: unknown): void {
    if (this.verificationStatus.state === 'blocked' || this.verificationStatus.state === 'switching') return
    if (isDefinitiveVerificationError(error)) {
      this.epoch.advanceAuth()
      this.broker.invalidate()
      this.gate.recordVerificationFailure(error.evidence.reason)
      this.setVerificationStatus('blocked', error.evidence.reason)
    } else {
      this.setVerificationStatus('unavailable')
    }
  }

  private setVerificationStatus(state: OrgVerificationStatus['state'], reason?: VerificationReason): void {
    if (this.disposed || (this.verificationStatus.state === state && this.verificationStatus.reason === reason)) return
    this.verificationStatus = {
      owner: this.verificationStatus.owner,
      revision: this.verificationStatus.revision + 1,
      state,
      ...(reason ? { reason } : {})
    }
    this.verificationChanged.fire(this.getVerificationStatus())
  }

  acquireLease(): { generation: number; issuerId: string; groupId: string | null; tenantId?: string; userId: string } {
    // if (!this.session || this.switching) throw new Error('enterprise session is unavailable')
    if (!this.session || this.switching || this.disposed || this.verificationStatus.state === 'blocked') {
      throw new Error('enterprise session is unavailable')
    }
    return {
      generation: this.generation,
      issuerId: this.session.issuerId,
      groupId: this.session.groupId,
      tenantId: this.session.tenantId,
      userId: this.session.userId
    }
  }

  assertLease(lease: ReturnType<OrgAuthManager['acquireLease']>): void {
    const current = this.acquireLease()
    if (
      current.generation !== lease.generation ||
      current.issuerId !== lease.issuerId ||
      current.groupId !== lease.groupId ||
      current.tenantId !== lease.tenantId ||
      current.userId !== lease.userId
    ) {
      throw new Error('enterprise authorization lease is stale')
    }
  }

  /* 原 OAuth 交换链路停用，保留以便回溯。
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

  // private refreshSession(): Promise<void> {
  //   if (this.refreshing) return this.refreshing
  //   const operation = this.doRefresh()
  //   this.refreshing = operation
  //   void operation
  //     .finally(() => {
  //       if (this.refreshing === operation) this.refreshing = null
  //     })
  //     .catch(() => undefined)
  //   return operation
  // }

  // MEA:profile-online-login Refresh must not call verification or logout, nor restore an older credential version.
  /*
  private async doRefresh(): Promise<void> {
    const current = this.session
    // if (!current || current.authMode === 'official-direct') return
    if (!current || current.authMode === 'official-direct' || current.authMode === 'management-java') return
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
          : error instanceof Error &&
            /(?:401|invalid.*(?:token|credential)|token.*(?:revok|invalid)|revok)/i.test(error.message)
      if (!authenticationInvalid) {
        logger.warn('org session refresh unavailable; retaining local session', { error: String(error) })
        this.emitStatus()
        return
      }
      logger.warn('org session refresh failed, signing out locally', { error: String(error) })
      await this.logout()
    }
  }

  */
  /* private async doRefresh(): Promise<void> {
    const current = this.session
    if (
      !current ||
      this.switching ||
      this.disposed ||
      current.authMode === 'official-direct' ||
      current.authMode === 'management-cookie'
    )
      return
    const snapshot = this.epoch.snapshot()
    const version = this.credentialVersion
    const endpoint = `${this.requireManagementBaseUrl()}/api/auth/token/refresh`
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
        signal: AbortSignal.any([this.requests.signal, AbortSignal.timeout(10_000)])
      })
    } catch {
      throw new VerificationError('Credential refresh network unavailable', {
        stage: 'refresh',
        endpoint,
        kind: 'unavailable'
      })
    }
    if (!response.ok) throw verificationHttpError('refresh', endpoint, response)
    let data: unknown
    try {
      data = await response.json()
    } catch {
      throw new VerificationError('Credential refresh response is not valid JSON', {
        stage: 'refresh',
        endpoint,
        kind: 'uncertain',
        httpStatus: response.status
      })
    }
    if (
      !data ||
      typeof data !== 'object' ||
      !('accessToken' in data) ||
      typeof data.accessToken !== 'string' ||
      !data.accessToken.trim() ||
      !('refreshToken' in data) ||
      typeof data.refreshToken !== 'string' ||
      !data.refreshToken.trim() ||
      !('expiresIn' in data) ||
      typeof data.expiresIn !== 'number' ||
      !Number.isFinite(data.expiresIn) ||
      data.expiresIn <= 0 ||
      !Number.isSafeInteger(Date.now() + data.expiresIn * 1000)
    ) {
      throw new VerificationError('Credential refresh response shape is invalid', {
        stage: 'refresh',
        endpoint,
        kind: 'uncertain',
        httpStatus: response.status
      })
    }
    const tokens = {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresAt: Date.now() + data.expiresIn * 1000
    }
    this.epoch.assertCurrent(snapshot)
    if (version !== this.credentialVersion) return
    await this.mutateCredentials(async () => {
      this.epoch.assertCurrent(snapshot)
      if (version !== this.credentialVersion || !this.session) return
      const updated = { ...this.session, ...tokens }
      await this.dependencies?.credentialStore.save(updated)
      this.epoch.assertCurrent(snapshot)
      if (version !== this.credentialVersion) return
      this.session = updated
      ++this.credentialVersion
    })
  } */

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

  // private requireManagementBaseUrl(): string {
  //   if (!ORG_SERVER_BASE_URL) throw new Error('management server URL is not configured')
  //   return ORG_SERVER_BASE_URL
  // }

  private emitStatus(): void {
    try {
      application.get('IpcApiService').broadcast('enterprise.status_changed', this.getStatus())
    } catch (error) {
      logger.warn('failed to broadcast org status', { error: String(error) })
    }
  }
}
