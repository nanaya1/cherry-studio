import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { application } from '@application'

import { encodeOrgId } from '../../../shared/data/types/enterpriseKnowledge'
import { OrgKnowledgeService } from '../OrgKnowledgeService'
import { orgStateStore } from '../OrgStateStore'

vi.mock('@main/i18n', async () => {
  const { default: messages } = await import('../../i18n/locales/zh-cn.json')
  return { t: (key: string) => messages[key as keyof typeof messages] }
})

vi.mock('../KnowledgeSourceBindings', () => ({
  replaceKnowledgeSourceBindings: vi.fn(),
  removeKnowledgeSourceBindings: vi.fn(),
  captureKnowledgeSourceBindings: vi.fn(() => ({ assistantIds: [], agentIds: [] }))
}))
vi.mock('@data/services/KnowledgeItemService', () => ({ knowledgeItemService: { getSubtreeItems: () => [] } }))
vi.mock('../OrgStateStore', () => {
  const states = new Map(),
    shares = new Map(),
    recoveries = new Map()
  return {
    orgStateStore: {
      getFirstShareUpload: (key: string) => structuredClone(states.get(key)),
      setFirstShareUpload: (key: string, value: unknown) => states.set(key, structuredClone(value)),
      getShareAssociation: (key: string) => structuredClone(shares.get(key)),
      setShareAssociation: (key: string, value: unknown) => shares.set(key, structuredClone(value)),
      getShareAssociations: () => Object.fromEntries(shares),
      getCloudRecovery: (key: string) => structuredClone(recoveries.get(key)),
      getCloudRecoveries: () =>
        Object.fromEntries([...recoveries].map(([key, value]) => [key, structuredClone(value)])),
      setCloudRecovery: (key: string, value: unknown) => recoveries.set(key, structuredClone(value)),
      getOwnedSpaceGroups: () => ({}),
      moveOwnedSpace: vi.fn(),
      clearShare: (key: string) => {
        states.delete(key)
        shares.delete(key)
      },
      reset: () => {
        states.clear()
        shares.clear()
        recoveries.clear()
      }
    }
  }
})
const KID = '11111111-1111-4111-8111-111111111111'
const FID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const DID = 'dddddddddddddddddddddddddddddddd'
const CID = 'cccccccccccccccccccccccccccccccc'
const lease = { generation: 1, issuerId: 's', userId: '7', groupId: 'g' }
const key = JSON.stringify(['s', '7', 'g', 'local'])
const hash = createHash('sha256').update('file-bytes').digest('hex')
let root: string, path: string, service: OrgKnowledgeService
let java: any, legacy: ReturnType<typeof vi.fn>, auth: any
beforeEach(async () => {
  ;(orgStateStore as any).reset()
  root = await mkdtemp(join(tmpdir(), 'java-upload-'))
  path = join(root, '原文.txt')
  await writeFile(path, 'file-bytes')
  vi.mocked(application.get).mockReturnValue({
    listBasesForDiscovery: () => ({ items: [{ id: 'local', name: '本地库' }] }),
    listRootItems: () => [
      { id: 'dir', type: 'directory', status: 'completed', data: { source: '目录' } },
      { id: 'i', type: 'file', status: 'completed', groupId: 'dir', data: { source: '原文.txt' } }
    ],
    getFilePath: () => path,
    listItemChunks: async () => [
      { id: CID, itemId: 'i', content: '正文', metadata: { chunkIndex: 0, itemType: 'file' } }
    ]
  } as never)
  const space = { id: KID, name: '本地库', category: 'OWNED', allowLocalFileUpload: true }
  java = {
    createLocalShare: vi.fn(async (_n, _m, guard) => {
      guard()
      return space
    }),
    createFolder: vi.fn(async (_k, _n, _p, guard) => {
      guard()
      return { knowledgeId: KID, fileId: DID, parentId: null, name: '目录', directory: true }
    }),
    getSpace: vi.fn(async () => space),
    getLocalShareState: vi.fn(async () => 'ACTIVE'),
    finishLocalShareRemoval: vi.fn(async (_id, guard) => guard()),
    getCatalog: vi.fn(async () => [space]),
    getFile: vi.fn(async (_k, id) =>
      id === DID
        ? { knowledgeId: KID, fileId: DID, parentId: null, name: '目录', directory: true }
        : {
            knowledgeId: KID,
            fileId: FID,
            parentId: DID,
            name: '原文.txt',
            directory: false,
            fileHash: hash,
            parseStatus: 'ready',
            hasOriginalFile: true
          }
    ),
    listChunks: vi.fn(async () => ({
      items: [{ knowledgeId: KID, fileId: FID, chunkId: CID, chunkIndex: 0, content: '正文' }],
      total: 1,
      page: 1,
      pageSize: 100
    })),
    uploadMultipart: vi.fn(async (_url, _type, _size, body, guard) => {
      guard()
      let uploadedBytes = 0
      for await (const bytes of body(() => {}, new AbortController().signal)) {
        uploadedBytes += bytes.byteLength
      }
      expect(uploadedBytes).toBe(_size)
      return { knowledgeId: KID, fileId: FID, chunkCount: 1 }
    }),
    removeSpace: vi.fn(async (_id, guard) => {
      guard()
    }),
    listFiles: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 100 })),
    listOperations: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 100 })),
    confirmOperation: vi.fn()
  }
  legacy = vi.fn(async () => {
    throw new Error('禁止旧端点')
  })
  auth = { acquireLease: () => lease, assertLease: vi.fn(), apiClient: { javaKnowledge: java, request: legacy } }
  service = new OrgKnowledgeService(auth)
})
afterEach(async () => {
  service.dispose()
  await rm(root, { recursive: true, force: true })
})

