import { afterEach, describe, expect, it, vi } from 'vitest'

import { JavaKnowledgeConnectorClient } from '../JavaKnowledgeConnectorClient'

afterEach(() => vi.unstubAllGlobals())

describe('外部知识库传输契约', () => {
  it('固定客户端GET使用原始token、不缓存和重定向，完整空快照为有效结果', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ code: 200, data: { userId: 7, tenantId: 9, items: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new JavaKnowledgeConnectorClient('https://cowork.test', 'raw-token')
    expect(await client.list()).toEqual({ userId: '7', tenantId: '9', items: [] })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cowork.test/api/v1/client/knowledge/connectors/list',
      expect.objectContaining({
        method: 'GET',
        headers: { accept: 'application/json', token: 'raw-token' },
        cache: 'no-store',
        redirect: 'error',
        credentials: 'omit'
      })
    )
  })

  it.each([401, 403])('HTTP %i映射为明确权限拒绝且不泄漏响应内容', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('secret-key', { status })))
    await expect(new JavaKnowledgeConnectorClient('https://cowork.test', 'token').list()).rejects.toMatchObject({
      code: status === 401 ? 10008 : 10007,
      message: '外部知识库访问权限已失效'
    })
  })

  it('不完整或超出安全整数的身份不能被接受为成功空快照', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: 200, data: { items: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new JavaKnowledgeConnectorClient('https://cowork.test', 'token')
    await expect(client.list()).rejects.toMatchObject({ code: 500 })
    fetchMock.mockResolvedValue(
      Response.json({ code: 200, data: { userId: Number.MAX_SAFE_INTEGER + 1, tenantId: 9, items: [] } })
    )
    await expect(client.list()).rejects.toMatchObject({ code: 500 })
  })
})
