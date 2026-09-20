/**
 * [enterprise] C6 OrgMcpCatalog.compareAndSync 单元测试
 * 对比服务端目录 vs 本地 org 连接器：新增→安装、baseUrl 变更→更新、目录缺失→禁用标记。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { authMock, apiMock, mcpServiceMock, stateStoreMock } = vi.hoisted(() => ({
  authMock: {},
  apiMock: {
    listConnectors: vi.fn()
  },
  mcpServiceMock: {
    list: vi.fn().mockReturnValue({ items: [], total: 0, page: 1 }),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    getByIdSafe: vi.fn()
  },
  stateStoreMock: {
    upsert: vi.fn(),
    remove: vi.fn(),
    get: vi.fn(),
    snapshot: vi.fn().mockReturnValue({}),
    setEnabled: vi.fn(),
    markUnavailable: vi.fn(),
    markAvailable: vi.fn(),
    snapshotUnavailable: vi.fn().mockReturnValue(false),
    // 连接器状态与技能共用一份 store 的 connectors 字段——简化为方法级 mock
    upsertConnector: vi.fn(),
    removeConnector: vi.fn(),
    snapshotConnectors: vi.fn().mockReturnValue({}),
    // [enterprise] C4 连接器墓碑
    markConnectorDeleted: vi.fn(),
    deletedConnectorBaseUrl: vi.fn().mockReturnValue(undefined),
    clearConnectorDeleted: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) }
}))

vi.mock('@data/services/McpServerService', () => ({
  mcpServerService: mcpServiceMock
}))

vi.mock('@main/enterprise/OrgStateStore', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, orgStateStore: stateStoreMock }
})

import { OrgMcpCatalog } from '@main/enterprise/OrgMcpCatalog'

function makeConnector(slug: string, baseUrl: string) {
  return { slug, name: slug, description: `${slug} desc`, type: 'sse' as const, baseUrl, config: {} }
}

describe('OrgMcpCatalog C6 compareAndSync', () => {
  let catalog: OrgMcpCatalog

  beforeEach(() => {
    vi.resetAllMocks()
    stateStoreMock.snapshotConnectors.mockReturnValue({})
    mcpServiceMock.create.mockReturnValue({ id: 'mcp-new' })
    mcpServiceMock.getByIdSafe.mockReturnValue(null)
    catalog = new OrgMcpCatalog(authMock as never)
    ;(catalog as unknown as { auth: { apiClient: unknown } }).auth = { apiClient: apiMock }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('目录新增连接器 → 本地自动安装（isActive=false）', async () => {
    apiMock.listConnectors.mockResolvedValue({ connectors: [makeConnector('weather', 'http://w.example/sse')] })

    const result = await catalog.compareAndSync()
    expect(mcpServiceMock.create).toHaveBeenCalledTimes(1)
    expect(mcpServiceMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'weather', baseUrl: 'http://w.example/sse', isActive: false, installSource: 'org' })
    )
    expect(result.installed).toEqual(['weather'])
  })

  it('本地已有且 baseUrl 未变 → 跳过', async () => {
    apiMock.listConnectors.mockResolvedValue({ connectors: [makeConnector('weather', 'http://w.example/sse')] })
    stateStoreMock.snapshotConnectors.mockReturnValue({
      weather: { mcpId: 'mcp-1', baseUrl: 'http://w.example/sse' }
    })

    const result = await catalog.compareAndSync()
    expect(mcpServiceMock.create).not.toHaveBeenCalled()
    expect(mcpServiceMock.update).not.toHaveBeenCalled()
    expect(result.installed).toEqual([])
  })

  it('baseUrl 变更 → update 本地 MCP 服务器', async () => {
    apiMock.listConnectors.mockResolvedValue({ connectors: [makeConnector('weather', 'http://w2.example/sse')] })
    stateStoreMock.snapshotConnectors.mockReturnValue({
      weather: { mcpId: 'mcp-1', baseUrl: 'http://w.example/sse' }
    })

    const result = await catalog.compareAndSync()
    expect(mcpServiceMock.update).toHaveBeenCalledWith('mcp-1', expect.objectContaining({ baseUrl: 'http://w2.example/sse' }))
    expect(result.updated).toEqual(['weather'])
    expect(stateStoreMock.upsertConnector).toHaveBeenCalledWith('weather', { mcpId: 'mcp-1', baseUrl: 'http://w2.example/sse' })
  })

  it('目录缺失 → 本地禁用（isActive=false），不删除', async () => {
    apiMock.listConnectors.mockResolvedValue({ connectors: [] })
    stateStoreMock.snapshotConnectors.mockReturnValue({
      gone: { mcpId: 'mcp-9', baseUrl: 'http://g.example/sse' }
    })
    mcpServiceMock.getByIdSafe.mockReturnValue({ id: 'mcp-9', baseUrl: 'http://g.example/sse', isActive: true } as never)

    const result = await catalog.compareAndSync()
    expect(mcpServiceMock.delete).not.toHaveBeenCalled()
    expect(mcpServiceMock.update).toHaveBeenCalledWith('mcp-9', expect.objectContaining({ isActive: false }))
    expect(result.disabled).toEqual(['gone'])
  })

  it('本地记录已被用户删除 → 不更新本地，仅清 state 映射', async () => {
    apiMock.listConnectors.mockResolvedValue({ connectors: [] })
    stateStoreMock.snapshotConnectors.mockReturnValue({
      gone: { mcpId: 'mcp-x', baseUrl: 'http://g.example/sse' }
    })
    mcpServiceMock.getByIdSafe.mockReturnValue(null)

    const result = await catalog.compareAndSync()
    expect(mcpServiceMock.update).not.toHaveBeenCalled()
    // 本地已不存在 → 记入 disabled 但仅是清映射（实现里 disabled 含失效项也合理）
    expect(result.disabled).toEqual(['gone'])
    expect(stateStoreMock.removeConnector).toHaveBeenCalledWith('gone')
  })

  it('目录拉取失败 → 整体跳过不抛错（连接器禁用拦截 fail-closed 由运行时处理）', async () => {
    apiMock.listConnectors.mockRejectedValue(new Error('down'))
    const result = await catalog.compareAndSync()
    expect(result.installed).toEqual([])
    expect(result.updated).toEqual([])
    expect(result.disabled).toEqual([])
  })

  it('单项失败不阻塞其余项', async () => {
    apiMock.listConnectors.mockResolvedValue({
      connectors: [makeConnector('bad', 'http://b.example/sse'), makeConnector('good', 'http://g.example/sse')]
    })
    mcpServiceMock.create.mockImplementation((dto: { name: string }) => {
      if (dto.name === 'bad') throw new Error('create failed')
      return { id: 'mcp-new' }
    })

    const result = await catalog.compareAndSync()
    expect(result.installed).toEqual(['good'])
  })

  // [enterprise] C4 连接器墓碑：用户删除后若经历「企业下架清映射」→「重新上架」，
  // compareAndSync 会因「远端有、本地无 state」自动重装。墓碑（slug → 删除时 baseUrl）
  // 拦住同 baseUrl 的自动安装；手动 install 视为用户意图反转，清墓碑。
  it('目录重装遇同 baseUrl 墓碑 → 跳过自动安装', async () => {
    apiMock.listConnectors.mockResolvedValue({ connectors: [makeConnector('weather', 'http://w.example/sse')] })
    stateStoreMock.snapshotConnectors.mockReturnValue({})
    stateStoreMock.deletedConnectorBaseUrl.mockImplementation((slug: string) =>
      slug === 'weather' ? 'http://w.example/sse' : undefined
    )

    const result = await catalog.compareAndSync()
    expect(mcpServiceMock.create).not.toHaveBeenCalled()
    expect(result.installed).toEqual([])
  })

  it('墓碑存在但企业推送了新 baseUrl → 视为重新下发，清墓碑重装', async () => {
    apiMock.listConnectors.mockResolvedValue({ connectors: [makeConnector('weather', 'http://w2.example/sse')] })
    stateStoreMock.snapshotConnectors.mockReturnValue({})
    stateStoreMock.deletedConnectorBaseUrl.mockReturnValue('http://w.example/sse')

    await catalog.compareAndSync()
    expect(stateStoreMock.clearConnectorDeleted).toHaveBeenCalledWith('weather')
    expect(mcpServiceMock.create).toHaveBeenCalledTimes(1)
  })

  it('自动安装新连接器不应误清墓碑（墓碑只属于同 slug 的旧 baseUrl）', async () => {
    apiMock.listConnectors.mockResolvedValue({ connectors: [makeConnector('fresh', 'http://f.example/sse')] })
    stateStoreMock.snapshotConnectors.mockReturnValue({})
    stateStoreMock.deletedConnectorBaseUrl.mockReturnValue(undefined)

    await catalog.compareAndSync()
    expect(stateStoreMock.clearConnectorDeleted).not.toHaveBeenCalled()
  })

  it('目录缺失且本地已被用户删除 → 清映射同时写墓碑（唯一复活入口）', async () => {
    apiMock.listConnectors.mockResolvedValue({ connectors: [] })
    stateStoreMock.snapshotConnectors.mockReturnValue({
      gone: { mcpId: 'mcp-x', baseUrl: 'http://g.example/sse' }
    })
    mcpServiceMock.getByIdSafe.mockReturnValue(null)

    await catalog.compareAndSync()
    expect(stateStoreMock.markConnectorDeleted).toHaveBeenCalledWith('gone', 'http://g.example/sse')
    expect(stateStoreMock.removeConnector).toHaveBeenCalledWith('gone')
  })

  it('手动 install → 清除该 slug 的墓碑（用户重装意图生效）', async () => {
    apiMock.listConnectors.mockResolvedValue({ connectors: [makeConnector('weather', 'http://w.example/sse')] })

    await catalog.install('weather')
    expect(stateStoreMock.clearConnectorDeleted).toHaveBeenCalledWith('weather')
    expect(mcpServiceMock.create).toHaveBeenCalledTimes(1)
  })
})
