import type * as NodeFs from 'node:fs'
import { createReadStream } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { Readable } from 'node:stream'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { encodeOrgId } from '../../../shared/data/types/enterpriseKnowledge'
import { enterpriseKnowledgeErrorCodes as E } from '../../../shared/ipc/errors/enterpriseKnowledge'
import { JavaKnowledgeError } from '../JavaKnowledgeClient'
import { OrgApiHttpError } from '../OrgApiClient'
import { OrgKnowledgeService } from '../OrgKnowledgeService'
import { orgStateStore } from '../OrgStateStore'

// --- 与现有 OrgKnowledgeService.test.ts 一致的最小模块桩，保证主进程模块可加载 ---
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof NodeFs>()),
  createReadStream: vi.fn(() => Readable.from([Buffer.from('file-bytes')]))
}))

vi.mock('../KnowledgeSourceBindings', () => ({
  replaceKnowledgeSourceBindings: vi.fn(),
  removeKnowledgeSourceBindings: vi.fn(),
  captureKnowledgeSourceBindings: vi.fn(() => ({ assistantIds: ['assistant'], agentIds: [] }))
}))

const { getSubtreeItems, recoveryItems } = vi.hoisted(() => ({
  getSubtreeItems: vi.fn((): unknown[] => []),
  recoveryItems: {
    getItemsByBaseId: vi.fn((): any[] => []),
    getById: vi.fn(),
    createActive: vi.fn(),
    updateStatus: vi.fn()
  }
}))
vi.mock('@data/services/KnowledgeItemService', () => ({ knowledgeItemService: { getSubtreeItems, ...recoveryItems } }))

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof NodeFsPromises>()),
  readFile: vi.fn().mockResolvedValue(Buffer.from('file-bytes')),
  stat: vi.fn().mockResolvedValue({ size: 10, isFile: () => true })
}))

vi.mock('../OrgStateStore', () => ({
  OrgStateStore: class {},
  orgStateStore: {
    getFirstShareUpload: vi.fn().mockReturnValue(undefined),
    setFirstShareUpload: vi.fn(),
    getShareAssociation: vi.fn().mockReturnValue(undefined),
    getShareAssociations: vi.fn(() => ({})),
    setShareAssociation: vi.fn(),
    removeShareAssociation: vi.fn(),
    clearShare: vi.fn(),
    getCloudRecovery: vi.fn(),
    setCloudRecovery: vi.fn(),
    moveOwnedSpace: vi.fn(),
    getCloudRecoveries: vi.fn(() => ({})),
    getOwnedSpaceGroups: vi.fn(() => ({}))
  }
}))

// --- 测试用 ID（合法 UUID / 32 位 hex，便于编解码对称） ---
const KID = '11111111-1111-4111-8111-111111111111'
const FID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const CID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const OTHER_FID = 'cccccccccccccccccccccccccccccccc'

const lease = { generation: 1, issuerId: 'server-1', groupId: 'g', userId: '7' }

function makeJavaKnowledge() {
  return {
    getCatalog: vi.fn(),
    listFiles: vi.fn(),
    getFile: vi.fn(),
    preview: vi.fn(),
    listChunks: vi.fn(),
    search: vi.fn(),
    read: vi.fn(),
    listShares: vi.fn(),
    listMembers: vi.fn()
  }
}

function makeService(javaKnowledge: ReturnType<typeof makeJavaKnowledge>) {
  const apiClient = { javaKnowledge }
  const auth = {
    acquireLease: vi.fn(() => ({ ...lease })),
    assertLease: vi.fn(),
    apiClient
  }
  return { service: new OrgKnowledgeService(auth as never), auth }
}

