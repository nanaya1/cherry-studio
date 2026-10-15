/**
 * [enterprise] Startup currentuser transport. Speaks the dual Cookie/Bearer
 * contract (cookie probe proved net.request does NOT auto-attach cookies), kept
 * Electron-free so it is exercised by the transport tests, not the verifier.
 */
import { getOrgApiBaseUrl } from './OrgApiClient'
import type { OrgCurrentUser, OrgSession } from './types'

export interface StartupCurrentUserTransport {
  getCurrentUser(): Promise<OrgCurrentUser>
}

export interface ElectronSessionLike {
  fetch(url: string, init?: RequestInit): Promise<Response>
}

export interface StartupTransportOptions {
  baseUrl?: string
  electronSession?: ElectronSessionLike
  /** Single-request timeout in ms (design default 10000). */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000

export function createStartupCurrentUserTransport(
  session: OrgSession | null,
  options: StartupTransportOptions = {}
): StartupCurrentUserTransport {
  const baseUrl = options.baseUrl ?? getOrgApiBaseUrl()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  if (!session) {
    return {
      getCurrentUser: async () => {
        throw new Error('no candidate session stored; login required')
      }
    }
  }

  // Cookie contract: password login persists `sid` in an isolated Electron
  // session. We use session.fetch (includes partition cookies) with credentials:'include'.
  if (session.accountKind === 'management' && session.authMode === 'management-cookie') {
    const electronSession = options.electronSession
    if (!electronSession) {
      return {
        getCurrentUser: async () => {
          throw new Error('cookie verification requires an Electron auth session')
        }
      }
    }
    return {
      getCurrentUser: async () => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          const response = await electronSession.fetch(`${baseUrl}/api/currentuser`, {
            credentials: 'include',
            signal: controller.signal
          })
          if (!response.ok) throw new Error(`currentuser request failed (${response.status})`)
          return (await response.json()) as OrgCurrentUser
        } finally {
          clearTimeout(timer)
        }
      }
    }
  }

  // Bearer contract: OAuth/exchange sessions carry an access token and must NOT
  // send cookies (credentials:'omit').
  return {
    getCurrentUser: async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetch(`${baseUrl}/api/currentuser`, {
          headers: { authorization: `Bearer ${session.accessToken}` },
          credentials: 'omit',
          signal: controller.signal
        })
        if (!response.ok) throw new Error(`currentuser request failed (${response.status})`)
        return (await response.json()) as OrgCurrentUser
      } finally {
        clearTimeout(timer)
      }
    }
  }
}
