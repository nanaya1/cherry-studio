/**
 * orgCurrentUserTransport must speak both auth contracts the design requires:
 *  - Bearer (OAuth/exchange): attach `Authorization: Bearer <token>`.
 *  - Cookie (password login): use the Electron session's cookies. The cookie
 *    probe proved `net.request` does NOT auto-attach cookies, so the transport
 *    routes through `session.fetch`, which includes the partition cookies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) }
}))

import { createStartupCurrentUserTransport } from '../orgCurrentUserTransport'
import type { OrgSession } from '../types'

const BASE = 'https://api.example'

function bearerSession(over: Partial<OrgSession> = {}): OrgSession {
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

const currentUserBody = JSON.stringify({
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

  it('surfaces a non-OK status as a failure', async () => {
    fetchMock.mockResolvedValue(new Response('no', { status: 401 }))
    const transport = createStartupCurrentUserTransport(bearerSession(), { baseUrl: BASE })

    await expect(transport.getCurrentUser()).rejects.toThrow('401')
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
})
