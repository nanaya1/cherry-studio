import { setupTestDatabase } from '@test-helpers/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { application } from '@application'
import { mcpServerService } from '@data/services/McpServerService'
import { externalKnowledgeReference } from '@shared/utils/externalKnowledgeConnector'

import { ExternalKnowledgeConnectorCatalog } from '../ExternalKnowledgeConnectorCatalog'
import type { OrgAuthManager } from '../OrgAuthManager'

const id = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'
const key = 'ck_' + 'a'.repeat(32)
const instance = (instanceId = id) => ({
  id: instanceId,
  kind: 'weknora',
  name: '企业资料',
  description: '共享知识源',
  type: 'streamableHttp',
  baseUrl: 'https://space.test/api/v1/mcps/connectors/weknora/mcp',
  headers: { 'mcp-key': key }
})

function createAuth() {
  const state = { generation: 0, issuerId: 'server-a', userId: '7', tenantId: '9', groupId: null }
  const auth = {
    getValidSession: async () => ({
      ...state,
      authMode: 'management-java',
      authOrigin: 'https://cowork.test',
      accessToken: 'raw-token'
    }),
    acquireLease: () => ({ ...state }),
    assertLease: (lease: typeof state) => {
      if (JSON.stringify(lease) !== JSON.stringify(state)) throw new Error('stale lease')
    }
  } as unknown as OrgAuthManager
  return { state, auth }
}