it('首传通过 Java 建库、建目录、流式 importChunks，并核验正文后才完成', async () => {
  const result = await service.share('local')
  expect(result.completion).toBe('completed')
  expect(result.files[0].fileId).toBe(encodeOrgId(FID))
  expect(java.createLocalShare).toHaveBeenCalledWith('本地库', true, expect.any(Function))
  expect(java.createFolder).toHaveBeenCalledWith(KID, '目录', undefined, expect.any(Function))
  expect(java.uploadMultipart.mock.calls[0][0]).toBe('/api/v1/client/knowledge/file/importChunks')
  expect(legacy).not.toHaveBeenCalled()
})
it('正文错误即使数量一致也不能确认成功', async () => {
  java.listChunks.mockResolvedValue({
    items: [{ knowledgeId: KID, fileId: FID, chunkId: CID, chunkIndex: 0, content: '错误' }],
    total: 1,
    page: 1,
    pageSize: 100
  })
  await expect(
    (service as any).verifyFirstShareFile(
      KID,
      FID,
      { fileName: '原文.txt', hash, parentId: DID, chunks: [{ content: '正文', metadata: { chunk_index: 0 } }] },
      lease
    )
  ).rejects.toThrow('分块')
})
it('未知上传不得重发或凭名称认领 fileId', async () => {
  java.uploadMultipart.mockRejectedValue(new Error('连接中断'))
  await service.share('local')
  await expect(service.share('local', true)).rejects.toThrow()
  expect(java.uploadMultipart).toHaveBeenCalledTimes(1)
  expect(java.listFiles).not.toHaveBeenCalled()
  expect(legacy).not.toHaveBeenCalled()
})
it('恢复扫描通过 Java 分页，保留远端 ID 和父子关系', async () => {
  java.listFiles.mockImplementation(async (_id, options) => ({
    items: options.rootOnly
      ? [
          {
            knowledgeId: KID,
            fileId: DID,
            parentId: null,
            name: '目录',
            directory: true,
            hasOriginalFile: false,
            fileHash: null,
            updateTime: 't'
          }
        ]
      : [],
    total: options.rootOnly ? 1 : 0,
    page: 1,
    pageSize: 100
  }))
  const { recovery } = (service as any).recoveryContext(encodeOrgId(KID), lease)
  expect(await recovery.ports.scan()).toEqual([
    {
      id: DID,
      space_id: KID,
      parent_id: null,
      name: '目录',
      is_dir: true,
      has_original_file: false,
      file_hash: null,
      updated_at: 't'
    }
  ])
  expect(legacy).not.toHaveBeenCalled()
})
/* 已移除操作接口的旧用例保留；下方以本人墓碑核查及授权收尾覆盖同一业务约束。
it('可信删除操作确认 null 才允许判定删除，绝不重放 remove', async () => {
  java.getCatalog.mockResolvedValue([])
  java.listOperations.mockResolvedValue({
    items: [{ id: 42, knowledgeId: KID, operationState: 'DELETE_UNCONFIRMED' }],
    total: 1
  })
  java.confirmOperation.mockResolvedValue(null)
  const { recovery } = (service as any).recoveryContext(encodeOrgId(KID), lease)
  expect(await recovery.ports.checkSpace()).toBe(false)
  expect(java.confirmOperation).toHaveBeenCalledWith(42, expect.any(Function))
  expect(java.removeSpace).not.toHaveBeenCalled()
})
*/
it('发送前租约切换拒绝上传且不调用旧端点', async () => {
  java.createLocalShare.mockImplementation(async (_name, _mode, guard) => {
    auth.assertLease.mockImplementation(() => {
      throw new Error('切号')
    })
    guard()
  })
  await expect(service.share('local')).rejects.toThrow()
  expect(java.uploadMultipart).not.toHaveBeenCalled()
  expect(legacy).not.toHaveBeenCalled()
})
it('核验全部分页正文，不允许重复 chunkId 掩盖缺失', async () => {
  java.listChunks.mockImplementation(async (_k, _f, page) => ({
    items: [{ knowledgeId: KID, fileId: FID, chunkId: CID, chunkIndex: page - 1, content: `正文${page}` }],
    total: 2
  }))
  await expect(
    (service as any).verifyFirstShareFile(
      KID,
      FID,
      {
        fileName: '原文.txt',
        hash,
        parentId: DID,
        chunks: [
          { content: '正文1', metadata: { chunk_index: 0 } },
          { content: '正文2', metadata: { chunk_index: 1 } }
        ]
      },
      lease
    )
  ).rejects.toThrow('分块')
  expect(java.listChunks).toHaveBeenCalledWith(KID, FID, 2)
})
it('普通恢复取消不删除用户既有本地副本', async () => {
  const deleteBase = vi.fn()
  vi.mocked(application.get).mockReturnValue({ deleteBase } as never)
  const { recovery } = (service as any).recoveryContext(encodeOrgId(KID), lease)
  await recovery.ports.deleteLocalBase('既有副本')
  expect(deleteBase).not.toHaveBeenCalled()
})
it('同步上传核验同样检查 Java 正文，不仅检查分块数量', async () => {
  java.listChunks.mockResolvedValue({
    items: [{ knowledgeId: KID, fileId: FID, chunkId: CID, chunkIndex: 0, content: '错误' }],
    total: 1
  })
  await expect(
    (service as any).verifySyncFile(
      KID,
      FID,
      {
        itemId: 'i',
        fileName: '原文.txt',
        buffer: Buffer.from('file-bytes'),
        chunks: [{ content: '正文', metadata: { chunk_index: 0 } }]
      },
      lease
    )
  ).rejects.toThrow('分块')
  expect(legacy).not.toHaveBeenCalled()
})
it('已绑定库追加新文件复用 Java 策略，不重建或删除原库', async () => {
  orgStateStore.setShareAssociation(key, { shareId: KID, completion: 'incomplete', files: [], pendingAddition: true })
  const result = await service.uploadAddedFiles(encodeOrgId(KID), 'local')
  expect(result.completion).toBe('completed')
  expect(java.createLocalShare).not.toHaveBeenCalled()
  expect(java.removeSpace).not.toHaveBeenCalled()
  expect(java.uploadMultipart).toHaveBeenCalledTimes(1)
  expect(legacy).not.toHaveBeenCalled()
})
// it('未知创建只列原生操作，没有可靠绑定时不猜认领也不重放', async () => {
it('未知创建没有可靠UUID时要求人工核查，不再调用操作接口或重建', async () => {
  java.createLocalShare.mockRejectedValue(new Error('创建响应丢失'))
  await service.share('local')
  await expect(service.share('local', true)).rejects.toThrow('可靠绑定')
  expect(java.createLocalShare).toHaveBeenCalledTimes(1)
  // expect(java.listOperations).toHaveBeenCalled()
  expect(java.listOperations).not.toHaveBeenCalled()
  expect(java.confirmOperation).not.toHaveBeenCalled()
  expect(java.removeSpace).not.toHaveBeenCalled()
})
// it('删除未知结果必须核对原生操作，目录缺席不能证明删除', async () => {
it('目录缺席及UNCONFIRMED都不能证明删除，不清理授权或重放remove', async () => {
  const { recovery } = (service as any).recoveryContext(encodeOrgId(KID), lease)
  java.getCatalog.mockResolvedValue([])
  java.getLocalShareState.mockResolvedValue('UNCONFIRMED')
  await expect(recovery.ports.checkSpace()).rejects.toThrow()
  // expect(java.listOperations).toHaveBeenCalled()
  expect(java.listOperations).not.toHaveBeenCalled()
  expect(java.finishLocalShareRemoval).not.toHaveBeenCalled()
  expect(java.removeSpace).not.toHaveBeenCalled()
})

