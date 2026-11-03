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
import type { OrgSession } from '@main/enterprise/types'

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

// [enterprise] 公共目录契约：10s 超时 + 401/403 附带旧 token 匿名重试一次（公共目录匿名可达，
// 不能把"鉴权失效"误判为"目录不可达"）；匿名仍 401/403 则原样抛错，不伪造成功。
describe('OrgApiClient public catalog contract', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    fetchMock.mockReset()
    vi.unstubAllGlobals()
  })

  it('publicRequest sets an explicit 10s AbortSignal.timeout covering request + body read', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ skills: [] }), { status: 200 }))
    const client = new OrgApiClient(vi.fn().mockResolvedValue(session({ accessToken: 'tok' })))

    await client.listSkills()

    // 明确 10000ms 超时信号
    expect(timeoutSpy).toHaveBeenCalledWith(10000)
    const init = fetchMock.mock.calls[0][1]
    expect(init.signal).toBeInstanceOf(AbortSignal)
    timeoutSpy.mockRestore()
  })

  it('retries anonymously once when 401 arrives with an attached token', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{"error":"unauthorized"}', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ skills: [] }), { status: 200 }))
    const client = new OrgApiClient(vi.fn().mockResolvedValue(session({ accessToken: 'stale' })))

    const result = await client.listSkills()

    expect(result.skills).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // 第二次（匿名）不带 Authorization
    expect(fetchMock.mock.calls[1][1].headers.authorization).toBeUndefined()
  })

  it('retries anonymously once when 403 arrives with an attached token', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{"error":"forbidden"}', { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ skills: [] }), { status: 200 }))
    const client = new OrgApiClient(vi.fn().mockResolvedValue(session({ accessToken: 'stale' })))

    const result = await client.listSkills()

    expect(result.skills).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][1].headers.authorization).toBeUndefined()
  })

  it('surfaces the error as-is (no fake success) when the anonymous retry also 401s', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }))
    const client = new OrgApiClient(vi.fn().mockResolvedValue(session({ accessToken: 'stale' })))

    await expect(client.listSkills()).rejects.toThrow('账户服务请求失败 (401)')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('surfaces the error as-is (no fake success) when the anonymous retry also 403s', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"forbidden"}', { status: 403 }))
    const client = new OrgApiClient(vi.fn().mockResolvedValue(session({ accessToken: 'stale' })))

    await expect(client.listSkills()).rejects.toThrow('账户服务请求失败 (403)')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry anonymously when 401 arrives without a token (signed out)', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }))
    const client = new OrgApiClient(vi.fn().mockResolvedValue(null))

    await expect(client.listSkills()).rejects.toThrow('账户服务请求失败 (401)')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects the whole catalog request when getValidSession never resolves and the signal aborts', async () => {
    const controller = new AbortController()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    // 会话永不 resolve：用可控 controller 替代 10s 超时来驱动中止，避免测试等待
    const getValidSession = vi.fn(() => new Promise<OrgSession | null>(() => {}))
    const client = new OrgApiClient(getValidSession)

    const promise = client.listSkills()
    queueMicrotask(() => controller.abort())

    await expect(promise).rejects.toThrow()
    // 会话阶段就被中止：未发起任何目录 fetch（不只是调用次数）
    expect(fetchMock).not.toHaveBeenCalled()
    timeoutSpy.mockRestore()
  })

  it('reuses the same total-budget signal across the token attempt and the anonymous retry', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    fetchMock
      .mockResolvedValueOnce(new Response('{"error":"unauthorized"}', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ skills: [] }), { status: 200 }))
    const client = new OrgApiClient(vi.fn().mockResolvedValue(session({ accessToken: 'stale' })))

    await client.listSkills()

    // 同 signal 跨匿名重试是有意的总预算：两阶段共用同一实例，且来源正是 timeout(10000)
    expect(timeoutSpy).toHaveBeenCalledWith(10000)
    const firstSignal = fetchMock.mock.calls[0][1].signal
    const retrySignal = fetchMock.mock.calls[1][1].signal
    expect(firstSignal).toBeInstanceOf(AbortSignal)
    expect(retrySignal).toBe(firstSignal)
    timeoutSpy.mockRestore()
  })
})
