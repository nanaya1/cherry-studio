import { afterEach, describe, expect, it, vi } from 'vitest'

import { OrgApiClient } from '../OrgApiClient'

const javaSession = {
  authMode: 'management-java' as const,
  accountKind: 'management' as const,
  issuerId: '11111111111141118111111111111111',
  authOrigin: 'https://enterprise.test',
  userId: '7',
  groupId: null,
  tenantId: '9',
  displayName: null,
  phone: '',
  role: 'MEMBER',
  accessToken: 'native-token',
  officialUserId: '7',
  expiresAt: null
}

afterEach(() => vi.unstubAllGlobals())

describe('OrgApiClient Java资源接线', () => {
  it('知识库原生读取复用Java会话，业务失效通知认证层', async () => {
    const id = '11111111-1111-1111-1111-111111111111'
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ code: 200, data: { id, name: '知识库', category: 'OWNED' } }))
      .mockResolvedValueOnce(Response.json({ code: 10008 }))
    vi.stubGlobal('fetch', fetchImpl)
    const expired = vi.fn()
    const client = new OrgApiClient(async () => javaSession, undefined, expired)
    expect((await client.javaKnowledge.getSpace(id)).id).toBe(id)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(new URL(url).pathname).toBe('/api/v1/knowledge/detail')
    expect(new URL(url).searchParams.get('scope')).toBe('client')
    expect(new Headers(init.headers).get('token')).toBe('native-token')
    expect(new Headers(init.headers).has('authorization')).toBe(false)
    await expect(client.javaKnowledge.getSpace(id)).rejects.toThrow('重新登录')
    expect(expired).toHaveBeenCalledTimes(1)
  })

  it('知识库原生接口拒绝非Java会话，不发送旧凭据', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    const client = new OrgApiClient(async () => null)
    await expect(client.javaKnowledge.getCatalog()).rejects.toThrow('重新登录')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('产品API门面可读取原生目录，不走旧Bearer路由', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ code: 200, data: [] }))
    vi.stubGlobal('fetch', fetchImpl)
    const client = new OrgApiClient(async () => javaSession)
    expect(await client.javaResources.listConnectors()).toEqual([])
    const [url, init] = fetchImpl.mock.calls[0]
    expect(new URL(url).pathname).toBe('/api/v1/mcp/list')
    expect(new Headers(init.headers).get('token')).toBe('native-token')
    expect(new Headers(init.headers).has('authorization')).toBe(false)
  })

  it('失效业务码向认证层报告，不吞成空目录', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ code: 10008 })))
    const expired = vi.fn()
    const client = new OrgApiClient(async () => javaSession, undefined, expired)
    await expect(client.javaResources.listConnectors()).rejects.toThrow('重新登录')
    expect(expired).toHaveBeenCalledTimes(1)
  })

  it('拒绝将非Java会话凭据用于原生资源接口', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    const client = new OrgApiClient(async () => ({
      ...javaSession,
      authMode: 'management-cookie',
      status: 'active',
      refreshToken: '',
      expiresAt: Date.now() + 60_000
    }))
    await expect(client.javaResources.listConnectors()).rejects.toThrow('重新登录')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