function pendingCancellation(phase = 'delete-unknown', localBaseId = 'local') {
  orgStateStore.setShareAssociation(key, { shareId: KID, completion: 'completed', files: [] })
  const recoveryKey = JSON.stringify(['s', '7', 'recovery', KID])
  orgStateStore.setCloudRecovery(recoveryKey, {
    spaceId: KID,
    localBaseId,
    phase,
    snapshot: '[]',
    restored: {},
    fingerprints: {},
    expectedHashes: {},
    missing: []
  } as never)
  return recoveryKey
}

function createDifferentCopy() {
  const nextId = '22222222-2222-4222-8222-222222222222'
  java.createLocalShare.mockImplementation(async (_name, _mode, guard) => {
    guard()
    return { id: nextId, name: '本地库', category: 'OWNED', allowLocalFileUpload: true }
  })
  java.getSpace.mockImplementation(async (id) => ({ id, category: 'OWNED', allowLocalFileUpload: true }))
  const getFile = java.getFile.getMockImplementation()
  java.getFile.mockImplementation(async (_id, fileId) => ({ ...(await getFile(_id, fileId)), knowledgeId: nextId }))
  java.createFolder.mockImplementation(async (_id, name, _parent, guard) => {
    guard()
    return { knowledgeId: nextId, fileId: DID, parentId: null, name, directory: true }
  })
  const upload = java.uploadMultipart.getMockImplementation()
  java.uploadMultipart.mockImplementation(async (...args) => ({ ...(await upload(...args)), knowledgeId: nextId }))
  java.listChunks.mockResolvedValue({
    items: [{ knowledgeId: nextId, fileId: FID, chunkId: CID, chunkIndex: 0, content: '正文' }],
    total: 1
  })
  return nextId
}

