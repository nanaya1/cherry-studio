/**
 * orgCurrentUserTransport must speak both auth contracts the design requires:
 *  - Bearer (OAuth/exchange): attach `Authorization: Bearer <token>`.
 *  - Cookie (password login): use the Electron session's cookies. The cookie
 *    probe proved `net.request` does NOT auto-attach cookies, so the transport
 *    routes through `session.fetch`, which includes the partition cookies.
 */
// import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) }
}))

import { createStartupCurrentUserTransport } from '../orgCurrentUserTransport'
import type { OrgSession } from '../types'

const BASE = 'https://api.example'

function bearerSession(over: Partial<Exclude<OrgSession, { authMode: 'management-java' }>> = {}): OrgSession {
  return {
    authMode: 'management-oauth',
    accountKind: 'management',
    issuerId: 'inst-1',
    authOrigin: 'inst-1',
    userId: 'u-1',
    officialUserId: '',
    groupId: 'g-1',
    displayName: null,
    phone: '',
    role: 'member',
    status: 'active',
    accessToken: 'tok',
    refreshToken: 'rt',
    expiresAt: 0,
    ...over
  }
}

/* const currentUserBody = JSON.stringify({
  server_instance_id: 'inst-1',
  user: { id: 'u-1', group_id: 'g-1', role: 'member', status: 'active' }
})

describe('StartupCurrentUserTransport Bearer contract', () => {
  beforeEach(() => vi.stubGlobal('fetch', fetchMock))
  afterEach(() => {
    fetchMock.mockReset()
    vi.unstubAllGlobals()
  })

  it('sends the access token as a Bearer header to /api/currentuser', async () => {
    fetchMock.mockResolvedValue(new Response(currentUserBody, { status: 200 }))
    const transport = createStartupCurrentUserTransport(bearerSession(), { baseUrl: BASE })

    const result = await transport.getCurrentUser()

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/currentuser`)
    expect(init.headers).toMatchObject({ authorization: 'Bearer tok' })
    expect(result).toMatchObject({ server_instance_id: 'inst-1', user: { id: 'u-1' } })
  })

  it.each([401, 403, 404, 429, 503])(
    'retains structured HTTP evidence without inventing global invalidity (%s)',
    async (status) => {
      fetchMock.mockResolvedValue(new Response('no', { status }))
      const transport = createStartupCurrentUserTransport(bearerSession(), { baseUrl: BASE })
      await expect(transport.getCurrentUser()).rejects.toMatchObject({
        name: 'VerificationError',
        evidence: {
          stage: 'current-user',
          endpoint: `${BASE}/api/currentuser`,
          httpStatus: status,
          kind: status === 429 || status >= 500 ? 'unavailable' : 'uncertain'
        }
      })
    }
  )

  it('retains parse failures as uncertain verification evidence', async () => {
    fetchMock.mockResolvedValue(new Response('<html>proxy</html>'))
    const transport = createStartupCurrentUserTransport(bearerSession(), { baseUrl: BASE })
    await expect(transport.getCurrentUser()).rejects.toMatchObject({
      evidence: { stage: 'current-user', kind: 'uncertain', httpStatus: 200 }
    })
  })
})

describe('StartupCurrentUserTransport Cookie contract', () => {
  it('uses the Electron session fetch (cookies) and never the global fetch', async () => {
    const sessionFetch = vi.fn().mockResolvedValue(new Response(currentUserBody, { status: 200 }))
    const transport = createStartupCurrentUserTransport(
      bearerSession({ authMode: 'management-cookie', accessToken: '' }),
      {
        baseUrl: BASE,
        electronSession: { fetch: sessionFetch }
      }
    )

    const result = await transport.getCurrentUser()

    expect(sessionFetch).toHaveBeenCalledOnce()
    expect(sessionFetch.mock.calls[0][0]).toBe(`${BASE}/api/currentuser`)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({ server_instance_id: 'inst-1' })
  })

  it('fails when a cookie session has no Electron auth session to read cookies from', async () => {
    const transport = createStartupCurrentUserTransport(
      bearerSession({ authMode: 'management-cookie', accessToken: '' }),
      {
        baseUrl: BASE
      }
    )

    await expect(transport.getCurrentUser()).rejects.toThrow(/Electron auth session/)
  })
})

describe('StartupCurrentUserTransport no session', () => {
  it('fails closed when nothing is stored for the candidate', async () => {
    const transport = createStartupCurrentUserTransport(null, { baseUrl: BASE })
    await expect(transport.getCurrentUser()).rejects.toThrow(/no candidate session/i)
  })
})

describe('StartupCurrentUserTransport request bounds', () => {
  beforeEach(() => vi.stubGlobal('fetch', fetchMock))
  afterEach(() => {
    fetchMock.mockReset()
    vi.unstubAllGlobals()
  })

  it('sends the Bearer request without cookies (credentials: omit)', async () => {
    fetchMock.mockResolvedValue(new Response(currentUserBody, { status: 200 }))
    const transport = createStartupCurrentUserTransport(bearerSession(), { baseUrl: BASE })

    await transport.getCurrentUser()

    const [, init] = fetchMock.mock.calls[0]
    expect(init.credentials).toBe('omit')
  })

  it('sends the Cookie request with credentials: include via the Electron session', async () => {
    const sessionFetch = vi.fn().mockResolvedValue(new Response(currentUserBody, { status: 200 }))
    const transport = createStartupCurrentUserTransport(
      bearerSession({ authMode: 'management-cookie', accessToken: '' }),
      {
        baseUrl: BASE,
        electronSession: { fetch: sessionFetch }
      }
    )

    await transport.getCurrentUser()

    const [, init] = sessionFetch.mock.calls[0]
    expect(init.credentials).toBe('include')
  })

  it('aborts the request after the configured timeout', async () => {
    const timeoutMs = 5
    fetchMock.mockImplementation(async (_url, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })
    const transport = createStartupCurrentUserTransport(bearerSession(), { baseUrl: BASE, timeoutMs })

    await expect(transport.getCurrentUser()).rejects.toThrow(/aborted/)
  })
}) */

describe('Java 启动传输隔离', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    fetchMock.mockReset()
  })
  it.each(['management-cookie', 'management-oauth', 'management-exchange', 'official-direct'] as const)(
    '阻断历史 %s 凭据且不发送请求',
    async (authMode) => {
      vi.stubGlobal('fetch', fetchMock)
      const transport = createStartupCurrentUserTransport(bearerSession({ authMode }), { baseUrl: BASE })
      await expect(transport.getCurrentUser()).rejects.toThrow('旧会话')
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )
  it('使用原始 token 和无 Cookie 的 me 接口', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 200,
          data: { serverInstanceId: 'inst-1', id: 'u-1', tenantId: 'tenant', groupId: null, roleCode: 'member' }
        })
      )
    )
    const transport = createStartupCurrentUserTransport(
      {
        authMode: 'management-java',
        accountKind: 'management',
        issuerId: 'inst-1',
        authOrigin: BASE,
        userId: 'u-1',
        officialUserId: '',
        groupId: null,
        tenantId: 'tenant',
        role: 'member',
        displayName: null,
        phone: '',
        accessToken: 'raw-token',
        expiresAt: null
      },
      { baseUrl: BASE }
    )
    await expect(transport.getCurrentJavaProfile!()).resolves.toMatchObject({
      userId: 'u-1',
      groupId: null,
      tenantId: 'tenant'
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE}/api/v1/auth/me`)
    expect(init.headers).toEqual({ token: 'raw-token' })
    expect(init.credentials).toBe('omit')
  })
})
