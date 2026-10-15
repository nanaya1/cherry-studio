import type { CompletedProfileAuthentication } from '@main/core/profiles'
import type { ProfileSwitchResult } from '@main/core/profiles'

import { ProfileAuthBroker } from './ProfileAuthBroker'
import type { OrgSession } from './types'

interface PasswordSession {
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
    const temporary = this.dependencies.createTemporarySession()
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
    }
  }
}
