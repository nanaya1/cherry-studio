import { beforeEach, afterEach, expect, it, vi } from 'vitest'

import { encodeOrgId } from '../../../shared/data/types/enterpriseKnowledge'
import { JavaKnowledgeError } from '../JavaKnowledgeClient'
import { OrgKnowledgeService } from '../OrgKnowledgeService'
import { orgStateStore } from '../OrgStateStore'

vi.mock('../KnowledgeSourceBindings', () => ({
  replaceKnowledgeSourceBindings: vi.fn(),
  removeKnowledgeSourceBindings: vi.fn(),
  captureKnowledgeSourceBindings: vi.fn()
}))
vi.mock('@data/services/KnowledgeItemService', () => ({ knowledgeItemService: {} }))
vi.mock('../OrgStateStore', () => {
  const shares = new Map()
  return {
    orgStateStore: {
      getShareAssociation: (key: string) => structuredClone(shares.get(key)),
      setShareAssociation: vi.fn((key: string, value: unknown) => shares.set(key, structuredClone(value)))
    }
  }
})

const lease = { generation: 1, issuerId: 's', userId: '7', groupId: 'g' }
const key = JSON.stringify(['s', '7', 'g', 'local'])
const shareId = '11111111-1111-4111-8111-111111111111'
const fileId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const change = { itemId: 'i', fileName: '旧原文.txt', kind: 'delete', remoteFileId: encodeOrgId(fileId) }
let service: OrgKnowledgeService
let java: any
let visible: boolean

function seed(state?: 'not_sent' | 'intent_saved', pending = true) {
  orgStateStore.setShareAssociation(key, {
    shareId,
    files: [],
    completion: 'completed',
    manifest: {
      entries: [{ itemId: 'i', fileId, fileName: change.fileName, hash: 'hash' }],
      state: 'shared',
      lastSyncedAt: null,
      operations: pending
        ? [
            {
              ...change,
              newFileId: null,
              hash: null,
              phase: 'cleanup_pending',
              error: null,
              ...(state ? { cleanupDeleteState: state } : {})
            }
          ]
        : []
    }
  } as any)
}
function operation() {
  return orgStateStore.getShareAssociation(key)!.manifest!.operations[0] as any
}
async function apply(cleanupOnly = true) {
  const association = orgStateStore.getShareAssociation(key)!
  return (service as any).executeSync(
    {
      plan: {
        key,
        baseId: 'local',
        lease,
        cleanupOnly,
        changes: [change],
        fingerprint: (service as any).syncFingerprint([], association),
        expiresAt: Date.now() + 60_000
      },
      confirmDeletes: true
    },
    new AbortController().signal
  )
}
function reopen() {
  service?.dispose()
  service = new OrgKnowledgeService({
    acquireLease: () => lease,
    assertLease: vi.fn(),
    apiClient: { javaKnowledge: java }
  } as any)
  vi.spyOn(service as any, 'localSyncEntries').mockResolvedValue([])
}
beforeEach(() => {
  visible = true
  java = {
    getCatalog: vi.fn(async () => [{ id: shareId, category: 'OWNED', ownerId: 7 }]),
    getFile: vi.fn(async () => {
      if (!visible) throw new JavaKnowledgeError(404, '文件不存在')
      return { fileId, knowledgeId: shareId, directory: false }
    }),
    listFiles: vi.fn(async () => ({
      items: visible ? [{ fileId, knowledgeId: shareId, directory: false }] : [],
      total: visible ? 1 : 0
    })),
    removeFile: vi.fn(async (_s, _f, guard) => {
      guard()
      visible = false
    })
  }
  reopen()
  seed('not_sent')
})
afterEach(() => {
  service.dispose()
  vi.clearAllMocks()
})