describe('协作者面板解析本地共享关联', () => {
  const localId = '33333333-3333-4333-8333-333333333333'
  const key = JSON.stringify([lease.issuerId, lease.userId, lease.groupId, localId])
  const completed = { shareId: KID, completion: 'completed', files: [{ status: 'success' }] }
  let java: ReturnType<typeof makeJavaKnowledge> & { memberOptions: ReturnType<typeof vi.fn> }
  let built: ReturnType<typeof makeService>

  beforeEach(() => {
    java = {
      ...makeJavaKnowledge(),
      memberOptions: vi.fn().mockResolvedValue({
        items: [
          { userId: 7, username: 'self' },
          { userId: 50, username: 'other', showName: '同事' }
        ],
        total: 2,
        page: 2,
        pageSize: 10
      })
    }
    built = makeService(java)
    vi.mocked(orgStateStore.getShareAssociation).mockReset()
    vi.mocked(orgStateStore.setShareAssociation).mockClear()
    vi.mocked(orgStateStore.removeShareAssociation).mockClear()
    vi.mocked(orgStateStore.clearShare).mockClear()
  })

  it('只用当前 lease 的 syncKey 将本地 UUID 解析为云端 ID', async () => {
    vi.mocked(orgStateStore.getShareAssociation).mockImplementation((input) =>
      input === key ? (completed as never) : undefined
    )
    const result = await built.service.collaborators({ baseId: localId, keyword: '同', page: 2, pageSize: 10 })
    expect(orgStateStore.getShareAssociation).toHaveBeenCalledExactlyOnceWith(key)
    expect(java.memberOptions).toHaveBeenCalledExactlyOnceWith(
      { knowledgeId: KID, keyword: '同', page: 2, pageSize: 10 },
      expect.any(Function)
    )
    expect(result).toMatchObject({ items: [{ id: 50, username: 'other' }], total: 2, page: 2, pageSize: 10 })
    expect(java.getCatalog).not.toHaveBeenCalled()
    expect(orgStateStore.setShareAssociation).not.toHaveBeenCalled()
    expect(orgStateStore.removeShareAssociation).not.toHaveBeenCalled()
    expect(orgStateStore.clearShare).not.toHaveBeenCalled()
  })

  it.each([
    undefined,
    { ...completed, completion: 'incomplete' },
    { ...completed, completion: 'unconfirmed' },
    { ...completed, files: [{ status: 'failure' }] }
  ])('缺失或未完成关联明确报错且保留记录：%j', async (association) => {
    vi.mocked(orgStateStore.getShareAssociation).mockReturnValue(association as never)
    await expect(built.service.collaborators({ baseId: localId })).rejects.toMatchObject({
      code: E.ORGKB_SHARE_INCOMPLETE,
      message: expect.stringContaining('尚未完成共享关联')
    })
    expect(java.memberOptions).not.toHaveBeenCalled()
    expect(java.getCatalog).not.toHaveBeenCalled()
    expect(orgStateStore.setShareAssociation).not.toHaveBeenCalled()
    expect(orgStateStore.removeShareAssociation).not.toHaveBeenCalled()
    expect(orgStateStore.clearShare).not.toHaveBeenCalled()
  })

  it.each(['issuerId', 'userId', 'groupId'] as const)('不得复用其他 %s 的已完成关联', async (field) => {
    const foreign = { ...lease, [field]: 'other' }
    const foreignKey = JSON.stringify([foreign.issuerId, foreign.userId, foreign.groupId, localId])
    vi.mocked(orgStateStore.getShareAssociation).mockImplementation((input) =>
      input === foreignKey ? (completed as never) : undefined
    )
    await expect(built.service.collaborators({ baseId: localId })).rejects.toMatchObject({
      code: E.ORGKB_SHARE_INCOMPLETE
    })
    expect(orgStateStore.getShareAssociation).toHaveBeenCalledWith(key)
    expect(java.memberOptions).not.toHaveBeenCalled()
    expect(java.getCatalog).not.toHaveBeenCalled()
  })

  it('本地关联查询在 token 解析后切号不得发送', async () => {
    vi.mocked(orgStateStore.getShareAssociation).mockReturnValue(completed as never)
    const sent = vi.fn()
    java.memberOptions.mockImplementation(async (_params, beforeSend) => {
      built.auth.assertLease.mockImplementation(() => {
        throw new Error('切号')
      })
      beforeSend()
      sent()
    })
    await expect(built.service.collaborators({ baseId: localId })).rejects.toMatchObject({ code: E.ORGKB_UNAUTHORIZED })
    expect(sent).not.toHaveBeenCalled()
    expect(built.auth.acquireLease).toHaveBeenCalledTimes(1)
  })
})

