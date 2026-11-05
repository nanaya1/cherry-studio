import type { CompletedProfileAuthentication } from '@main/core/profiles'
import type { ProfileSwitchResult } from '@main/core/profiles'

import type { JavaAuthClient } from './JavaAuthClient'
import { ProfileAuthBroker } from './ProfileAuthBroker'
// import type { OrgSession } from './types'

/* interface PasswordSession {
  fetch(url: string, init?: RequestInit): Promise<Response>
}
interface PasswordLoginDependencies {
  baseUrl: string
  createTemporarySession(): PasswordSession
  clearTemporary(session: PasswordSession): Promise<void>
  prepareTarget(
    session: PasswordSession,
    profileRoot: string,
    identity: OrgSession
  ): Promise<void | (() => Promise<void>)>
  completeAuthentication(authentication: CompletedProfileAuthentication): Promise<ProfileSwitchResult>
}

*/
// MEA:enterprise-java-auth 凭据写入仍由 profile 切换事务负责。
interface PasswordLoginDependencies {
  baseUrl: string
  client: Pick<JavaAuthClient, 'login' | 'fetchMe'>
  completeAuthentication(authentication: CompletedProfileAuthentication): Promise<ProfileSwitchResult>
}
export class PasswordProfileLogin {
  private generation = 0
  private busy = false
  constructor(private readonly dependencies: PasswordLoginDependencies) {}

  get isBusy(): boolean {
    return this.busy
  }

  cancel(): void {
    this.generation += 1
  }

  async login(identifier: string, password: string): Promise<ProfileSwitchResult> {
    if (this.busy) throw new Error('Authentication already in progress')
    if (!identifier.trim() || !password) throw new Error('Identifier and password are required')
    this.busy = true
    const generation = ++this.generation
    const assertCurrent = () => {
      if (generation !== this.generation) throw new Error('stale authentication response')
    }
    /* const temporary = this.dependencies.createTemporarySession()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    try {
      const response = await temporary.fetch(`${this.dependencies.baseUrl}/api/auth/login`, {
        method: 'POST',
        credentials: 'include',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: identifier.trim(), password }),
        signal: controller.signal
      })
      assertCurrent()
      if (!response.ok) throw new Error(`Password login failed (${response.status})`)
      const broker = new ProfileAuthBroker(
        {
          getCurrentUser: async () => {
            const current = await temporary.fetch(`${this.dependencies.baseUrl}/api/currentuser`, {
              credentials: 'include',
              redirect: 'error',
              signal: controller.signal
            })
            if (!current.ok) throw new Error(`currentuser request failed (${current.status})`)
            return current.json()
          }
        },
        this.dependencies.baseUrl
      )
      const authentication = await broker.revalidateManagement('management-cookie', {
        accessToken: '',
        refreshToken: '',
        expiresAt: Number.MAX_SAFE_INTEGER
      })
      assertCurrent()
      return await this.dependencies.completeAuthentication({
        ...authentication,
        prepareTargetSession: async (profileRoot) => {
          assertCurrent()
          const rollback = await this.dependencies.prepareTarget(temporary, profileRoot, authentication.session)
          try {
            assertCurrent()
          } catch (error) {
            await rollback?.()
            throw error
          }
          return rollback
        }
      })
    } finally {
      clearTimeout(timer)
      try {
        await this.dependencies.clearTemporary(temporary)
      } finally {
        this.busy = false
      }
    } */
    try {
      const tokens = await this.dependencies.client.login(identifier.trim(), password)
      assertCurrent()
      const profile = await this.dependencies.client.fetchMe(tokens.accessToken)
      assertCurrent()
      if (tokens.tenantId !== profile.tenantId) throw new Error('登录企业与用户企业不一致，请重新登录')
      const broker = new ProfileAuthBroker(
        {
          getCurrentUser: async () => {
            throw new Error('旧认证已停用')
          }
        },
        this.dependencies.baseUrl
      )
      const authentication = broker.javaManagement({ ...profile, id: profile.userId }, tokens.accessToken)
      return await this.dependencies.completeAuthentication({
        ...authentication,
        prepareTargetSession: async () => {
          assertCurrent()
        }
      })
    } finally {
      this.busy = false
    }
  }
}