describe('外部知识库显式目录与本地连接', () => {
  setupTestDatabase()
  const runtime = { restartServer: vi.fn(), stopServer: vi.fn() }

  beforeEach(() => {
    const originalGet = application.getContainer().get.bind(application.getContainer())
    vi.spyOn(application, 'get').mockImplementation((name) => {
      if (name === 'McpRuntimeService') return runtime as never
      return originalGet(name)
    })
    runtime.restartServer.mockReset().mockResolvedValue(undefined)
    runtime.stopServer.mockReset().mockResolvedValue(undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function serve(items: unknown[] = [instance()]) {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ code: 200, data: { userId: 7, tenantId: 9, items } }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }
  async function started() {
    const { state, auth } = createAuth()
    const catalog = new ExternalKnowledgeConnectorCatalog(auth)
    const fetchMock = serve()
    const [item] = await catalog.list()
    const view = await catalog.setActive(item.resourceKey, true)
    return { state, catalog, fetchMock, view, server: mcpServerService.getById(view.serverId!) }
  }

  it('查询不创建或启动，显式启动后才持久化，重复刷新保留用户关闭选择', async () => {
    const { auth } = createAuth()
    const catalog = new ExternalKnowledgeConnectorCatalog(auth)
    const fetchMock = serve()
    const [item] = await catalog.list()
    expect(item.isActive).toBe(false)
    expect(mcpServerService.list({}).total).toBe(0)
    expect(runtime.restartServer).not.toHaveBeenCalled()
    const active = await catalog.setActive(item.resourceKey, true)
    expect(active.isActive).toBe(true)
    expect(mcpServerService.getById(active.serverId!).headers).toEqual({ 'mcp-key': key })
    await catalog.setActive(item.resourceKey, false)
    expect((await catalog.list())[0]).toMatchObject({ serverId: active.serverId, isActive: false })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(item)).not.toContain(key)
  })

  it('同名实例按来源UUID独立创建，不认领手工MCP，也不随服务端变更自行同步', async () => {
    const manual = mcpServerService.create({
      name: '企业资料',
      type: 'streamableHttp',
      baseUrl: 'https://manual.test',
      isActive: true
    })
    const { auth } = createAuth()
    const catalog = new ExternalKnowledgeConnectorCatalog(auth)
    const fetchMock = serve([instance(), instance(secondId)])
    const items = await catalog.list()
    const first = await catalog.setActive(items[0].resourceKey, true)
    const second = await catalog.setActive(items[1].resourceKey, true)
    expect(first.serverId).not.toBe(second.serverId)
    expect(mcpServerService.getById(manual.id)).toEqual(manual)
    fetchMock.mockResolvedValue(Response.json({ code: 10007 }))
    expect(mcpServerService.getById(first.serverId!).isActive).toBe(true)
    await expect(catalog.list()).rejects.toThrow()
    expect(mcpServerService.getById(first.serverId!)).toMatchObject({ isActive: false, headers: {} })
    expect(mcpServerService.getById(second.serverId!).isActive).toBe(false)
    expect(mcpServerService.getById(manual.id).isActive).toBe(true)
  })

  it.each(['network', 'json', 'schema'])('%s失败保留旧连接与凭据', async (failure) => {
    const { catalog, fetchMock, server } = await started()
    if (failure === 'network') fetchMock.mockRejectedValue(new Error('network'))
    if (failure === 'json') fetchMock.mockResolvedValue(new Response('<html>'))
    if (failure === 'schema')
      fetchMock.mockResolvedValue(Response.json({ code: 200, data: { userId: 7, tenantId: 9, items: [{}] } }))
    await expect(catalog.list()).rejects.toThrow()
    expect(mcpServerService.getById(server.id)).toEqual(server)
    expect(runtime.stopServer).not.toHaveBeenCalled()
  })

  it('完整空快照才停用缺失项，其他认证来源和用户的项不受影响', async () => {
    const { catalog, fetchMock, server } = await started()
    const other = mcpServerService.create({
      name: '其他来源',
      type: 'streamableHttp',
      isActive: true,
      reference: externalKnowledgeReference({ issuerId: 'other', userId: '7', tenantId: '9', instanceId: id })
    })
    fetchMock.mockResolvedValue(Response.json({ code: 200, data: { userId: 7, tenantId: 9, items: [] } }))
    expect(await catalog.list()).toEqual([])
    expect(mcpServerService.getById(server.id)).toMatchObject({ isActive: false, headers: {} })
    expect(mcpServerService.getById(other.id).isActive).toBe(true)
    expect(runtime.stopServer).toHaveBeenCalledWith(server.id)
  })

  it('Key轮换刷新本地凭据并断开旧连接，但不自动握手或改变开关', async () => {
    const { catalog, fetchMock, server } = await started()
    const nextKey = 'ck_' + 'b'.repeat(32)
    fetchMock.mockResolvedValue(
      Response.json({
        code: 200,
        data: { userId: 7, tenantId: 9, items: [{ ...instance(), headers: { 'mcp-key': nextKey } }] }
      })
    )
    expect((await catalog.list())[0].isActive).toBe(true)
    expect(mcpServerService.getById(server.id).headers).toEqual({ 'mcp-key': nextKey })
    expect(runtime.stopServer).toHaveBeenCalledWith(server.id)
    expect(runtime.restartServer).toHaveBeenCalledTimes(1)
  })

  it('迟到快照或身份不匹配不落盘，旧身份卡片不能在新身份启动', async () => {
    const { state, catalog, fetchMock, server, view } = await started()
    fetchMock.mockImplementation(async () => {
      state.generation++
      return Response.json({ code: 200, data: { userId: 7, tenantId: 9, items: [] } })
    })
    await expect(catalog.list()).rejects.toThrow('stale lease')
    expect(mcpServerService.getById(server.id)).toEqual(server)
    state.userId = '8'
    await expect(catalog.setActive(view.resourceKey, true)).rejects.toThrow()
    fetchMock.mockResolvedValue(Response.json({ code: 200, data: { userId: 7, tenantId: 9, items: [] } }))
    await expect(catalog.list()).rejects.toThrow()
    expect(mcpServerService.getById(server.id)).toEqual(server)
  })

  it('握手失败回关闭且错误不带上游密钥', async () => {
    const { catalog, view } = await started()
    runtime.restartServer.mockRejectedValue(new Error(key))
    await expect(catalog.setActive(view.resourceKey, true)).rejects.toThrow('外部知识库连接操作失败')
    expect(mcpServerService.getById(view.serverId!).isActive).toBe(false)
  })

  it('某个停止失败仍停用所有缺失项并尝试断开', async () => {
    const { auth } = createAuth()
    const catalog = new ExternalKnowledgeConnectorCatalog(auth)
    const fetchMock = serve([instance(), instance(secondId)])
    const items = await catalog.list()
    const views = await Promise.all(items.map((item) => catalog.setActive(item.resourceKey, true)))
    runtime.stopServer.mockRejectedValueOnce(new Error(key))
    fetchMock.mockResolvedValue(Response.json({ code: 200, data: { userId: 7, tenantId: 9, items: [] } }))
    await expect(catalog.list()).rejects.toThrow('外部知识库连接停止失败')
    for (const item of views) expect(mcpServerService.getById(item.serverId!).isActive).toBe(false)
    expect(runtime.stopServer).toHaveBeenCalledTimes(2)
  })
})