function space(
  over: Partial<{
    id: string
    name: string
    description: string | null
    category: 'PUBLIC' | 'OWNED' | 'SHARED' | null
    updateTime: string | null
    allowLocalFileUpload: boolean | null
    canDownload: boolean | null
  }> = {}
) {
  return {
    id: KID,
    tenantId: null,
    name: '知识库',
    description: null,
    ownerId: null,
    ownerName: null,
    visibility: null,
    category: 'OWNED' as const,
    creationOrigin: null,
    publicRegistered: null,
    accessSources: [],
    source: null,
    sourceKnowledgeId: null,
    accessRule: null,
    editable: null,
    canManageMembers: null,
    canManageShares: null,
    canDownload: null,
    spaceKind: null,
    allowLocalFileUpload: null,
    storageQuota: null,
    manageable: null,
    createTime: null,
    updateTime: null,
    ...over
  }
}

function file(
  over: Partial<{
    fileId: string
    parentId: string | null
    name: string
    directory: boolean
    hasOriginalFile: boolean | null
    parseStatus: string | null
    createTime: string | null
    updateTime: string | null
  }> = {}
) {
  return {
    knowledgeId: KID,
    fileId: FID,
    parentId: null,
    name: '文件.txt',
    directory: false,
    fileCategory: null,
    mimeType: null,
    hasOriginalFile: null,
    fileSize: null,
    fileHash: null,
    parseStatus: null,
    errorMessage: null,
    parsedAt: null,
    createTime: null,
    updateTime: null,
    ...over
  }
}

const javaKnowledge = makeJavaKnowledge()
let service: OrgKnowledgeService

beforeEach(() => {
  vi.mocked(createReadStream).mockImplementation(() => Readable.from([Buffer.from('file-bytes')]) as never)
  vi.mocked(orgStateStore.getShareAssociations).mockReturnValue({})
  vi.mocked(orgStateStore.getShareAssociation).mockReturnValue(undefined)
  for (const fn of Object.values(javaKnowledge)) fn.mockReset()
  const built = makeService(javaKnowledge)
  service = built.service
})