it('首次分享、正常取消和再次分享使用新的云端UUID及上传记录', async () => {
  await service.share('local')
  await service.unsharePreview({ baseId: 'local' })
  await service.unshare({ baseId: 'local', confirmDevicesStopped: true })
  expect(orgStateStore.getShareAssociation(key)).toBeUndefined()
  expect(orgStateStore.getFirstShareUpload(key)).toBeUndefined()
  const nextId = createDifferentCopy()
  const result = await service.share('local')
  expect(result).toMatchObject({ shareId: encodeOrgId(nextId), completion: 'completed' })
  expect(orgStateStore.getShareAssociation(key)?.shareId).toBe(nextId)
  expect(orgStateStore.getFirstShareUpload(key)?.shareId).toBe(nextId)
  expect(java.removeSpace).toHaveBeenCalledTimes(1)
})

it('删除响应丢失后重启，再次分享先核查墓碑和清理，再创建新副本', async () => {
  await service.share('local')
  await service.unsharePreview({ baseId: 'local' })
  java.removeSpace.mockRejectedValue(new Error('controlled disconnect'))
  java.getLocalShareState.mockResolvedValue('UNCONFIRMED')
  await expect(service.unshare({ baseId: 'local', confirmDevicesStopped: true })).rejects.toThrow('待核查')
  const recoveryKey = JSON.stringify(['s', '7', 'recovery', KID])
  expect(orgStateStore.getCloudRecovery(recoveryKey)?.phase).toBe('delete-unknown')
  service.dispose()
  service = new OrgKnowledgeService(auth)
  java.getLocalShareState.mockResolvedValue('DELETED')
  const nextId = createDifferentCopy()
  const result = await service.share('local')
  expect(result).toMatchObject({ completion: 'completed', shareId: encodeOrgId(nextId) })
  expect(orgStateStore.getCloudRecovery(recoveryKey)?.phase).toBe('completed')
  expect(orgStateStore.getShareAssociation(key)?.shareId).toBe(nextId)
  expect(java.finishLocalShareRemoval).toHaveBeenCalledTimes(1)
  expect(java.removeSpace).toHaveBeenCalledTimes(1)
  expect(java.listOperations).not.toHaveBeenCalled()
  expect(java.confirmOperation).not.toHaveBeenCalled()
})

