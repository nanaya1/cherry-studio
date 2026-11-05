import { JavaAuthClient } from './JavaAuthClient'
/**
 * [enterprise] Startup currentuser transport. Speaks the dual Cookie/Bearer
 * contract (cookie probe proved net.request does NOT auto-attach cookies), kept
 * Electron-free so it is exercised by the transport tests, not the verifier.
 */
import { getOrgApiBaseUrl } from './OrgApiClient'
import type { JavaAuthProfile, OrgCurrentUser, OrgSession } from './types'
// import { VerificationError, verificationHttpError } from './verification'

export interface StartupCurrentUserTransport {
  getCurrentUser(): Promise<OrgCurrentUser>
  /** [enterprise] Java Sa-Token 路径：以原始 token 头拉取 /me 并归一化身份与授权。 */
  getCurrentJavaProfile?(): Promise<JavaAuthProfile>
}

export interface JavaStartupTransportOptions {
  baseUrl?: string
  publicKeyBase64?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * [enterprise] Java 启动传输：仅用于 management-java 会话的在线身份校验，使用 token 头而非 Bearer。
 * 与旧 Bearer/Cookie 传输严格隔离，不进入任何业务请求链路。
 */
export function createJavaStartupTransport(
  session: OrgSession,
  options: JavaStartupTransportOptions = {}
): StartupCurrentUserTransport {
  const baseUrl = options.baseUrl ?? getOrgApiBaseUrl()
  if (!baseUrl) throw new Error('management server URL is not configured')
  const client = new JavaAuthClient({
    baseUrl,
    publicKeyBase64: options.publicKeyBase64,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs
  })
  return {
    getCurrentUser: async () => {
      throw new Error('Java transport uses getCurrentJavaProfile, not getCurrentUser')
    },
    getCurrentJavaProfile: () => client.fetchMe(session.accessToken)
  }
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
  if (!session) {
    return {
      getCurrentUser: async () => {
        throw new Error('no candidate session stored; login required')
      }
    }
  }

  // MEA:enterprise-java-auth 启动仅接受原生 Java 会话，禁止历史凭据出站。
  if (session.authMode === 'management-java') return createJavaStartupTransport(session, { baseUrl, timeoutMs })
  return {
    getCurrentUser: async () => {
      throw new Error('旧会话需要重新登录')
    }
  }

  /* 原 Cookie/Bearer currentuser 传输停用，保留以便回溯。
  const endpoint = `${baseUrl}/api/currentuser`
  if (session.accountKind === 'management' && session.authMode === 'management-cookie') {
    return { getCurrentUser: () => options.electronSession!.fetch(endpoint).then((response) => response.json()) }
  }
  return {
    getCurrentUser: () =>
      fetch(endpoint, { headers: { authorization: `Bearer ${session.accessToken}` } }).then((response) => response.json())
  }
  */
}