describe('Java 原件预览归属', () => {
  it('携带知识库归属读取原件，不使用旧接口', async () => {
    javaKnowledge.getFile.mockResolvedValue(file({ hasOriginalFile: true, name: 'sample.json' }))
    javaKnowledge.preview.mockResolvedValue({ bytes: Buffer.from('{"code":200}'), contentType: 'application/json' })
    const result = await service.preview({ baseId: encodeOrgId(KID), fileId: encodeOrgId(FID) })
    expect(result).toMatchObject({ kind: 'text', fileName: 'sample.json', content: '{"code":200}' })
    expect(javaKnowledge.getFile).toHaveBeenCalledWith(KID, FID)
    expect(javaKnowledge.preview).toHaveBeenCalledWith(KID, FID)
  })

  it('通用二进制 PDF 必须由文件名和签名共同识别', async () => {
    javaKnowledge.getFile.mockResolvedValue(file({ hasOriginalFile: true, name: 'report.pdf' }))
    javaKnowledge.preview.mockResolvedValue({
      bytes: Buffer.from('%PDF-1.7\n%original'),
      contentType: 'application/octet-stream'
    })
    expect(await service.preview({ baseId: encodeOrgId(KID), fileId: encodeOrgId(FID) })).toMatchObject({
      kind: 'inline',
      mimeType: 'application/pdf'
    })
    expect(javaKnowledge.read).not.toHaveBeenCalled()
  })

  it('缺 MIME 的 Markdown 原件直接读取而非取解析正文', async () => {
    javaKnowledge.getFile.mockResolvedValue(file({ hasOriginalFile: true, name: 'note.md' }))
    javaKnowledge.preview.mockResolvedValue({ bytes: Buffer.from('# 原始 Markdown'), contentType: '' })
    expect(await service.preview({ baseId: encodeOrgId(KID), fileId: encodeOrgId(FID) })).toMatchObject({
      kind: 'text',
      content: '# 原始 Markdown'
    })
    expect(javaKnowledge.read).not.toHaveBeenCalled()
  })

  it('超过既有 xlsx 20MiB 边界时不传入内存查看器', async () => {
    javaKnowledge.getFile.mockResolvedValue(file({ hasOriginalFile: true, name: 'large.xlsx' }))
    javaKnowledge.preview.mockResolvedValue({
      bytes: Buffer.alloc(20 * 1024 * 1024 + 1),
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    })
    await expect(service.preview({ baseId: encodeOrgId(KID), fileId: encodeOrgId(FID) })).rejects.toThrow('预览')
  })

  it('文件元数据归属不符时拒绝预览', async () => {
    javaKnowledge.getFile.mockResolvedValue({ ...file({ hasOriginalFile: true }), knowledgeId: 'other' })
    await expect(service.preview({ baseId: encodeOrgId(KID), fileId: encodeOrgId(FID) })).rejects.toThrow('原件不可用')
    expect(javaKnowledge.preview).not.toHaveBeenCalled()
  })

  it('无原件时不发出文件预览请求', async () => {
    javaKnowledge.getFile.mockResolvedValue(file({ hasOriginalFile: false }))
    await expect(service.preview({ baseId: encodeOrgId(KID), fileId: encodeOrgId(FID) })).rejects.toThrow('原件不可用')
    expect(javaKnowledge.preview).not.toHaveBeenCalled()
  })
})

