/**
 * [enterprise] Startup currentuser transport. Speaks the dual Cookie/Bearer
 * contract (cookie probe proved net.request does NOT auto-attach cookies), kept
 * Electron-free so it is exercised by the transport tests, not the verifier.
 */
import { getOrgApiBaseUrl } from './OrgApiClient'
import type { OrgCurrentUser, OrgSession } from './types'
import { VerificationError, verificationHttpError } from './verification'

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
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 10_000

export function createStartupCurrentUserTransport(
  session: OrgSession | null,
  options: StartupTransportOptions = {}
): StartupCurrentUserTransport {
  const baseUrl = options.baseUrl ?? getOrgApiBaseUrl()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const endpoint = `${baseUrl}/api/currentuser`
  const request = async (send: (signal: AbortSignal) => Promise<Response>): Promise<OrgCurrentUser> => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) controller.abort()
    const timer = setTimeout(abort, timeoutMs)
    try {
      const response = await send(controller.signal)
      if (!response.ok) throw verificationHttpError('current-user', endpoint, response)
      try {
        return (await response.json()) as OrgCurrentUser
      } catch {
        throw new VerificationError('currentuser response is not valid JSON', {
          stage: 'current-user',
          endpoint,
          kind: 'uncertain',
          httpStatus: response.status
        })
      }
    } catch (error) {
      if (error instanceof VerificationError) throw error
      throw new VerificationError(
        controller.signal.aborted ? 'currentuser request aborted' : 'currentuser network unavailable',
        {
          stage: 'current-user',
          endpoint,
          kind: 'unavailable'
        }
      )
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
  }

  if (!session) {
    return {
      getCurrentUser: async () => {
        // throw new Error('no candidate session stored; login required')
        throw new VerificationError('no candidate session stored; login required', {
          stage: 'session',
          endpoint,
          kind: 'uncertain'
        })
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
          // throw new Error('cookie verification requires an Electron auth session')
          throw new VerificationError('cookie verification requires an Electron auth session', {
            stage: 'session',
            endpoint,
            kind: 'uncertain'
          })
        }
      }
    }
    return {
      // MEA:profile-verification-network-tolerance Preserve HTTP and parse evidence instead of inferring invalid credentials.
      // if (!response.ok) throw new Error(`currentuser request failed (${response.status})`)
      getCurrentUser: () =>
        request((signal) =>
          electronSession.fetch(endpoint, {
            credentials: 'include',
            redirect: 'error',
            signal
          })
        )
    }
  }

  // Bearer contract: OAuth/exchange sessions carry an access token and must NOT
  // send cookies (credentials:'omit').
  return {
    // if (!response.ok) throw new Error(`currentuser request failed (${response.status})`)
    getCurrentUser: () =>
      request((signal) =>
        fetch(endpoint, {
          headers: { authorization: `Bearer ${session.accessToken}` },
          credentials: 'omit',
          redirect: 'error',
          signal
        })
      )
  }
}
