import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { application } from '@application'

import { encodeOrgId } from '../../../shared/data/types/enterpriseKnowledge'
import { OrgKnowledgeService } from '../OrgKnowledgeService'
import { orgStateStore } from '../OrgStateStore'

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
  expect(java.uploadMultipart.mock.calls[0][0]).toBe('/api/v1/knowledge/file/importChunks?scope=client')
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
it('未知创建只列原生操作，没有可靠绑定时不猜认领也不重放', async () => {
  java.createLocalShare.mockRejectedValue(new Error('创建响应丢失'))
  await service.share('local')
  await expect(service.share('local', true)).rejects.toThrow('可靠绑定')
  expect(java.createLocalShare).toHaveBeenCalledTimes(1)
  expect(java.listOperations).toHaveBeenCalled()
  expect(java.confirmOperation).not.toHaveBeenCalled()
  expect(java.removeSpace).not.toHaveBeenCalled()
})
it('删除未知结果必须核对原生操作，目录缺席不能证明删除', async () => {
  const { recovery } = (service as any).recoveryContext(encodeOrgId(KID), lease)
  java.getCatalog.mockResolvedValue([])
  await expect(recovery.ports.checkSpace()).rejects.toThrow()
  expect(java.listOperations).toHaveBeenCalled()
  expect(java.removeSpace).not.toHaveBeenCalled()
})