describe('OrgKnowledgeService 只读迁移：catalog 走 Java 客户端', () => {
  it('按服务端 category 严格分桶 PUBLIC/OWNED/SHARED，不使用 visibility', async () => {
    javaKnowledge.getCatalog.mockResolvedValue([
      space({ id: 'p-1', category: 'PUBLIC', name: '公开' }),
      space({ id: 's-1', category: 'SHARED', name: '共享' }),
      space({ id: 'o-1', category: 'OWNED', name: '自有' })
    ])
    const catalog = await service.catalog()
    expect(catalog.public).toHaveLength(1)
    expect(catalog.public[0].id.startsWith('orgkb:')).toBe(true)
    expect(catalog.public[0].name).toBe('公开')
    expect(catalog.shared).toHaveLength(1)
    expect(catalog.shared[0].name).toBe('共享')
    expect(catalog.owned).toHaveLength(1)
    expect(catalog.owned[0].name).toBe('自有')
  })

  it('保留 owned 的本地关联匹配与 shareCompleted', async () => {
    const key = JSON.stringify(['server-1', '7', 'g', 'local-1'])
    vi.mocked(orgStateStore.getShareAssociations).mockReturnValue({
      [key]: { shareId: KID, completion: 'completed' }
    } as never)
    javaKnowledge.getCatalog.mockResolvedValue([space({ id: KID, category: 'OWNED' })])
    const catalog = await service.catalog()
    expect(catalog.owned[0]).toMatchObject({ localBaseId: 'local-1', shareCompleted: true, hasShareEvidence: true })
  })

  it('owned 非 shareCompleted 时由 listShares 的 receivable 给出证据', async () => {
    javaKnowledge.getCatalog.mockResolvedValue([space({ id: KID, category: 'OWNED' })])
    javaKnowledge.listShares.mockResolvedValue([{ knowledgeId: KID, receivable: true }])
    javaKnowledge.listMembers.mockResolvedValue([])
    const catalog = await service.catalog()
    expect(catalog.owned[0].hasShareEvidence).toBe(true)
    expect(javaKnowledge.listShares).toHaveBeenCalledWith(KID)
  })

  it('owned 非 shareCompleted 时由非本人有效 viewer 成员给出证据', async () => {
    javaKnowledge.getCatalog.mockResolvedValue([space({ id: KID, category: 'OWNED' })])
    javaKnowledge.listShares.mockResolvedValue([{ knowledgeId: KID, receivable: false }])
    javaKnowledge.listMembers.mockResolvedValue([
      { userId: 999, role: 'viewer', status: 'active', expiresAt: null, activeTenantMember: true }
    ])
    const catalog = await service.catalog()
    expect(catalog.owned[0].hasShareEvidence).toBe(true)
  })

  it('非 viewer / 本人 / 非租户成员不计为证据', async () => {
    javaKnowledge.getCatalog.mockResolvedValue([space({ id: KID, category: 'OWNED' })])
    javaKnowledge.listShares.mockResolvedValue([{ knowledgeId: KID, receivable: false }])
    javaKnowledge.listMembers.mockResolvedValue([
      { userId: 999, role: 'editor', status: 'active', expiresAt: null, activeTenantMember: true },
      { userId: Number(lease.userId), role: 'viewer', status: 'active', expiresAt: null, activeTenantMember: true },
      { userId: 998, role: 'viewer', status: 'active', expiresAt: null, activeTenantMember: false }
    ])
    const catalog = await service.catalog()
    expect(catalog.owned[0].hasShareEvidence).toBe(false)
  })

  it('证据查询非认证失败时证据未知（undefined）且保留基础目录', async () => {
    javaKnowledge.getCatalog.mockResolvedValue([
      space({ id: 'p-1', category: 'PUBLIC' }),
      space({ id: KID, category: 'OWNED' })
    ])
    javaKnowledge.listShares.mockRejectedValue(new Error('network'))
    javaKnowledge.listMembers.mockResolvedValue([])
    const catalog = await service.catalog()
    expect(catalog.public).toHaveLength(1)
    expect(catalog.owned[0].hasShareEvidence).toBeUndefined()
  })

  it('Java会话失效不能被分享证据查询吞掉', async () => {
    javaKnowledge.getCatalog.mockResolvedValue([space({ id: KID, category: 'OWNED' })])
    javaKnowledge.listShares.mockRejectedValue(new JavaKnowledgeError(10008))
    javaKnowledge.listMembers.mockResolvedValue([])
    await expect(service.catalog()).rejects.toMatchObject({ code: 10008 })
  })

  it('证据查询认证错误（401）阻断 catalog', async () => {
    javaKnowledge.getCatalog.mockResolvedValue([space({ id: KID, category: 'OWNED' })])
    javaKnowledge.listShares.mockRejectedValue(new OrgApiHttpError(401, 'unauthorized'))
    await expect(service.catalog()).rejects.toMatchObject({ status: 401 })
  })
})

