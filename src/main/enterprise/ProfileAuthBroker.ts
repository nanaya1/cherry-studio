import {
  computeIdentityDigest,
  normalizeAuthenticatedSubject,
  type ProfileAuthorizationContext
} from '@main/core/profiles'

import { normalizeJavaMe } from './JavaAuthClient'
import type { OrgSession } from './OrgCredentialStore'
import type { JavaAuthProfile, JavaMeData, OrgAuthMode, OrgCurrentUser } from './types'

export interface ProfileAuthBrokerApi {
  // 原 getServerIdentity() 已停用：modern 的 /api/currentuser 同时返回 server_instance_id 与 user。
  getCurrentUser(): Promise<OrgCurrentUser>
}

interface TokenSet {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

export interface CompletedAuthentication {
  identity: ReturnType<typeof normalizeAuthenticatedSubject>
  authorizationContext: ProfileAuthorizationContext
  session: OrgSession
}

export class ProfileAuthBroker {
  private currentGeneration = 0

  constructor(
    private readonly api: ProfileAuthBrokerApi,
    private readonly managementAuthOrigin = 'management'
  ) {}

  get generation(): number {
    return this.currentGeneration
  }

  invalidate(): number {
    return ++this.currentGeneration
  }

  async completeManagement(
    authMode: Extract<OrgAuthMode, 'management-exchange' | 'management-oauth' | 'management-cookie'>,
    tokens: TokenSet,
    tokenSubject: number | string,
    generation = this.currentGeneration
  ): Promise<CompletedAuthentication> {
    const completed = await this.revalidateManagement(authMode, tokens, generation)
    const normalizedTokenSubject = this.requiredId('management token subject', tokenSubject)
    if (completed.session.userId !== normalizedTokenSubject) {
      throw new Error('management token subject does not match currentuser.id')
    }
    return completed
  }

  async revalidateManagement(
    authMode: Extract<OrgAuthMode, 'management-exchange' | 'management-oauth' | 'management-cookie'>,
    tokens: TokenSet,
    generation = this.currentGeneration
  ): Promise<CompletedAuthentication> {
    // 原并行请求已停用：const [server, user] = await Promise.all([this.api.getServerIdentity(), this.api.getCurrentUser()])
    const currentUser = await this.api.getCurrentUser()
    this.assertGeneration(generation)
    return this.managementAuthentication(authMode, tokens, currentUser)
  }

  completeOfficial(input: {
    issuerId: string
    userId: string
    accessToken: string
    displayName: string | null
    phone: string
  }): CompletedAuthentication {
    const issuerId = this.required('official issuer', input.issuerId)
    const userId = this.required('official user id', input.userId)
    return {
      identity: normalizeAuthenticatedSubject('official-direct', issuerId, userId),
      authorizationContext: { status: 'active', checkedAt: new Date().toISOString() },
      session: {
        authMode: 'official-direct',
        accountKind: 'official',
        issuerId,
        authOrigin: issuerId,
        userId,
        officialUserId: userId,
        groupId: null,
        displayName: input.displayName,
        phone: input.phone,
        role: '',
        status: 'active',
        accessToken: input.accessToken,
        refreshToken: '',
        expiresAt: Number.MAX_SAFE_INTEGER
      }
    }
  }

  private managementAuthentication(
    authMode: Extract<OrgAuthMode, 'management-exchange' | 'management-oauth' | 'management-cookie'>,
    tokens: TokenSet,
    currentUser: OrgCurrentUser
  ): CompletedAuthentication {
    const issuerId = this.required('server_instance_id', currentUser.server_instance_id)
    const user = currentUser.user
    if (!user || typeof user !== 'object') throw new Error('currentuser.user is required')
    const userId = this.requiredId('currentuser.id', user.id)
    const groupId = this.requiredId('currentuser.group_id', user.group_id)
    const role = this.required('currentuser.role', user.role)
    const status = this.required('currentuser.status', user.status)
    if (status !== 'active') throw new Error(`management account is inactive (${status})`)
    const checkedAt = new Date().toISOString()
    return {
      identity: normalizeAuthenticatedSubject(authMode, issuerId, userId),
      authorizationContext: { groupId, role, status, checkedAt },
      session: {
        authMode,
        accountKind: 'management',
        issuerId,
        authOrigin: this.managementAuthOrigin,
        userId,
        officialUserId: user.officialUserId ?? '',
        groupId,
        displayName: user.displayName?.trim() || user.username?.trim() || null,
        phone: user.phone ?? '',
        role,
        status,
        // ...tokens
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt
      }
    }
  }

  /**
   * [enterprise] Java Sa-Token 原生认证构造：不要求 status（活跃性由 Java 鉴权保证），
   * 但要求有效 tenantId 与 role；groupId 允许真实 null。tenantId 写入可变授权上下文，
   * 不进入 profile 主键（主键仍是 serverInstanceId + userId + accountKind）。
   */
  javaManagement(currentUser: JavaMeData, accessToken: string): CompletedAuthentication {
    const profile = normalizeJavaMe(currentUser)
    const checkedAt = new Date().toISOString()
    return {
      identity: normalizeAuthenticatedSubject('management-java', profile.serverInstanceId, profile.userId),
      authorizationContext: {
        tenantId: profile.tenantId,
        groupId: profile.groupId,
        role: profile.roleCode,
        checkedAt
      },
      session: {
        authMode: 'management-java',
        accountKind: 'management',
        issuerId: profile.serverInstanceId,
        authOrigin: this.managementAuthOrigin,
        userId: profile.userId,
        officialUserId: '',
        groupId: profile.groupId,
        tenantId: profile.tenantId,
        displayName: profile.username,
        phone: '',
        role: profile.roleCode,
        // status: '',
        accessToken,
        // refreshToken: '',
        // expiresAt: 0
        expiresAt: null
      }
    }
  }

  async javaRevalidate(
    getJavaProfile: () => Promise<JavaAuthProfile>,
    accessToken: string,
    generation = this.currentGeneration
  ): Promise<CompletedAuthentication> {
    const profile = await getJavaProfile()
    this.assertGeneration(generation)
    return this.javaManagement({ ...profile, id: profile.userId }, accessToken)
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.currentGeneration) throw new Error('stale authentication response')
  }

  /**
   * Canonical identity digest a live `/api/currentuser` response must produce for a
   * stored management/official session. The startup verifier (ProfileStartupVerifier)
   * and the login flows share this exact formula, so a candidate profile can only
   * become the business profile when `server_instance_id + user.id + accountKind`
   * match the profile's stored identity digest.
   */
  static expectedIdentityDigest(
    accountKind: 'management' | 'official',
    serverInstanceId: string,
    userId: string
  ): string {
    return computeIdentityDigest({ kind: 'authenticated', accountKind, issuerId: serverInstanceId, subjectId: userId })
  }

  private requiredId(name: string, value: unknown): string {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
    return this.required(name, value)
  }

  private required(name: string, value: unknown): string {
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`)
    return value
  }
}
