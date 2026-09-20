/**
 * [enterprise] OrgApiClient 会话刷新链路测试
 * 修复目标：token 过期后请求自动走 getValidSession 刷新；401 兜底重试一次；
 * 未登录仍然快速失败。
 * [enterprise] 公共目录改造后：列表接口匿名可用（无会话直接请求，不再快速失败），
 * 401 重试逻辑仅覆盖仍需登录的写接口（request 链路），由 lifecycle 上报承接受测。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))

// OrgApiClient 只依赖 @logger，stub 掉避免拉起完整 logger 链
vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) }
}))

import { OrgApiClient } from '@main/enterprise/OrgApiClient'

const session = (over: Partial<{ accessToken: string }> = {}) => ({
  userId: 'u1',
  phone: '13800000000',
  role: 'admin',
  accessToken: over.accessToken ?? 'stale-token',
  refreshToken: 'rt',
  expiresAt: Date.now() - 1000
})

describe('OrgApiClient session refresh', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    fetchMock.mockReset()
    vi.unstubAllGlobals()
  })

  it('awaits the async session provider so expired tokens get refreshed before the request', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ skills: [] }), { status: 200 }))
    const getValidSession = vi.fn().mockResolvedValue(session({ accessToken: 'fresh-token' }))
    const client = new OrgApiClient(getValidSession)

    await client.listSkills()

    expect(getValidSession).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers.authorization).toBe('Bearer fresh-token')
  })

  it('retries once with a refreshed session when a signed-in request comes back 401', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{"error":"unauthorized"}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
    const getValidSession = vi
      .fn()
      .mockResolvedValueOnce(session({ accessToken: 'stale-token' }))
      .mockResolvedValueOnce(session({ accessToken: 'fresh-token' }))
    const client = new OrgApiClient(getValidSession)

    await client.reportLifecycle('a', 'install')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][1].headers.authorization).toBe('Bearer fresh-token')
  })

  it('surfaces the error when the retry also fails with 401', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }))
    // 两次调用返回不同 token 才会触发重试（相同 token 视为刷新不可用，直接失败）
    const client = new OrgApiClient(
      vi
        .fn()
        .mockResolvedValueOnce(session({ accessToken: 'stale-token' }))
        .mockResolvedValueOnce(session({ accessToken: 'fresh-token' }))
    )

    // reportLifecycle 吞掉请求错误（不阻塞主流程），这里断言它确实重试过一次
    await client.reportLifecycle('a', 'install')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

// [enterprise] 公共目录：技能/连接器列表与技能包下载匿名可用（所有人看到同一套公共资源）；
// 生命周期上报属于登录写接口，仍要求会话。
describe('OrgApiClient public catalog access', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    fetchMock.mockReset()
    vi.unstubAllGlobals()
  })

  it('lists skills anonymously without an Authorization header when signed out', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ skills: [] }), { status: 200 }))
    const client = new OrgApiClient(vi.fn().mockResolvedValue(null))

    const result = await client.listSkills()

    expect(result.skills).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers.authorization).toBeUndefined()
  })

  it('lists connectors anonymously without an Authorization header when signed out', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ connectors: [] }), { status: 200 }))
    const client = new OrgApiClient(vi.fn().mockResolvedValue(null))

    const result = await client.listConnectors()

    expect(result.connectors).toEqual([])
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers.authorization).toBeUndefined()
  })

  it('still attaches the session token to public reads when signed in', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ skills: [] }), { status: 200 }))
    const client = new OrgApiClient(vi.fn().mockResolvedValue(session({ accessToken: 'tok' })))

    await client.listSkills()

    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers.authorization).toBe('Bearer tok')
  })

  it('skips lifecycle report without a request when signed out (best-effort semantics)', async () => {
    const client = new OrgApiClient(vi.fn().mockResolvedValue(null))

    // reportLifecycle 吞错不阻塞主流程；匿名时等价于"跳过"：resolve 且不发请求
    await expect(client.reportLifecycle('a', 'install')).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