describe('OrgKnowledgeService 只读迁移：listItems 走 Java 客户端', () => {
  it('Java file id 同时作 item/documentId；目录 documentId 为 null；ready→completed', async () => {
    javaKnowledge.listFiles.mockResolvedValue({
      items: [
        file({ fileId: FID, name: '文件', directory: false, parseStatus: 'ready', hasOriginalFile: true }),
        file({ fileId: OTHER_FID, name: '目录', directory: true, parseStatus: null })
      ],
      total: 2,
      page: 1,
      pageSize: 100
    })
    const page = await service.listItems(encodeOrgId(KID))
    expect(page.items).toHaveLength(2)
    const f = page.items.find((i) => i.type === 'file')!
    expect(f.id).toBe(encodeOrgId(FID))
    expect(f.documentId).toBe(encodeOrgId(FID))
    expect(f.fileId).toBe(encodeOrgId(FID))
    expect(f.status).toBe('completed')
    expect(f.hasOriginalFile).toBe(true)
    const d = page.items.find((i) => i.type === 'directory')!
    expect(d.documentId).toBeNull()
    expect(d.status).toBe('completed')
  })

  it('非 ready 的 parseStatus 原样保留，不伪造完成', async () => {
    javaKnowledge.listFiles.mockResolvedValue({
      items: [file({ fileId: FID, parseStatus: 'parsing' })],
      total: 1,
      page: 1,
      pageSize: 100
    })
    const page = await service.listItems(encodeOrgId(KID))
    expect(page.items[0].status).toBe('parsing')
  })

  it('非法数字 cursor 返回 BAD_INPUT', async () => {
    await expect(service.listItems(encodeOrgId(KID), 'abc')).rejects.toMatchObject({ code: E.ORGKB_BAD_INPUT })
    await expect(service.listItems(encodeOrgId(KID), '0')).rejects.toMatchObject({ code: E.ORGKB_BAD_INPUT })
  })

  it('nextCursor 由 page*pageSize<total 推导', async () => {
    javaKnowledge.listFiles.mockResolvedValue({ items: [file()], total: 150, page: 1, pageSize: 100 })
    const page = await service.listItems(encodeOrgId(KID))
    expect(page.nextCursor).toBe('2')
    javaKnowledge.listFiles.mockResolvedValue({ items: [file()], total: 1, page: 1, pageSize: 100 })
    const last = await service.listItems(encodeOrgId(KID))
    expect(last.nextCursor).toBeNull()
  })
})