it('首次删除前持久化意图，响应丢失后恢复只读且保留映射待核对', async () => {
  seed(undefined, false)
  java.removeFile.mockImplementation(async (_s, _f, guard) => {
    guard()
    expect(operation().cleanupDeleteState).toBe('intent_saved')
    visible = false
    throw new Error('删除落地但响应丢失')
  })
  expect((await apply(false)).status).toBe('unknown')
  expect(operation().cleanupDeleteState).toBe('intent_saved')
  reopen()
  java.getFile.mockClear()
  expect((await apply()).status).toBe('unknown')
  expect(java.getFile).not.toHaveBeenCalled()
  expect(java.listFiles).toHaveBeenCalled()
  expect(java.removeFile).toHaveBeenCalledTimes(1)
  expect(orgStateStore.getShareAssociation(key)!.manifest!.entries[0].fileId).toBe(fileId)
})
it('删除后查询失败及随后恢复仍可见均不能重发删除', async () => {
  java.listFiles.mockRejectedValueOnce(new JavaKnowledgeError(500, '查询失败'))
  expect((await apply()).status).toBe('unknown')
  visible = true
  reopen()
  expect((await apply()).status).toBe('unknown')
  expect(java.removeFile).toHaveBeenCalledTimes(1)
  expect(operation().phase).toBe('cleanup_pending')
})
it.each([undefined, 'intent_saved'] as const)('历史或已保存意图 %s 仍可见时仅核查，不重放', async (state) => {
  seed(state)
  expect((await apply()).status).toBe('unknown')
  expect(java.removeFile).not.toHaveBeenCalled()
  expect(operation().phase).toBe('cleanup_pending')
})
it('历史记录目录未命中但无原生删除确认时不能猜测成功', async () => {
  seed()
  visible = false
  expect((await apply()).status).toBe('unknown')
  expect(java.removeFile).not.toHaveBeenCalled()
  expect(operation().phase).toBe('cleanup_pending')
})
it('只读业务查询失败不能视为文件缺失或删除成功', async () => {
  seed('intent_saved')
  java.listFiles.mockRejectedValue(new JavaKnowledgeError(404, '业务查询失败'))
  expect((await apply()).status).toBe('unknown')
  expect(java.removeFile).not.toHaveBeenCalled()
})
it('新操作删除已确认返回且完整目录不可见后才完成', async () => {
  seed(undefined, false)
  expect((await apply(false)).status).toBe('complete')
  expect(java.removeFile).toHaveBeenCalledTimes(1)
  expect(operation().phase).toBe('complete')
  expect(orgStateStore.getShareAssociation(key)!.manifest!.entries).toEqual([])
})
it('恢复核查不按同名或 hash 认领其他文件', async () => {
  seed('intent_saved')
  java.listFiles.mockResolvedValue({
    items: [
      { knowledgeId: shareId, fileId: 'b'.repeat(32), name: change.fileName, fileHash: 'hash', directory: false }
    ],
    total: 1
  })
  expect((await apply()).status).toBe('unknown')
  expect(java.removeFile).not.toHaveBeenCalled()
  expect(orgStateStore.getShareAssociation(key)!.manifest!.entries[0].fileId).toBe(fileId)
})
it.each([undefined, 'intent_saved'] as const)('update 恢复 %s 保留旧新映射且不因新副本详情失败重发', async (state) => {
  seed(state)
  const association = orgStateStore.getShareAssociation(key)!
  const op = association.manifest!.operations[0]
  op.kind = 'update'
  op.newFileId = 'b'.repeat(32)
  op.hash = 'new-hash'
  orgStateStore.setShareAssociation(key, association)
  java.getFile.mockRejectedValue(new JavaKnowledgeError(500, '详情不可用'))
  const result = await (service as any).executeSync(
    {
      plan: {
        key,
        baseId: 'local',
        lease,
        cleanupOnly: true,
        changes: [{ ...change, kind: 'update' }],
        fingerprint: (service as any).syncFingerprint([], association),
        expiresAt: Date.now() + 60_000
      },
      confirmDeletes: true
    },
    new AbortController().signal
  )
  expect(result.status).toBe('unknown')
  expect(java.getFile).not.toHaveBeenCalled()
  expect(java.listFiles).toHaveBeenCalled()
  expect(java.removeFile).not.toHaveBeenCalled()
  expect(operation()).toMatchObject({ phase: 'cleanup_pending', newFileId: 'b'.repeat(32), hash: 'new-hash' })
  expect(orgStateStore.getShareAssociation(key)!.manifest!.entries[0].fileId).toBe(fileId)
})
it('意图落盘失败时不能发送删除', async () => {
  const sent = vi.fn()
  java.removeFile.mockImplementation(async (_s, _f, guard) => {
    guard()
    sent()
  })
  const original = vi.mocked(orgStateStore.setShareAssociation).getMockImplementation()!
  vi.mocked(orgStateStore.setShareAssociation).mockImplementation((k, value) => {
    if (typeof value !== 'string' && value.manifest?.operations[0]?.cleanupDeleteState === 'intent_saved')
      throw new Error('落盘失败')
    return original(k, value)
  })
  await expect(apply()).rejects.toThrow('落盘失败')
  expect(sent).not.toHaveBeenCalled()
  vi.mocked(orgStateStore.setShareAssociation).mockImplementation(original)
})
