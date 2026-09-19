/**
 * [enterprise] OrgApiClient 会话刷新链路测试
 * 修复目标：token 过期后请求自动走 getValidSession 刷新；401 兜底重试一次；
 * 未登录仍然快速失败。
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

  it('retries once with a refreshed session when the first request comes back 401', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{"error":"unauthorized"}', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ skills: [] }), { status: 200 }))
    const getValidSession = vi
      .fn()
      .mockResolvedValueOnce(session({ accessToken: 'stale-token' }))
      .mockResolvedValueOnce(session({ accessToken: 'fresh-token' }))
    const client = new OrgApiClient(getValidSession)

    const result = await client.listSkills()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][1].headers.authorization).toBe('Bearer fresh-token')
    expect(result.skills).toEqual([])
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

    await expect(client.listSkills()).rejects.toThrow('企业服务请求失败 (401)')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('still fails fast when no session is available', async () => {
    const client = new OrgApiClient(vi.fn().mockResolvedValue(null))

    await expect(client.listSkills()).rejects.toThrow('未登录企业服务')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
