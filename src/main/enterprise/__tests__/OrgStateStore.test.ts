/**
 * [enterprise] C1/C5 OrgStateStore 单元测试
 * 本地状态持久化：org 技能安装记录（version/contentHash/skillId/folderName/enabled）。
 * 纯文件逻辑，用临时目录跑真实 IO。
 */
import type * as NodeFs from 'node:fs'
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  readdirSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { applicationMock } = vi.hoisted(() => {
  const applicationMock = { getPath: vi.fn() }
  return { applicationMock }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})

vi.mock('@application', () => ({
  application: applicationMock
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() })
  }
}))

import { OrgStateStore } from '@main/enterprise/OrgStateStore'

describe('OrgStateStore', () => {
  let tmp: string

  beforeEach(async () => {
    const actual = await vi.importActual<typeof NodeFs>('node:fs')
    vi.mocked(renameSync).mockReset().mockImplementation(actual.renameSync)
    tmp = mkdtempSync(join(tmpdir(), 'org-state-test-'))
    applicationMock.getPath.mockImplementation((key: string) => {
      if (key === 'feature.enterprise.state_file') return join(tmp, 'Sensitive', 'Enterprise', 'org-state.json')
      throw new Error(`unexpected getPath key: ${key}`)
    })
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('同步未知上传和旧新 cleanup 映射跨实例保留', () => {
    const record = {
      shareId: 's1',
      completion: 'incomplete',
      files: [],
      manifest: {
        state: 'unknown',
        lastSyncedAt: null,
        entries: [{ itemId: 'i', fileId: 'old', fileName: '原名.txt', hash: 'h' }],
        operations: [
          {
            itemId: 'i',
            fileName: '原名.txt',
            kind: 'update',
            remoteFileId: 'orgkb:b2xk',
            newFileId: 'new',
            hash: 'new-h',
            phase: 'cleanup_pending',
            error: '索引未确认'
          }
        ]
      }
    }
    new OrgStateStore().setShareAssociation('key', record as never)
    expect(new OrgStateStore().getShareAssociation('key')).toEqual(record)
  })

  it('共享逐文件结果和完成状态跨实例保留', () => {
    const record = {
      shareId: 's1',
      completion: 'incomplete',
      files: [{ fileName: 'a', status: 'unknown', fileId: null, chunkCount: null, error: 'network' }]
    }
    new OrgStateStore().setShareAssociation('key', record as never)
    expect(new OrgStateStore().getShareAssociation('key')).toEqual(record)
  })

  it('clearShare 原子清除关联与首传记录且持久化（避免复用旧 space）', () => {
    const store = new OrgStateStore()
    store.setShareAssociation('key', { shareId: 's1', completion: 'completed', files: [] })
    store.setFirstShareUpload('key', {
      name: '副本',
      creation: 'created',
      shareId: 's1',
      files: []
    } as never)
    expect(store.getShareAssociation('key')?.shareId).toBe('s1')
    expect(store.getFirstShareUpload('key')?.shareId).toBe('s1')

    store.clearShare('key')

    expect(store.getShareAssociation('key')).toBeUndefined()
    expect(store.getFirstShareUpload('key')).toBeUndefined()
    const reloaded = new OrgStateStore()
    expect(reloaded.getShareAssociation('key')).toBeUndefined()
    expect(reloaded.getFirstShareUpload('key')).toBeUndefined()
  })

  it('clearShare 不影响其他 key 的关联与首传记录', () => {
    const store = new OrgStateStore()
    store.setShareAssociation('key', { shareId: 's1', completion: 'completed', files: [] })
    store.setShareAssociation('other', { shareId: 's2', completion: 'completed', files: [] })
    store.setFirstShareUpload('other', { name: 'o', creation: 'created', shareId: 's2', files: [] } as never)

    store.clearShare('key')

    expect(store.getShareAssociation('other')?.shareId).toBe('s2')
    expect(store.getFirstShareUpload('other')?.shareId).toBe('s2')
  })

  it.each(['replace', 'remove'] as const)('原子替换失败时 %s 不丢失旧关联和其他状态', (operation) => {
    const store = new OrgStateStore()
    store.upsert('demo', { version: '1', contentHash: 'h', skillId: 's', folderName: 'd' })
    store.setShareAssociation('key', 'old-share')
    const filePath = applicationMock.getPath('feature.enterprise.state_file')
    const previous = readFileSync(filePath, 'utf8')
    const association = store.getShareAssociation('key')
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error('原子替换失败')
    })

    expect(() => {
      if (operation === 'replace') store.setShareAssociation('key', 'new-share')
      else store.removeShareAssociation('key')
    }).toThrow('原子替换失败')
    expect(readFileSync(filePath, 'utf8')).toBe(previous)
    expect(store.getShareAssociation('key')).toEqual(association)
    expect(new OrgStateStore().getShareAssociation('key')).toEqual(association)
    expect(store.get('demo')?.skillId).toBe('s')
    expect(readdirSync(join(tmp, 'Sensitive', 'Enterprise'))).toEqual(['org-state.json'])

    store.setShareAssociation('other', 'other-share')
    expect(new OrgStateStore().getShareAssociation('key')).toEqual(association)
  })

  it('旧字符串关联迁移为未确认且不丢失其他状态', () => {
    const store = new OrgStateStore()
    store.upsert('demo', { version: '1', contentHash: 'h', skillId: 's', folderName: 'd' })
    const path = join(tmp, 'Sensitive', 'Enterprise', 'org-state.json')
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    raw.knowledgeShares = { key: 's1' }
    writeFileSync(path, JSON.stringify(raw))
    const reloaded = new OrgStateStore()
    expect(reloaded.getShareAssociation('key')).toEqual({ shareId: 's1', completion: 'unconfirmed', files: [] })
    expect(reloaded.get('demo')?.skillId).toBe('s')
  })

  it('初始状态为空 map（文件不存在）', () => {
    const store = new OrgStateStore()
    expect(store.get('any-slug')).toBeUndefined()
    expect(Object.keys(store.snapshot()).length).toBe(0)
  })

  it('upsert 后 get 返回记录并持久化到文件', () => {
    const store = new OrgStateStore()
    store.upsert('demo-skill', { version: '1.0.0', contentHash: 'abc123', skillId: 's1', folderName: 'demo-skill' })

    expect(store.get('demo-skill')?.version).toBe('1.0.0')
    expect(store.get('demo-skill')?.enabled).toBe(true)

    // 重新加载验证持久化
    const reloaded = new OrgStateStore()
    expect(reloaded.get('demo-skill')?.contentHash).toBe('abc123')
    expect(existsSync(join(tmp, 'Sensitive', 'Enterprise', 'org-state.json'))).toBe(true)
  })

  it('remove 删除记录且持久化', () => {
    const store = new OrgStateStore()
    store.upsert('demo-skill', { version: '1', contentHash: 'h', skillId: 's1', folderName: 'd' })
    store.remove('demo-skill')

    expect(store.get('demo-skill')).toBeUndefined()
    const reloaded = new OrgStateStore()
    expect(reloaded.get('demo-skill')).toBeUndefined()
  })

  it('setEnabled 只翻转 enabled 字段', () => {
    const store = new OrgStateStore()
    store.upsert('demo', { version: '1', contentHash: 'h', skillId: 's1', folderName: 'd', enabled: true })
    store.setEnabled('demo', false)

    expect(store.get('demo')?.enabled).toBe(false)
    expect(store.get('demo')?.skillId).toBe('s1')
  })

  it('损坏的 state 文件安全降级为空', () => {
    const entDir = join(tmp, 'Sensitive', 'Enterprise')
    mkdirSync(entDir, { recursive: true })
    writeFileSync(join(entDir, 'org-state.json'), '{not json')
    const store = new OrgStateStore()
    expect(Object.keys(store.snapshot()).length).toBe(0)
  })

  it('不可用标记：markUnavailable/markAvailable', () => {
    const store = new OrgStateStore()
    store.upsert('demo', { version: '1', contentHash: 'h', skillId: 's1', folderName: 'd' })
    store.markUnavailable()
    expect(store.snapshotUnavailable()).toBe(true)

    const reloaded = new OrgStateStore()
    expect(reloaded.snapshotUnavailable()).toBe(true)
    reloaded.markAvailable()
    expect(new OrgStateStore().snapshotUnavailable()).toBe(false)
  })

  it('fails closed when group, generation, issuer, or entitlement no longer matches the current lease', () => {
    const store = new OrgStateStore()
    store.recordConnectorEntitlement('weather', {
      issuerId: 'issuer-1',
      groupId: 'group-a',
      resourceId: 'weather',
      entitlement: 'active',
      generation: 4,
      localResourceId: 'mcp-1'
    })
    store.upsertConnector('weather', { mcpId: 'mcp-1', baseUrl: 'https://weather.example' })

    expect(store.isConnectorAllowed('mcp-1', { issuerId: 'issuer-1', groupId: 'group-a', generation: 4 })).toBe(true)
    expect(store.isConnectorAllowed('mcp-1', { issuerId: 'issuer-1', groupId: 'group-b', generation: 4 })).toBe(false)
    expect(store.isConnectorAllowed('mcp-1', { issuerId: 'issuer-1', groupId: 'group-a', generation: 5 })).toBe(false)
    expect(store.isConnectorAllowed('mcp-1', { issuerId: 'issuer-2', groupId: 'group-a', generation: 4 })).toBe(false)

    store.invalidateEntitlements(5)
    expect(store.isConnectorAllowed('mcp-1', { issuerId: 'issuer-1', groupId: 'group-a', generation: 5 })).toBe(false)
  })

  it('filters enterprise skills by their current entitlement while leaving local skills alone', () => {
    const store = new OrgStateStore()
    store.recordSkillEntitlement('review', {
      issuerId: 'issuer-1',
      groupId: 'group-a',
      resourceId: 'review',
      entitlement: 'active',
      generation: 2
    })

    expect(store.isSkillAllowed('org-skill:review', { issuerId: 'issuer-1', groupId: 'group-a', generation: 2 })).toBe(
      true
    )
    expect(store.isSkillAllowed('org-skill:review', { issuerId: 'issuer-1', groupId: 'group-b', generation: 2 })).toBe(
      false
    )
    expect(store.isSkillAllowed('https://example.test/local', null)).toBe(true)
  })

  it('文件内容校验：记录字段完整', () => {
    const store = new OrgStateStore()
    store.upsert('demo', { version: '2.0.0', contentHash: 'cafe', skillId: 'id9', folderName: 'Demo' })
    const raw = JSON.parse(readFileSync(join(tmp, 'Sensitive', 'Enterprise', 'org-state.json'), 'utf8'))
    expect(raw.skills.demo).toEqual({
      version: '2.0.0',
      contentHash: 'cafe',
      skillId: 'id9',
      folderName: 'Demo',
      enabled: true
    })
  })

  // [enterprise] C4 墓碑：删除记录移入 deletedSkills（含删除时 hash），供 startupScan
  // 防复活判断（同 hash 不重装、企业推新版 hash 变化时覆盖重装）。原 remove 逻辑保留。
  it('markDeleted 写入墓碑并持久化，含删除时 contentHash', () => {
    const store = new OrgStateStore()
    store.upsert('demo', { version: '1', contentHash: 'h1', skillId: 's1', folderName: 'd' })
    store.markDeleted('demo', 'h1')

    expect(store.deletedHash('demo')).toBe('h1')
    const reloaded = new OrgStateStore()
    expect(reloaded.deletedHash('demo')).toBe('h1')
    // 墓碑后原记录仍在（installedSlugs 语义由 OrgSkillCatalog 过滤，store 不管）
    expect(reloaded.get('demo')?.skillId).toBe('s1')
  })

  it('clearDeleted 移除墓碑且持久化', () => {
    const store = new OrgStateStore()
    store.markDeleted('demo', 'h1')
    store.clearDeleted('demo')

    expect(store.deletedHash('demo')).toBeUndefined()
    const reloaded = new OrgStateStore()
    expect(reloaded.deletedHash('demo')).toBeUndefined()
  })

  it('markDeleted 幂等：重复标记以后一次 hash 为准', () => {
    const store = new OrgStateStore()
    store.markDeleted('demo', 'h1')
    store.markDeleted('demo', 'h2')
    expect(store.deletedHash('demo')).toBe('h2')
  })

  // [enterprise] C4 连接器墓碑：与技能墓碑同构（slug → 删除时 baseUrl），
  // 防止「用户删除 → 企业临时下架清映射 → 重新上架自动重装」的复活路径。
  it('markConnectorDeleted 写入连接器墓碑并持久化', () => {
    const store = new OrgStateStore()
    store.upsertConnector('weather', { mcpId: 'mcp-1', baseUrl: 'http://w.example/sse' })
    store.markConnectorDeleted('weather', 'http://w.example/sse')

    expect(store.deletedConnectorBaseUrl('weather')).toBe('http://w.example/sse')
    const reloaded = new OrgStateStore()
    expect(reloaded.deletedConnectorBaseUrl('weather')).toBe('http://w.example/sse')
    // 墓碑后原映射仍在（compareAndSync 语义由 OrgMcpCatalog 过滤，store 不管）
    expect(reloaded.getConnector('weather')?.mcpId).toBe('mcp-1')
  })

  it('clearConnectorDeleted 移除连接器墓碑且持久化', () => {
    const store = new OrgStateStore()
    store.markConnectorDeleted('weather', 'http://w.example/sse')
    store.clearConnectorDeleted('weather')

    expect(store.deletedConnectorBaseUrl('weather')).toBeUndefined()
    const reloaded = new OrgStateStore()
    expect(reloaded.deletedConnectorBaseUrl('weather')).toBeUndefined()
  })

  it('markConnectorDeleted 幂等：重复标记以后一次 baseUrl 为准', () => {
    const store = new OrgStateStore()
    store.markConnectorDeleted('weather', 'http://w1.example/sse')
    store.markConnectorDeleted('weather', 'http://w2.example/sse')
    expect(store.deletedConnectorBaseUrl('weather')).toBe('http://w2.example/sse')
  })

  // 回归：orgStateStore 是模块顶层单例，模块加载早于 application.initPathRegistry()。
  // 若构造函数里立即 getPath() 会抛错 → 静默重置为空 → startupScan C1 误判"本地无记录"全部重装。
  // 单例必须惰性初始化（首次访问时才读文件），getPath 只发生在真正需要时。
  it('resetProfileCache 后从新的 profile 路径重新加载且不泄漏旧内存', () => {
    const store = new OrgStateStore()
    store.upsert('profile-a', { version: '1', contentHash: 'a', skillId: 'a', folderName: 'a' })

    const profileB = mkdtempSync(join(tmpdir(), 'org-state-profile-b-'))
    applicationMock.getPath.mockReturnValue(join(profileB, 'Sensitive', 'Enterprise', 'org-state.json'))
    try {
      store.resetProfileCache()
      expect(store.get('profile-a')).toBeUndefined()
      store.upsert('profile-b', { version: '1', contentHash: 'b', skillId: 'b', folderName: 'b' })
      expect(store.get('profile-b')?.skillId).toBe('b')
    } finally {
      rmSync(profileB, { recursive: true, force: true })
    }
  })

  it('模块单例是惰性初始化：getPath 在首次数据访问时才调用', async () => {
    vi.resetModules()
    applicationMock.getPath.mockClear()

    // 模拟路径注册表未初始化：此时调用 getPath 应抛错（与启动时一致）
    applicationMock.getPath.mockImplementation(() => {
      throw new Error('application.getPath called before application.initPathRegistry() ran')
    })

    const { orgStateStore } = await import('@main/enterprise/OrgStateStore')
    // 模块加载本身不触发 getPath（不会抛）——这是本次修复的核心断言
    expect(applicationMock.getPath).not.toHaveBeenCalled()

    // 恢复路径后首次数据访问正常工作
    applicationMock.getPath.mockImplementation((key: string) =>
      key === 'feature.enterprise.state_file'
        ? join(tmp, 'Sensitive', 'Enterprise', 'org-state.json')
        : Promise.reject(new Error(`unexpected: ${key}`))
    )
    orgStateStore.upsert('lazy-demo', { version: '1', contentHash: 'h', skillId: 's', folderName: 'd' })
    expect(applicationMock.getPath).toHaveBeenCalled()
    expect(orgStateStore.get('lazy-demo')?.skillId).toBe('s')
  })
})
