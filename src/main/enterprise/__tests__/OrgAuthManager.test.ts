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

// vi.mock('@application', () => ({ application: { get: vi.fn().mockReturnValue({ broadcast: vi.fn() }) } }))
vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  return mockApplicationFactory()
})

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

import { shell } from 'electron'

import { application } from '@application'
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const callbackFor = (authorizationUrl: string, query = 'code=CODE') =>
  new URL(`meacowork://auth/sso/callback?${query}&state=${new URL(authorizationUrl).searchParams.get('state')}`)

describe('OrgAuthManager 登录生命周期', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    credStoreMock.load.mockReturnValue(null)
    vi.mocked(shell.openExternal).mockResolvedValue(undefined)
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('实际状态始终包含 attempt 和错误字段，重复 start 不重开浏览器', async () => {
    const mgr = new OrgAuthManager()
    expect(mgr.getStatus()).toMatchObject({ loginAttemptId: null, loginStartedAt: null, loginError: null })
    const first = mgr.startLogin()
    const status = mgr.getStatus()
    const second = mgr.startLogin()
    expect(await second).toEqual(await first)
    expect(status).toMatchObject({ loginAttemptId: expect.any(String), loginStartedAt: Date.now(), loginError: null })
    expect(mgr.getStatus()).toEqual(status)
    expect(shell.openExternal).toHaveBeenCalledTimes(1)
  })

  it('10 分钟主动到期并广播，重新开始会清除 timeout', async () => {
    const mgr = new OrgAuthManager()
    await mgr.startLogin()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(application.get('IpcApiService').broadcast).toHaveBeenLastCalledWith(
      'enterprise.status_changed',
      expect.objectContaining({ phase: 'signed-out', loginError: 'timeout', loginAttemptId: null })
    )
    await mgr.startLogin()
    expect(mgr.getStatus()).toMatchObject({ phase: 'authorizing', loginError: null })
  })

  it.each(['status', 'callback'])('休眠后 %s 按绝对 deadline 拒绝旧 attempt', async (entry) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const mgr = new OrgAuthManager()
    const { authorizationUrl } = await mgr.startLogin()
    vi.setSystemTime(Date.now() + 600_000)
    if (entry === 'callback') await mgr.handleAuthCallback(callbackFor(authorizationUrl))
    expect(mgr.getStatus()).toMatchObject({ phase: 'signed-out', loginError: 'timeout', loginAttemptId: null })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('取消仅接受当前 attempt 身份，旧 state 不清新 attempt', async () => {
    const mgr = new OrgAuthManager()
    const old = await mgr.startLogin()
    const id = mgr.getStatus().loginAttemptId!
    expect(mgr.cancelLogin('wrong')).toEqual({ ok: false })
    expect(mgr.cancelLogin(id)).toEqual({ ok: true })
    expect(mgr.getStatus()).toMatchObject({ phase: 'signed-out', loginError: null, loginAttemptId: null })
    await mgr.startLogin()
    const status = mgr.getStatus()
    expect(mgr.cancelLogin(id)).toEqual({ ok: false })
    await mgr.handleAuthCallback(callbackFor(old.authorizationUrl))
    expect(mgr.getStatus()).toEqual(status)
  })

  it('重复回调只换取一次且成功清除所有计时器', async () => {
    const response = deferred<ReturnType<typeof tokenResponse>>()
    const fetchMock = vi.fn().mockReturnValue(response.promise)
    vi.stubGlobal('fetch', fetchMock)
    const mgr = new OrgAuthManager()
    const { authorizationUrl } = await mgr.startLogin()
    const first = mgr.handleAuthCallback(callbackFor(authorizationUrl))
    await mgr.handleAuthCallback(callbackFor(authorizationUrl))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    response.resolve(tokenResponse())
    await first
    expect(mgr.getStatus()).toMatchObject({
      phase: 'signed-in',
      loginAttemptId: null,
      loginStartedAt: null,
      loginError: null
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['cancel', 'logout', 'timeout'])('%s 中止 exchange，迟到响应不能复活且不影响新 attempt', async (action) => {
    const response = deferred<ReturnType<typeof tokenResponse>>()
    const fetchMock = vi.fn().mockReturnValue(response.promise)
    vi.stubGlobal('fetch', fetchMock)
    const mgr = new OrgAuthManager()
    const { authorizationUrl } = await mgr.startLogin()
    const done = mgr.handleAuthCallback(callbackFor(authorizationUrl))
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal
    if (action === 'cancel') mgr.cancelLogin(mgr.getStatus().loginAttemptId!)
    if (action === 'logout') mgr.logout()
    if (action === 'timeout') await vi.advanceTimersByTimeAsync(30_000)
    expect(signal.aborted).toBe(true)
    if (action === 'timeout') {
      expect(mgr.getStatus()).toMatchObject({ phase: 'signed-out', loginError: 'timeout' })
      await done
    }
    await mgr.startLogin()
    const status = mgr.getStatus()
    response.resolve(tokenResponse())
    await done
    expect(mgr.getStatus()).toEqual(status)
    expect(credStoreMock.save).not.toHaveBeenCalled()
  })

  it('旧 exchange 失败不清新 attempt，也不覆盖新错误', async () => {
    const response = deferred<ReturnType<typeof tokenResponse>>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(response.promise))
    const mgr = new OrgAuthManager()
    const { authorizationUrl } = await mgr.startLogin()
    const done = mgr.handleAuthCallback(callbackFor(authorizationUrl))
    const settled = done.catch(() => undefined)
    mgr.cancelLogin(mgr.getStatus().loginAttemptId!)
    await mgr.startLogin()
    const status = mgr.getStatus()
    response.reject(new Error('旧请求失败'))
    await settled
    expect(mgr.getStatus()).toEqual(status)
  })

  it('exchange 响应体卡住也受独立 30 秒超时约束', async () => {
    const body = deferred<Record<string, unknown>>()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => body.promise }))
    const mgr = new OrgAuthManager()
    const { authorizationUrl } = await mgr.startLogin()
    const done = mgr.handleAuthCallback(callbackFor(authorizationUrl))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(mgr.getStatus()).toMatchObject({ phase: 'signed-out', loginError: 'timeout' })
    await done
    body.resolve({})
    expect(credStoreMock.save).not.toHaveBeenCalled()
  })

  it('exchange 期间休眠越过 deadline，响应到达也不能落盘', async () => {
    const body = deferred<Record<string, unknown>>()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => body.promise }))
    const mgr = new OrgAuthManager()
    const { authorizationUrl } = await mgr.startLogin()
    const done = mgr.handleAuthCallback(callbackFor(authorizationUrl))
    await Promise.resolve()
    vi.setSystemTime(Date.now() + 30_000)
    body.resolve(await tokenResponse().json())
    await done
    expect(mgr.getStatus()).toMatchObject({ phase: 'signed-out', loginError: 'timeout' })
    expect(credStoreMock.save).not.toHaveBeenCalled()
  })

  it('浏览器打开失败恢复，可重新开始；旧打开失败不清新 attempt', async () => {
    const browser = deferred<void>()
    vi.mocked(shell.openExternal).mockReturnValueOnce(browser.promise)
    const mgr = new OrgAuthManager()
    const opening = mgr.startLogin().catch(() => undefined)
    mgr.cancelLogin(mgr.getStatus().loginAttemptId!)
    await mgr.startLogin()
    const status = mgr.getStatus()
    browser.reject(new Error('浏览器失败'))
    await opening
    expect(mgr.getStatus()).toEqual(status)
    mgr.cancelLogin(status.loginAttemptId!)
    vi.mocked(shell.openExternal).mockRejectedValueOnce(new Error('打开失败'))
    await expect(mgr.startLogin()).rejects.toThrow('打开失败')
    expect(mgr.getStatus()).toMatchObject({ phase: 'signed-out', loginError: 'failed' })
    await mgr.startLogin()
    expect(mgr.getStatus()).toMatchObject({ phase: 'authorizing', loginError: null })
  })

  it.each([
    ['access_denied', 'denied'],
    ['server_error', 'failed']
  ])('匹配 state 的 OAuth %s 结束 attempt', async (error, expected) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const mgr = new OrgAuthManager()
    const { authorizationUrl } = await mgr.startLogin()
    const status = mgr.getStatus()
    await mgr.handleAuthCallback(new URL('meacowork://auth/sso/callback?error=access_denied&state=wrong'))
    expect(mgr.getStatus()).toEqual(status)
    await mgr.handleAuthCallback(callbackFor(authorizationUrl, `error=${error}`))
    expect(mgr.getStatus()).toMatchObject({ phase: 'signed-out', loginError: expected, loginAttemptId: null })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'reject'])('登出后的旧 refresh %s 不能复活会话或取消新 attempt', async (outcome) => {
    credStoreMock.load.mockReturnValue(validSession({ expiresAt: Date.now() - 1 }))
    const response = deferred<{ ok: boolean; json: () => Promise<Record<string, unknown>> }>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(response.promise))
    const mgr = new OrgAuthManager()
    const refreshing = mgr.getValidSession()
    mgr.logout()
    await mgr.startLogin()
    const status = mgr.getStatus()
    if (outcome === 'resolve')
      response.resolve({ ok: true, json: async () => ({ accessToken: 'late', refreshToken: 'late', expiresIn: 3600 }) })
    else response.reject(new Error('旧 refresh 失败'))
    await refreshing
    expect(mgr.getStatus()).toEqual(status)
    expect(credStoreMock.save).not.toHaveBeenCalled()
  })

  it('当前 exchange 失败结束 attempt 并报告 failed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))
    const mgr = new OrgAuthManager()
    const { authorizationUrl } = await mgr.startLogin()
    await expect(mgr.handleAuthCallback(callbackFor(authorizationUrl))).rejects.toThrow('token exchange failed')
    expect(mgr.getStatus()).toMatchObject({ phase: 'signed-out', loginError: 'failed' })
    expect(vi.getTimerCount()).toBe(0)
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

    expect(fetchMock).toHaveBeenCalledWith(`${DEFAULT_ORIGIN}/api/token`, expect.objectContaining({ method: 'POST' }))
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
    // expect(mgr.getPhase()).toBe('signed-out')
    expect(mgr.getPhase()).toBe('authorizing')
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
    // const pending = (mgr as unknown as { pending: { state: string; createdAt: number } }).pending
    // pending.createdAt = Date.now() - (10 * 60 * 1000 + 1000)
    const pending = (mgr as unknown as { pending: { state: string; deadline: number } }).pending
    pending.deadline = Date.now() - 1000

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
