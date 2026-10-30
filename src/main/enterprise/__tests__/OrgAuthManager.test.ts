/**
 * [enterprise] OrgAuthManager 定向恢复测试（management-oauth / PKCE）
 * 合同重点：
 *  - startLogin 构建 /authorize PKCE 授权 URL（client_id / redirect_uri / state / S256 challenge）
 *  - token 换取的 code_verifier 与授权 URL 的 code_challenge 一致（S256）
 *  - 仅接受 code+state 回调；state 不匹配 / 旧 SSO 路径 / pending 超时不产生会话
 *  - 会话恢复只接受 authMode=management-oauth 且 authOrigin 匹配；旧官网/管理端-exchange 会话被忽略（不删文件）
 *  - 刷新更新 expiresIn 并去重；重启后恢复更新后的会话
 *  - 现有 SSO 测试已改为拒绝官网行为（不再认证成功）
 */
import { createHash } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { credStoreMock } = vi.hoisted(() => ({
  credStoreMock: { load: vi.fn(), save: vi.fn(), clear: vi.fn() }
}))

const { stateStoreMock } = vi.hoisted(() => ({
  stateStoreMock: {
    markUnavailable: vi.fn(),
    markAvailable: vi.fn(),
    snapshotUnavailable: vi.fn().mockReturnValue(false)
  }
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) }
}))

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn().mockResolvedValue(undefined) }
}))

vi.mock('@application', () => ({
  application: { get: vi.fn().mockReturnValue({ broadcast: vi.fn() }) }
}))

vi.mock('@main/enterprise/OrgCredentialStore', () => ({
  OrgCredentialStore: class {
    load = credStoreMock.load
    save = credStoreMock.save
    clear = credStoreMock.clear
  }
}))

vi.mock('@main/enterprise/OrgStateStore', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, orgStateStore: stateStoreMock }
})

import { OrgAuthManager } from '@main/enterprise/OrgAuthManager'
import type { OrgSession } from '@main/enterprise/OrgCredentialStore'

const DEFAULT_ORIGIN = 'http://36.150.116.248:3000'

const validSession = (over: Partial<OrgSession> = {}): OrgSession => ({
  authMode: 'management-oauth',
  authOrigin: DEFAULT_ORIGIN,
  userId: 'u1',
  officialUserId: '',
  displayName: null,
  phone: '13800000000',
  role: 'admin',
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: Date.now() + 3600_000,
  ...over
})

const tokenResponse = (over: Record<string, unknown> = {}) => ({
  ok: true,
  json: () =>
    Promise.resolve({
      access_token: 'a',
      refresh_token: 'r',
      expires_in: 3600,
      user: { id: 'u1', phone: '13800000000', role: 'admin' },
      ...over
    })
})

describe('OrgAuthManager PKCE 登录', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    credStoreMock.load.mockReturnValue(null)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('startLogin 构建 /authorize PKCE 授权 URL', async () => {
    const mgr = new OrgAuthManager()
    const { authorizationUrl } = await mgr.startLogin()
    const u = new URL(authorizationUrl)

    expect(`${u.origin}${u.pathname}`).toBe(`${DEFAULT_ORIGIN}/authorize`)
    const p = u.searchParams
    expect(p.get('response_type')).toBe('code')
    expect(p.get('client_id')).toBe('cn.xuelangyun.meacowork.desktop')
    expect(p.get('redirect_uri')).toBe('meacowork://auth/sso/callback')
    expect(p.get('code_challenge_method')).toBe('S256')
    expect(p.get('state')).toBeTruthy()
    expect(p.get('code_challenge')).toBeTruthy()
    expect(mgr.getPhase()).toBe('authorizing')
  })

  it('PKCE：token 换取的 code_verifier 与授权 URL 的 code_challenge 一致 (S256)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse())
    vi.stubGlobal('fetch', fetchMock)

    const mgr = new OrgAuthManager()
    const { authorizationUrl } = await mgr.startLogin()
    const pending = (mgr as unknown as { pending: { state: string; codeVerifier: string } }).pending
    const challenge = new URL(authorizationUrl).searchParams.get('code_challenge')!

    // challenge 必须等于 verifier 的 SHA256(base64url)
    const expected = createHash('sha256').update(pending.codeVerifier).digest('base64url')
    expect(challenge).toBe(expected)

    await mgr.handleAuthCallback(new URL(`meacowork://auth/sso/callback?code=CODE&state=${pending.state}`))

    expect(fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_ORIGIN}/api/token`,
      expect.objectContaining({ method: 'POST' })
    )
    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string)
    expect(body.get('code_verifier')).toBe(pending.codeVerifier)
    expect(body.get('code')).toBe('CODE')
    expect(body.get('client_id')).toBe('cn.xuelangyun.meacowork.desktop')
    expect(body.get('redirect_uri')).toBe('meacowork://auth/sso/callback')
    expect(mgr.getStatus()).toMatchObject({ phase: 'signed-in', authMode: 'management-oauth' })
    expect(credStoreMock.save).toHaveBeenCalledTimes(1)
  })
})

describe('OrgAuthManager 回调拒绝（错回调不能产生会话）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    credStoreMock.load.mockReturnValue(null)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('回调 state 不匹配：不产生会话、不请求 token', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const mgr = new OrgAuthManager()
    await mgr.startLogin()
    await mgr.handleAuthCallback(new URL('meacowork://auth/sso/callback?code=CODE&state=WRONG'))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(mgr.getPhase()).toBe('signed-out')
    expect(credStoreMock.save).not.toHaveBeenCalled()
  })

  // [enterprise] 现有 SSO 测试改为拒绝官网行为：旧 meacowork://auth/sso/callback 不再认证成功
  it('旧官网 SSO 回调被忽略且不污染进行中的 PKCE 登录', async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse())
    vi.stubGlobal('fetch', fetchMock)

    const mgr = new OrgAuthManager()
    const { authorizationUrl } = await mgr.startLogin()
    const pending = (mgr as unknown as { pending: { state: string } }).pending

    // 先收到一个旧官网 SSO 回调：应被忽略，不产生会话、不发官网 userInfo、不落盘
    await mgr.handleAuthCallback(new URL('meacowork://auth/sso/callback?token=official-token'))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(mgr.getPhase()).not.toBe('signed-in')
    expect(credStoreMock.save).not.toHaveBeenCalled()

    // 随后真正的 PKCE 回调仍完成登录（pending 未被 SSO 回调清除）
    await mgr.handleAuthCallback(new URL(`meacowork://auth/sso/callback?code=CODE&state=${pending.state}`))
    expect(fetchMock).toHaveBeenCalledWith(`${DEFAULT_ORIGIN}/api/token`, expect.anything())
    expect(authorizationUrl).toContain('/authorize')
    expect(mgr.getPhase()).toBe('signed-in')
  })

  it('pending 超过 TTL 后即使 state 匹配也拒绝', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const mgr = new OrgAuthManager()
    await mgr.startLogin()
    const pending = (mgr as unknown as { pending: { state: string; createdAt: number } }).pending
    pending.createdAt = Date.now() - (10 * 60 * 1000 + 1000)

    await mgr.handleAuthCallback(new URL(`meacowork://auth/sso/callback?code=CODE&state=${pending.state}`))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(mgr.getPhase()).toBe('signed-out')
  })
})