it.each(['ACTIVE', 'LEGACY', 'UNCONFIRMED'])('取消结果为%s时保留旧关联并阻止新建或重发删除', async (state) => {
  const recoveryKey = pendingCancellation()
  java.getLocalShareState.mockResolvedValue(state)
  await expect(service.share('local')).rejects.toThrow()
  expect(orgStateStore.getCloudRecovery(recoveryKey)?.phase).toBe('delete-unknown')
  expect(orgStateStore.getShareAssociation(key)?.shareId).toBe(KID)
  expect(java.createLocalShare).not.toHaveBeenCalled()
  expect(java.finishLocalShareRemoval).not.toHaveBeenCalled()
  expect(java.removeSpace).not.toHaveBeenCalled()
})

it('Java授权收尾失败保留未知状态，下次只重试授权收尾', async () => {
  const recoveryKey = pendingCancellation()
  java.getLocalShareState.mockResolvedValue('DELETED')
  java.finishLocalShareRemoval.mockRejectedValueOnce(new Error('controlled cleanup failure'))
  await expect(service.share('local')).rejects.toThrow('核查')
  expect(orgStateStore.getCloudRecovery(recoveryKey)?.phase).toBe('delete-unknown')
  expect(orgStateStore.getShareAssociation(key)?.shareId).toBe(KID)
  const nextId = createDifferentCopy()
  expect((await service.share('local')).shareId).toBe(encodeOrgId(nextId))
  expect(java.removeSpace).not.toHaveBeenCalled()
})

it('准备取消时禁止再次分享，不把ready视为可以继续复用', async () => {
  pendingCancellation('ready')
  await expect(service.share('local')).rejects.toThrow('取消')
  expect(java.getSpace).not.toHaveBeenCalled()
  expect(java.createLocalShare).not.toHaveBeenCalled()
  expect(java.removeSpace).not.toHaveBeenCalled()
})

it('查询状态期间切换账号或企业时不清理关联和授权', async () => {
  const recoveryKey = pendingCancellation()
  java.getLocalShareState.mockImplementation(async () => {
    auth.assertLease.mockImplementation(() => {
      throw new Error('controlled identity change')
    })
    return 'DELETED'
  })
  await expect(service.share('local')).rejects.toThrow()
  expect(orgStateStore.getCloudRecovery(recoveryKey)?.phase).toBe('delete-unknown')
  expect(orgStateStore.getShareAssociation(key)?.shareId).toBe(KID)
  expect(java.finishLocalShareRemoval).not.toHaveBeenCalled()
  expect(java.createLocalShare).not.toHaveBeenCalled()
})

it('恢复目标与旧本机库不同时完成收尾并要求从恢复库重开，避免旧资料回流', async () => {
  const recoveryKey = pendingCancellation('deleted', 'restored-local')
  await expect(service.share('local')).rejects.toThrow('恢复后的本地知识库')
  expect(orgStateStore.getCloudRecovery(recoveryKey)?.phase).toBe('completed')
  expect(orgStateStore.getShareAssociation(key)).toBeUndefined()
  expect(java.createLocalShare).not.toHaveBeenCalled()
})

it('无取消记录的历史关联不自动迁移、清除或重建', async () => {
  orgStateStore.setShareAssociation(key, { shareId: KID, completion: 'completed', files: [] })
  java.getLocalShareState.mockResolvedValue('LEGACY')
  await expect(service.share('local')).rejects.toThrow('历史知识库')
  expect(orgStateStore.getShareAssociation(key)?.shareId).toBe(KID)
  expect(java.getSpace).not.toHaveBeenCalled()
  expect(java.createLocalShare).not.toHaveBeenCalled()
})

it('关联已清除但取消收尾中断时，仍通过恢复日志续作后再分享', async () => {
  const recoveryKey = pendingCancellation('deleted')
  orgStateStore.clearShare(key)
  const nextId = createDifferentCopy()
  expect((await service.share('local')).shareId).toBe(encodeOrgId(nextId))
  expect(orgStateStore.getCloudRecovery(recoveryKey)?.phase).toBe('completed')
  expect(java.removeSpace).not.toHaveBeenCalled()
})
