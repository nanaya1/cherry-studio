/**
 * [enterprise] 企业服务端地址构建期可配置测试
 * MAIN_VITE_ORG_SERVER_BASE_URL 有值时规范化为 origin；未配置时使用官网直连模式。
 * 非法值在模块加载时直接抛错（构建/测试尽早失败，而非运行时指向错误服务端）。
 * 三处写死地址收敛到 ORG_SERVER_BASE_URL 单一出口，登录与技能下载共用。
 */
import { createHash } from 'node:crypto'

import { shell } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn().mockResolvedValue(undefined) }
}))

vi.mock('@application', () => ({
  application: {
    get: vi.fn().mockReturnValue({ broadcast: vi.fn() })
  }
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) }
}))

const credentialStoreMocks = vi.hoisted(() => ({
  load: vi.fn().mockReturnValue(null),
  save: vi.fn(),
  clear: vi.fn()
}))

vi.mock('@main/enterprise/OrgCredentialStore', () => ({
  OrgCredentialStore: class {
    load = credentialStoreMocks.load
    save = credentialStoreMocks.save
    clear = credentialStoreMocks.clear
  }
}))

describe('ORG_SERVER_BASE_URL', () => {
  afterEach(() => {
    vi.clearAllMocks()
    credentialStoreMocks.load.mockReturnValue(null)
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it.each([
    {
      name: 'official direct when only the official login URL is configured',
      officialUrl: 'https://official.example.com/login',
      orgUrl: '',
      expected: 'official-direct'
    },
    {
      name: 'management exchange when both URLs are configured',
      officialUrl: 'https://official.example.com/login',
      orgUrl: 'https://org.example.com',
      expected: 'management-exchange'
    },
    {
      name: 'management OAuth when only the management URL is configured',
      officialUrl: '',
      orgUrl: 'https://org.example.com',
      expected: 'management-oauth'
    },
    {
      name: 'official direct fallback when neither URL is configured',
      officialUrl: '',
      orgUrl: '',
      expected: 'official-direct'
    }
  ])('$name', async ({ officialUrl, orgUrl, expected }) => {
    vi.stubEnv('MAIN_VITE_OFFICIAL_LOGIN_URL', officialUrl)
    vi.stubEnv('MAIN_VITE_ORG_SERVER_BASE_URL', orgUrl)
    vi.resetModules()
    const { ORG_AUTH_MODE } = await import('@main/enterprise/OrgApiClient')

    expect(ORG_AUTH_MODE).toBe(expected)
  })

  it('normalizes a configured deployment base URL to its origin', async () => {
    vi.stubEnv('MAIN_VITE_ORG_SERVER_BASE_URL', ' https://org.example.com/api/ ')
    vi.resetModules()
    const { ORG_SERVER_BASE_URL } = await import('@main/enterprise/OrgApiClient')

    expect(ORG_SERVER_BASE_URL).toBe('https://org.example.com')
  })

  it('opens the management OAuth authorization URL when only it is configured', async () => {
    vi.stubEnv('MAIN_VITE_ORG_SERVER_BASE_URL', 'https://org.example.com/api/')
    vi.stubEnv('MAIN_VITE_OFFICIAL_LOGIN_URL', '')
    vi.resetModules()
    const { OrgAuthManager } = await import('@main/enterprise/OrgAuthManager')

    const result = await new OrgAuthManager().startLogin()
    const authorizationUrl = new URL(result.authorizationUrl)

    expect(authorizationUrl.origin).toBe('https://org.example.com')
    expect(authorizationUrl.pathname).toBe('/authorize')
    expect(authorizationUrl.searchParams.get('response_type')).toBe('code')
    expect(authorizationUrl.searchParams.get('client_id')).toBe('cherry-desktop')
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe('meacowork://auth/callback')
    expect(authorizationUrl.searchParams.get('state')).toBeTruthy()
    expect(authorizationUrl.searchParams.get('code_challenge')).toBeTruthy()
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(shell.openExternal).toHaveBeenCalledOnce()
    expect(shell.openExternal).toHaveBeenLastCalledWith(result.authorizationUrl)
  })

  it('exchanges the management OAuth code with the PKCE verifier', async () => {
    vi.stubEnv('MAIN_VITE_ORG_SERVER_BASE_URL', 'https://org.example.com')
    vi.stubEnv('MAIN_VITE_OFFICIAL_LOGIN_URL', '')
    vi.resetModules()
    const { OrgAuthManager } = await import('@main/enterprise/OrgAuthManager')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          user: { id: 'user-1', username: 'User One', phone: '13900000000', role: 'member' }
        })
    })
    globalThis.fetch = fetchMock as never
    const manager = new OrgAuthManager()
    const { authorizationUrl } = await manager.startLogin()
    const state = new URL(authorizationUrl).searchParams.get('state')

    await manager.handleAuthCallback(new URL(`meacowork://auth/callback?code=auth-code&state=${state}`))

    expect(fetchMock).toHaveBeenCalledOnce()
    const [tokenUrl, init] = fetchMock.mock.calls[0]
    expect(tokenUrl).toBe('https://org.example.com/api/token')
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    })
    const body = init.body as URLSearchParams
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('auth-code')
    const codeVerifier = body.get('code_verifier')
    expect(codeVerifier).toBeTruthy()
    expect(new URL(authorizationUrl).searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(codeVerifier!).digest('base64url')
    )
    expect(body.get('client_id')).toBe('cherry-desktop')
    expect(body.get('redirect_uri')).toBe('meacowork://auth/callback')
    expect(manager.getStatus()).toMatchObject({ phase: 'signed-in', displayName: 'User One' })
  })

  it('ignores an official callback while a management OAuth login is pending', async () => {
    vi.stubEnv('MAIN_VITE_ORG_SERVER_BASE_URL', 'https://org.example.com')
    vi.stubEnv('MAIN_VITE_OFFICIAL_LOGIN_URL', '')
    vi.resetModules()
    const { OrgAuthManager } = await import('@main/enterprise/OrgAuthManager')
    const manager = new OrgAuthManager()
    await manager.startLogin()

    await manager.handleAuthCallback(new URL('meacowork://auth/sso/callback?token=official-token'))

    expect(manager.getStatus().phase).toBe('authorizing')
  })

  it('clears a stored session from a different auth mode', async () => {
    vi.stubEnv('MAIN_VITE_ORG_SERVER_BASE_URL', 'https://org.example.com')
    vi.stubEnv('MAIN_VITE_OFFICIAL_LOGIN_URL', '')
    credentialStoreMocks.load.mockReturnValue({
      authMode: 'official-direct',
      userId: 'official-user',
      officialUserId: 'official-user',
      displayName: null,
      phone: '',
      role: '',
      accessToken: 'official-token',
      refreshToken: '',
      expiresAt: Number.MAX_SAFE_INTEGER
    })
    vi.resetModules()
    const { OrgAuthManager } = await import('@main/enterprise/OrgAuthManager')

    const manager = new OrgAuthManager()

    expect(manager.getStatus().phase).toBe('signed-out')
    expect(credentialStoreMocks.clear).toHaveBeenCalledOnce()
  })

  it('keeps the pending OAuth login after rejecting a mismatched state', async () => {
    vi.stubEnv('MAIN_VITE_ORG_SERVER_BASE_URL', 'https://org.example.com')
    vi.stubEnv('MAIN_VITE_OFFICIAL_LOGIN_URL', '')
    vi.resetModules()
    const { OrgAuthManager } = await import('@main/enterprise/OrgAuthManager')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          user: { id: 'user-1', phone: null, role: 'member' }
        })
    })
    globalThis.fetch = fetchMock as never
    const manager = new OrgAuthManager()
    const { authorizationUrl } = await manager.startLogin()
    const state = new URL(authorizationUrl).searchParams.get('state')

    await manager.handleAuthCallback(new URL('meacowork://auth/callback?code=forged-code&state=forged-state'))
    await manager.handleAuthCallback(new URL(`meacowork://auth/callback?code=auth-code&state=${state}`))

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(manager.getStatus().phase).toBe('signed-in')
  })

  it('clears a stored session issued by a different origin', async () => {
    vi.stubEnv('MAIN_VITE_ORG_SERVER_BASE_URL', 'https://new-org.example.com')
    vi.stubEnv('MAIN_VITE_OFFICIAL_LOGIN_URL', '')
    credentialStoreMocks.load.mockReturnValue({
      authMode: 'management-oauth',
      authOrigin: 'https://old-org.example.com',
      userId: 'user-1',
      officialUserId: '',
      displayName: null,
      phone: '',
      role: 'member',
      accessToken: 'old-token',
      refreshToken: 'old-refresh',
      expiresAt: Date.now() + 60_000
    })
    vi.resetModules()
    const { OrgAuthManager } = await import('@main/enterprise/OrgAuthManager')

    const manager = new OrgAuthManager()

    expect(manager.getStatus().phase).toBe('signed-out')
    expect(credentialStoreMocks.clear).toHaveBeenCalledOnce()
  })

  it('uses official SSO and exchanges its token when both URLs are configured', async () => {
    vi.stubEnv('MAIN_VITE_ORG_SERVER_BASE_URL', 'https://org.example.com')
    vi.stubEnv('MAIN_VITE_OFFICIAL_LOGIN_URL', 'https://official.example.com/login')
    vi.resetModules()
    const { OrgAuthManager } = await import('@main/enterprise/OrgAuthManager')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          accessToken: 'management-access',
          refreshToken: 'management-refresh',
          expiresIn: 3600,
          user: { id: 'user-1', officialUserId: 'official-1', displayName: 'User One', phone: null, role: 'member' }
        })
    })
    globalThis.fetch = fetchMock as never
    const manager = new OrgAuthManager()

    const result = await manager.startLogin()
    await manager.handleAuthCallback(new URL('meacowork://auth/sso/callback?token=official-token'))

    expect(result.authorizationUrl).toBe('https://official.example.com/login')
    expect(fetchMock).toHaveBeenCalledWith('https://org.example.com/api/auth/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ officialToken: 'official-token' })
    })
    expect(manager.getStatus()).toMatchObject({
      phase: 'signed-in',
      authMode: 'management-exchange',
      displayName: 'User One'
    })
  })

  it('returns to signed out when the system browser cannot be opened', async () => {
    vi.stubEnv('MAIN_VITE_ORG_SERVER_BASE_URL', 'https://org.example.com')
    vi.stubEnv('MAIN_VITE_OFFICIAL_LOGIN_URL', 'https://official.example.com/login')
    vi.mocked(shell.openExternal).mockRejectedValueOnce(new Error('browser unavailable'))
    vi.resetModules()
    const { OrgAuthManager } = await import('@main/enterprise/OrgAuthManager')
    const manager = new OrgAuthManager()

    await expect(manager.startLogin()).rejects.toThrow('browser unavailable')

    expect(manager.getStatus().phase).toBe('signed-out')
  })

  it('does not clear a newer pending OAuth login when an earlier browser open fails', async () => {
    vi.stubEnv('MAIN_VITE_ORG_SERVER_BASE_URL', 'https://org.example.com')
    vi.stubEnv('MAIN_VITE_OFFICIAL_LOGIN_URL', '')
    let rejectFirstOpen!: (error: Error) => void
    vi.mocked(shell.openExternal)
      .mockImplementationOnce(() => new Promise((_, reject) => (rejectFirstOpen = reject)))
      .mockResolvedValueOnce(undefined)
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
          user: { id: 'user-1', phone: null, role: 'member' }
        })
    }) as never
    vi.resetModules()
    const { OrgAuthManager } = await import('@main/enterprise/OrgAuthManager')
    const manager = new OrgAuthManager()

    const firstLogin = manager.startLogin()
    const secondLogin = await manager.startLogin()
    rejectFirstOpen(new Error('first browser unavailable'))
    await expect(firstLogin).rejects.toThrow('first browser unavailable')

    const secondState = new URL(secondLogin.authorizationUrl).searchParams.get('state')
    expect(manager.getStatus().phase).toBe('authorizing')
    await manager.handleAuthCallback(new URL(`meacowork://auth/callback?code=auth-code&state=${secondState}`))
    expect(globalThis.fetch).toHaveBeenCalledOnce()
  })

  it('falls back to the official login URL when the management URL is unset', async () => {
    vi.stubEnv('MAIN_VITE_ORG_SERVER_BASE_URL', '')
    vi.stubEnv('MAIN_VITE_OFFICIAL_LOGIN_URL', 'https://official.example.com/login')
    vi.resetModules()
    const { OrgAuthManager } = await import('@main/enterprise/OrgAuthManager')

    const result = await new OrgAuthManager().startLogin()

    expect(result.authorizationUrl).toBe('https://official.example.com/login')
    expect(shell.openExternal).toHaveBeenCalledOnce()
    expect(shell.openExternal).toHaveBeenLastCalledWith('https://official.example.com/login')
  })

  it('rejects a malformed configured URL at module load', async () => {
    vi.stubEnv('MAIN_VITE_ORG_SERVER_BASE_URL', 'not a url')
    vi.resetModules()
    const importConfigured = () => import('@main/enterprise/OrgApiClient')

    await expect(importConfigured()).rejects.toThrow('MAIN_VITE_ORG_SERVER_BASE_URL 不是合法 URL')
  })
})