describe('OrgAuthManager 会话恢复（重启）只接受 management-oauth + 匹配 authOrigin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('只恢复管理端 OAuth 会话', () => {
    const mgr = new OrgAuthManager()
    expect(mgr.getPhase()).toBe('signed-out')
    expect(credStoreMock.clear).not.toHaveBeenCalled()
  })

  it('忽略 authOrigin 不匹配的会话', () => {
    credStoreMock.load.mockReturnValue({ ...validSession(), authOrigin: 'http://other.example:9090' })
    const mgr = new OrgAuthManager()
    expect(mgr.getPhase()).toBe('signed-out')
  })

  it('恢复匹配 management-oauth + authOrigin 的会话', () => {
    credStoreMock.load.mockReturnValue(validSession())
    const mgr = new OrgAuthManager()
    expect(mgr.getPhase()).toBe('signed-in')
    expect(mgr.getStatus()).toMatchObject({ authMode: 'management-oauth', phone: '13800000000' })
  })
})

describe('OrgAuthManager 刷新去重与重启恢复', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('刷新更新 expiresIn 并去重；重启后恢复更新后的会话', async () => {
    // 启动即恢复一个即将过期的会话
    credStoreMock.load.mockReturnValue(validSession({ expiresAt: Date.now() - 1000, accessToken: 'old' }))
    const mgr = new OrgAuthManager()

    const saved: OrgSession[] = []
    credStoreMock.save.mockImplementation((s: OrgSession) => {
      saved.push(s)
    })

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ accessToken: 'new', refreshToken: 'newrt', expiresIn: 7200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    // 并发两次取有效会话，应只触发一次刷新（去重）
    await Promise.all([mgr.getValidSession(), mgr.getValidSession()])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const sess = (mgr as unknown as { session: OrgSession }).session
    expect(sess.accessToken).toBe('new')
    expect(sess.expiresAt).toBeGreaterThan(Date.now() + 7000_000)
    expect(saved.at(-1)?.accessToken).toBe('new')

    // 模拟重启：用落盘会话重建管理器
    credStoreMock.load.mockReturnValue(saved.at(-1)!)
    const mgr2 = new OrgAuthManager()
    expect(mgr2.getPhase()).toBe('signed-in')
    expect((mgr2 as unknown as { session: OrgSession }).session.accessToken).toBe('new')
  })
})

describe('OrgAuthManager copy 模式：登录/登出不改变已安装资源可用性', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    credStoreMock.load.mockReturnValue(null)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('logout 不改变已安装资源的可用性', () => {
    const mgr = new OrgAuthManager()
    mgr.logout()
    expect(stateStoreMock.markUnavailable).not.toHaveBeenCalled()
    expect(stateStoreMock.markAvailable).not.toHaveBeenCalled()
  })

  it('PKCE 登录成功不改变已安装资源的可用性（且拒绝官网 SSO）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse())
    vi.stubGlobal('fetch', fetchMock)

    const mgr = new OrgAuthManager()
    const { authorizationUrl } = await mgr.startLogin()
    const pending = (mgr as unknown as { pending: { state: string } }).pending
    await mgr.handleAuthCallback(new URL(`meacowork://auth/sso/callback?code=CODE&state=${pending.state}`))

    // 走 PKCE /api/token，而非官网 userInfo
    expect(fetchMock).toHaveBeenCalledWith(`${DEFAULT_ORIGIN}/api/token`, expect.anything())
    expect(stateStoreMock.markAvailable).not.toHaveBeenCalled()
    expect(stateStoreMock.markUnavailable).not.toHaveBeenCalled()
    expect(authorizationUrl).toContain('/authorize')
  })
})