describe('OrgKnowledgeService 只读迁移：listDirectoryItems 走 Java 客户端', () => {
  it('无 parentId 时使用 rootOnly 并校验根归属', async () => {
    javaKnowledge.listFiles.mockResolvedValue({
      items: [file({ fileId: FID, parentId: null })],
      total: 1,
      page: 1,
      pageSize: 100
    })
    const page = await service.listDirectoryItems(encodeOrgId(KID))
    expect(javaKnowledge.listFiles).toHaveBeenCalledWith(KID, { page: 1, rootOnly: true, parentId: undefined })
    expect(page.items[0].parentId).toBeNull()
  })

  it('有 parentId 时按 parentId 过滤并校验归属', async () => {
    javaKnowledge.listFiles.mockResolvedValue({
      items: [file({ fileId: FID, parentId: OTHER_FID })],
      total: 1,
      page: 1,
      pageSize: 100
    })
    const page = await service.listDirectoryItems(encodeOrgId(KID), null, encodeOrgId(OTHER_FID))
    expect(javaKnowledge.listFiles).toHaveBeenCalledWith(KID, { page: 1, rootOnly: false, parentId: OTHER_FID })
    expect(page.items[0].parentId).toBe(encodeOrgId(OTHER_FID))
  })

  it('parent 归属不匹配（rootOnly 下出现非根条目）视为协议错误', async () => {
    javaKnowledge.listFiles.mockResolvedValue({
      items: [file({ fileId: FID, parentId: OTHER_FID })],
      total: 1,
      page: 1,
      pageSize: 100
    })
    await expect(service.listDirectoryItems(encodeOrgId(KID))).rejects.toMatchObject({ code: E.ORGKB_PROTOCOL })
  })

  it('parentId 过滤下条目 parent 不相等视为协议错误', async () => {
    javaKnowledge.listFiles.mockResolvedValue({
      items: [file({ fileId: FID, parentId: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' })],
      total: 1,
      page: 1,
      pageSize: 100
    })
    await expect(service.listDirectoryItems(encodeOrgId(KID), null, encodeOrgId(OTHER_FID))).rejects.toMatchObject({
      code: E.ORGKB_PROTOCOL
    })
  })
})

describe('OrgKnowledgeService 只读迁移：listChunks 走 Java 客户端', () => {
  it('正常映射；缺失 chunkIndex 视为协议错误', async () => {
    javaKnowledge.listChunks.mockResolvedValue({
      items: [
        { knowledgeId: KID, fileId: FID, chunkId: CID, chunkIndex: 3, content: '正文', tokenCount: 1, chunkType: null }
      ],
      total: 1,
      page: 1,
      pageSize: 100
    })
    const page = await service.listChunks(encodeOrgId(KID), encodeOrgId(FID))
    expect(page.chunks[0]).toMatchObject({
      id: encodeOrgId(CID),
      itemId: encodeOrgId(FID),
      documentId: encodeOrgId(FID),
      chunkIndex: 3,
      content: '正文'
    })
  })

  it('chunkIndex 为 null 时协议错误，不伪造', async () => {
    javaKnowledge.listChunks.mockResolvedValue({
      items: [
        {
          knowledgeId: KID,
          fileId: FID,
          chunkId: CID,
          chunkIndex: null,
          content: '正文',
          tokenCount: 1,
          chunkType: null
        }
      ],
      total: 1,
      page: 1,
      pageSize: 100
    })
    await expect(service.listChunks(encodeOrgId(KID), encodeOrgId(FID))).rejects.toMatchObject({
      code: E.ORGKB_PROTOCOL
    })
  })
})

describe('OrgKnowledgeService 只读迁移：search 走 Java 客户端', () => {
  it('正常映射；title 可空映射为 ""', async () => {
    javaKnowledge.search.mockResolvedValue({
      hits: [
        {
          knowledgeId: KID,
          fileId: FID,
          chunkId: CID,
          title: null,
          content: '内容',
          score: 0.9
        }
      ],
      modeFallback: null
    })
    const result = await service.search({ baseIds: [encodeOrgId(KID)], query: '关键词' })
    expect(result.chunks[0]).toMatchObject({
      chunkId: encodeOrgId(CID),
      baseId: encodeOrgId(KID),
      documentId: encodeOrgId(FID),
      title: '',
      content: '内容',
      score: 0.9
    })
  })

  it('缺少必要字段（fileId 为 null）视为协议错误，不伪造 id', async () => {
    javaKnowledge.search.mockResolvedValue({
      hits: [{ knowledgeId: KID, fileId: null, chunkId: CID, title: 't', content: 'c', score: 0.5 }],
      modeFallback: null
    })
    await expect(service.search({ baseIds: [encodeOrgId(KID)], query: '关键词' })).rejects.toMatchObject({
      code: E.ORGKB_PROTOCOL
    })
  })

  it('缺少 score 视为协议错误，不伪造 score', async () => {
    javaKnowledge.search.mockResolvedValue({
      hits: [{ knowledgeId: KID, fileId: FID, chunkId: CID, title: 't', content: 'c', score: null }],
      modeFallback: null
    })
    await expect(service.search({ baseIds: [encodeOrgId(KID)], query: '关键词' })).rejects.toMatchObject({
      code: E.ORGKB_PROTOCOL
    })
  })
})

describe('OrgKnowledgeService 只读迁移：read 走 Java 客户端', () => {
  it('正常映射；title 可空映射为 ""，truncated 缺失默认 false', async () => {
    javaKnowledge.read.mockResolvedValue({
      knowledgeId: KID,
      fileId: FID,
      title: null,
      content: '正文内容',
      totalChars: 10,
      truncated: null
    })
    const result = await service.read({ baseId: encodeOrgId(KID), documentId: encodeOrgId(FID) })
    expect(result).toMatchObject({
      documentId: encodeOrgId(FID),
      title: '',
      content: '正文内容',
      totalChars: 10,
      truncated: false
    })
  })
})
