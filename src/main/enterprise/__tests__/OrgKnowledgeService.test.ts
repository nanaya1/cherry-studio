import { createHash } from 'node:crypto'
import type * as NodeFs from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'

vi.mock('node:fs', async (original) => ({
  ...(await original<typeof NodeFs>()),
  createReadStream: () => Readable.from([Buffer.from('file-bytes')])
}))

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { orgStateStore } from '../OrgStateStore'

const lease = { generation: 1, issuerId: 'server-1', groupId: 'g', userId: 'u' }
const auth = { acquireLease: vi.fn(() => ({ ...lease })), assertLease: vi.fn() }

beforeEach(() => {
  vi.useRealTimers()
  jobSettledListener = undefined
  shareJobs.registerHandler.mockClear()
  shareJobs.enqueue.mockReset()
  shareJobs.list.mockReset().mockResolvedValue([])
  shareJobs.onJobSettled.mockClear()
  getSubtreeItems.mockReturnValue([])
  auth.acquireLease.mockImplementation(() => ({ ...lease }))
  auth.assertLease.mockImplementation(() => {})
  vi.mocked(orgStateStore.getShareAssociation).mockReturnValue(undefined)
  vi.mocked(orgStateStore.clearShare).mockClear()
  vi.mocked(readFile).mockResolvedValue(Buffer.from('file-bytes'))
  vi.mocked(stat).mockResolvedValue({ size: 10, isFile: () => true } as never)
  let firstState: any
  vi.mocked(orgStateStore.getFirstShareUpload).mockImplementation(() => firstState)
  vi.mocked(orgStateStore.setFirstShareUpload).mockImplementation((_key, value) => {
    firstState = structuredClone(value)
  })
})

import { application } from '@application'

import { encodeOrgId } from '../../../shared/data/types/enterpriseKnowledge'
import { enterpriseKnowledgeErrorCodes as E } from '../../../shared/ipc/errors/enterpriseKnowledge'
import { OrgKnowledgeError } from '../OrgKnowledgeService'
import { OrgKnowledgeService } from '../OrgKnowledgeService'

const { getSubtreeItems } = vi.hoisted(() => ({ getSubtreeItems: vi.fn(() => []) }))
vi.mock('@data/services/KnowledgeItemService', () => ({ knowledgeItemService: { getSubtreeItems } }))

vi.mock('node:fs/promises', () => ({
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
    clearShare: vi.fn()
  }
}))

function makeApiClient() {
  return {
    request: vi.fn(),
    requestFileMultipart: vi.fn(),
    requestMultipart: vi.fn(),
    requestText: vi.fn(),
    requestBytes: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.7'))
  }
}

let jobSettledListener: ((event: any) => void) | undefined
const shareJobs = {
  registerHandler: vi.fn(),
  enqueue: vi.fn(),
  // 原推断never[]无法表达运行中的任务，补充测试端口返回类型。
  // list: vi.fn(async () => []),
  list: vi.fn(async (): Promise<unknown[]> => []),
  onJobSettled: vi.fn((listener: (event: any) => void) => {
    jobSettledListener = listener
    return { dispose: vi.fn() }
  })
}

function settleKnowledgeJob(type: string, baseId = 'local-1'): void {
  jobSettledListener?.({
    jobId: 'knowledge-job',
    type,
    scheduleId: null,
    parentId: null,
    status: 'completed',
    input: { baseId },
    output: undefined,
    error: null,
    attempt: 1,
    metadata: {}
  })
}

function makeService(apiClient: ReturnType<typeof makeApiClient>) {
  const service = new OrgKnowledgeService({ apiClient, ...auth } as never)
  apiClient.requestFileMultipart.mockImplementation(async (path, entry) => {
    const form = new FormData()
    form.append('chunks', JSON.stringify(entry.chunks))
    form.append('file', new Blob(['file-bytes']), entry.fileName)
    return apiClient.requestMultipart(path, form)
  })
  vi.spyOn(service as any, 'verifyFirstShareFile').mockResolvedValue(undefined)
  service.initialize(shareJobs as never)
  shareJobs.enqueue.mockImplementation(async (_type, input) => {
    const handler = [...shareJobs.registerHandler.mock.calls].reverse().find(([type]) => type === _type)![1]
    const metadata: Record<string, unknown> = {}
    const finished = Promise.resolve().then(async () => {
      try {
        const output = await handler.execute({
          input,
          signal: new AbortController().signal,
          reportProgress: vi.fn(),
          patchMetadata: async (patch: Record<string, unknown>) => Object.assign(metadata, patch)
        })
        return { status: 'completed', output, metadata }
      } catch (error) {
        return { status: 'failed', error: { message: (error as Error).message }, metadata }
      }
    })
    return { id: 'share-job', finished }
  })
  return service
}

const codeSpaceId = 'ccbc8b6e-172b-4fb2-8cb8-6773565336bd'
const codeShare = {
  id: 'c357f93f-572b-4c16-868b-c2f43c20a88e',
  space_id: codeSpaceId,
  share_code: 'AbCd_123',
  share_type: 1,
  has_password: true,
  max_views: null,
  view_count: 0,
  expires_at: null,
  revoked_at: null,
  created_at: '2026-10-15T00:00:00Z'
}
const codeCatalog = { public: [], shared: [], owned: [{ id: codeSpaceId, name: '副本', my_role: 'owner' }] }

describe('取消整个分享', () => {
  const key = JSON.stringify([lease.issuerId, lease.userId, lease.groupId, 'local-1'])
  function setup() {
    let association: any = { shareId: codeSpaceId, completion: 'completed', files: [] }
    vi.mocked(orgStateStore.getShareAssociation).mockImplementation(() => association)
    vi.mocked(orgStateStore.clearShare).mockImplementation(() => {
      association = undefined
    })
    const api = makeApiClient()
    api.request.mockResolvedValue(codeCatalog)
    const service = makeService(api)
    return { api, service }
  }

  it('远端确认后解除关联，状态恢复未分享并清理首传进度', async () => {
    const { api, service } = setup()
    api.request.mockImplementation(async (_path, init) => {
      if (init?.method === 'DELETE') {
        expect(orgStateStore.getShareAssociation(key)).toBeDefined()
        return undefined
      }
      return codeCatalog
    })
    await expect(service.unshare({ baseId: 'local-1' })).resolves.toEqual({ ok: true })
    expect(await service.syncStatus({ baseId: 'local-1' })).toEqual({ state: 'unshared', lastSyncedAt: null })
    expect(orgStateStore.clearShare).toHaveBeenCalledWith(key)
    service.dispose()
  })

  it.each([403, 404, 500])('远端失败 %s 时保留绑定允许重试', async (status) => {
    const { api, service } = setup()
    api.request.mockImplementation(async (_path, init) => {
      if (init?.method === 'DELETE') throw new Error(`HTTP ${status}`)
      return codeCatalog
    })
    await expect(service.unshare({ baseId: 'local-1' })).rejects.toThrow(`HTTP ${status}`)
    expect(orgStateStore.getShareAssociation(key)).toBeDefined()
    expect(orgStateStore.clearShare).not.toHaveBeenCalled()
    service.dispose()
  })

  it('删除期间账号变化不能清除关联', async () => {
    const { api, service } = setup()
    api.request.mockImplementation(async (_path, init) => {
      if (init?.method === 'DELETE') {
        auth.assertLease.mockImplementation(() => {
          throw new Error('session changed')
        })
        return undefined
      }
      return codeCatalog
    })
    await expect(service.unshare({ baseId: 'local-1' })).rejects.toMatchObject({ code: E.ORGKB_UNAUTHORIZED })
    expect(orgStateStore.getShareAssociation(key)).toBeDefined()
    expect(orgStateStore.clearShare).not.toHaveBeenCalled()
    service.dispose()
  })

  it.each(['upload', 'sync'])('活跃 %s 任务期间不删除远端空间', async (kind) => {
    const { api, service } = setup()
    if (kind === 'upload') (service as any).firstShareActive = { key }
    else (service as any).syncing.add(key)
    await expect(service.unshare({ baseId: 'local-1' })).rejects.toMatchObject({ code: E.ORGKB_SHARE_FAILED })
    expect(api.request).not.toHaveBeenCalled()
    expect(orgStateStore.getShareAssociation(key)).toBeDefined()
    service.dispose()
  })

  it('取消期间拒绝重复取消与再次分享', async () => {
    const { api, service } = setup()
    let finish!: () => void
    api.request.mockImplementation(async (_path, init) => {
      if (init?.method === 'DELETE')
        return new Promise<void>((resolve) => {
          finish = resolve
        })
      return codeCatalog
    })
    const pending = service.unshare({ baseId: 'local-1' })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await expect(service.unshare({ baseId: 'local-1' })).rejects.toThrow('正在取消分享')
    await expect(service.share('local-1')).rejects.toThrow('正在取消分享')
    finish()
    await pending
    service.dispose()
  })
})

describe('同步安全边界', () => {
  const key = JSON.stringify([lease.issuerId, lease.userId, lease.groupId, 'local-1'])
  function setupSync() {
    let association: any = {
      shareId: codeSpaceId,
      completion: 'completed',
      files: [],
      manifest: {
        entries: [],
        operations: [],
        state: 'shared',
        lastSyncedAt: null
      }
    }
    vi.mocked(orgStateStore.getShareAssociation).mockImplementation(() => structuredClone(association))
    vi.mocked(orgStateStore.setShareAssociation).mockImplementation((_key, value) => {
      association = structuredClone(value)
    })
    const item = {
      id: 'i1',
      type: 'file',
      status: 'completed',
      data: { relativePath: '原名.txt', source: '/original/原名.txt' }
    }
    const chunks = [
      { id: 'c1', itemId: 'i1', content: '内容', metadata: { itemType: 'file', chunkIndex: 0, source: '原名.txt' } }
    ]
    vi.mocked(application.get).mockReturnValue({
      listBasesForDiscovery: () => ({ items: [{ id: 'local-1', name: '库' }] }),
      listRootItems: () => [item],
      getFilePath: () => '/storage/uuid.txt',
      listItemChunks: async () => chunks
    } as never)
    const api = makeApiClient()
    const remoteItem = {
      id: 'remote-item',
      base_id: codeSpaceId,
      group_id: null,
      type: 'file',
      title: '原名.txt',
      status: 'completed',
      error: null,
      document_id: 'new-file',
      data: { file_id: 'new-file' },
      created_at: '2026-10-16T00:00:00Z',
      updated_at: '2026-10-16T00:00:00Z'
    }
    api.request.mockImplementation(async (path: string, options?: { method?: string; body?: string }) => {
      if (path.includes('/catalog')) return codeCatalog
      if (path.endsWith('/chunks'))
        return {
          chunks: [
            {
              chunk_id: 'rc',
              item_id: 'remote-item',
              document_id: 'new-file',
              content: '内容',
              metadata: { chunk_index: 0 }
            }
          ],
          total: 1
        }
      if (path.endsWith('/items')) return { items: [remoteItem], total: 1 }
      if (path.includes('/items/')) return remoteItem
      return {
        id: path.split('/').at(-1),
        space_id: codeSpaceId,
        name: options?.body ? JSON.parse(options.body).name : '原名.txt',
        is_dir: false,
        file_hash: createHash('sha256').update('file-bytes').digest('hex'),
        parse_status: 'completed'
      }
    })
    api.requestMultipart.mockResolvedValue({ share_id: codeSpaceId, file_id: 'new-file', chunk_count: 1 })
    return {
      api,
      service: makeService(api),
      item,
      chunks,
      get: () => association,
      set: (value: any) => {
        association = value
      },
      key
    }
  }

  describe('自动同步触发', () => {
    it('知识索引完成并且队列静默后自动同步新增文件', async () => {
      vi.useFakeTimers()
      const s = setupSync()

      settleKnowledgeJob('knowledge.index-documents')
      await vi.advanceTimersByTimeAsync(2_000)

      expect(shareJobs.list).toHaveBeenCalledWith({
        queue: 'base.local-1',
        status: ['pending', 'running'],
        limit: 1
      })
      expect(s.api.requestMultipart).toHaveBeenCalledTimes(1)
      expect(s.get().manifest.entries[0]).toMatchObject({ itemId: 'i1', fileId: 'new-file' })
    })

    it('同一知识库短时间内多个完成事件合并为一次同步', async () => {
      vi.useFakeTimers()
      const s = setupSync()

      settleKnowledgeJob('knowledge.prepare-root')
      settleKnowledgeJob('knowledge.index-documents')
      settleKnowledgeJob('knowledge.check-file-processing-result')
      await vi.advanceTimersByTimeAsync(2_000)

      expect(s.api.requestMultipart).toHaveBeenCalledTimes(1)
    })

    it('服务销毁后停止已经进入回调的自动同步', async () => {
      vi.useFakeTimers()
      const s = setupSync()
      let releaseList!: (value: unknown[]) => void
      shareJobs.list.mockImplementationOnce(() => new Promise((resolve) => (releaseList = resolve)))

      settleKnowledgeJob('knowledge.index-documents')
      await vi.advanceTimersByTimeAsync(1_000)
      s.service.dispose()
      releaseList([])
      await vi.runAllTimersAsync()

      expect(s.api.requestMultipart).not.toHaveBeenCalled()
    })

    it('preview 期间出现新任务时不应用旧计划', async () => {
      vi.useFakeTimers()
      const s = setupSync()
      shareJobs.list.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'new-local-job' }])

      settleKnowledgeJob('knowledge.index-documents')
      await vi.advanceTimersByTimeAsync(1_000)

      expect(s.api.requestMultipart).not.toHaveBeenCalled()
      expect(shareJobs.list).toHaveBeenCalledTimes(2)
    })

    it('存在纯删除变更时保留 pending，不自动确认远端删除', async () => {
      vi.useFakeTimers()
      const s = setupSync()
      s.set({
        ...s.get(),
        manifest: {
          ...s.get().manifest,
          entries: [{ itemId: 'removed', fileId: 'old-file', fileName: '旧.txt', hash: 'old' }]
        }
      })

      settleKnowledgeJob('knowledge.delete-subtree')
      await vi.advanceTimersByTimeAsync(2_000)

      expect(s.api.request.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false)
      expect(s.get().manifest.entries).toEqual([
        { itemId: 'removed', fileId: 'old-file', fileName: '旧.txt', hash: 'old' }
      ])
    })

    it('远端写入结果 unknown 后不因后续无关任务完成而自动重试', async () => {
      vi.useFakeTimers()
      const s = setupSync()
      s.api.requestMultipart.mockRejectedValue(new Error('timeout'))

      settleKnowledgeJob('knowledge.index-documents')
      await vi.advanceTimersByTimeAsync(2_000)
      settleKnowledgeJob('knowledge.prepare-root')
      await vi.advanceTimersByTimeAsync(2_000)

      expect(s.api.requestMultipart).toHaveBeenCalledTimes(1)
      expect(s.get().manifest.state).toBe('unknown')
    })
  })

  it('初次分享即持久化 itemId、原名与 hash manifest', async () => {
    const s = setupSync()
    vi.mocked(orgStateStore.getShareAssociation).mockReturnValue(undefined)
    s.api.request.mockResolvedValue({ share_id: codeSpaceId })
    await s.service.share('local-1')
    const saved = vi.mocked(orgStateStore.setShareAssociation).mock.calls.at(-1)![1] as any
    expect(saved.manifest).toMatchObject({
      state: 'shared',
      entries: [{ itemId: 'i1', fileName: '原名.txt', fileId: 'new-file' }]
    })
    expect(saved.manifest.entries[0].hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('同库并发 apply 重新验证指纹，只上传一次', async () => {
    const s = setupSync()
    const a = await s.service.syncPreview({ baseId: 'local-1' })
    const b = await s.service.syncPreview({ baseId: 'local-1' })
    const results = await Promise.allSettled(
      [a, b].map((p) => s.service.syncApply({ baseId: 'local-1', planId: p.planId, confirmDeletes: false }))
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(s.api.requestMultipart).toHaveBeenCalledTimes(1)
  })

  it('只改展示名执行 PUT，保留空间与远端文件 ID', async () => {
    const s = setupSync()
    const add = await s.service.syncPreview({ baseId: 'local-1' })
    await s.service.syncApply({ baseId: 'local-1', planId: add.planId, confirmDeletes: false })
    s.item.data.relativePath = '改名.txt'
    const rename = await s.service.syncPreview({ baseId: 'local-1' })
    expect(rename.changes[0].kind).toBe('rename')
    const result = await s.service.syncApply({ baseId: 'local-1', planId: rename.planId, confirmDeletes: false })
    expect(result.status).toBe('complete')
    expect(s.get().manifest.entries[0]).toMatchObject({ fileName: '改名.txt', fileId: 'new-file' })
    expect(s.api.request.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(true)
    expect(s.api.requestMultipart).toHaveBeenCalledTimes(1)
  })

  it('同步中切号后保留写前记录且不继续验证', async () => {
    const s = setupSync()
    const p = await s.service.syncPreview({ baseId: 'local-1' })
    s.api.requestMultipart.mockImplementation(async () => {
      auth.assertLease.mockImplementation(() => {
        throw new Error('switched')
      })
      return { share_id: codeSpaceId, file_id: 'new-file', chunk_count: 1 }
    })
    await expect(s.service.syncApply({ baseId: 'local-1', planId: p.planId, confirmDeletes: false })).rejects.toThrow()
    expect(s.get().manifest.operations[0].phase).toBe('writing')
    expect(s.get().completion).toBe('incomplete')
  })

  it('只读预览新增文件，上传使用展示名且 token 只能执行一次', async () => {
    const s = setupSync()
    const preview = await s.service.syncPreview({ baseId: 'local-1' })
    expect(preview).toMatchObject({
      status: 'pending',
      changes: [{ itemId: 'i1', fileName: '原名.txt', kind: 'add', remoteFileId: null }]
    })
    expect(s.api.requestMultipart).not.toHaveBeenCalled()
    const result = await s.service.syncApply({ baseId: 'local-1', planId: preview.planId, confirmDeletes: false })
    expect(result.status).toBe('complete')
    expect(result.files[0]).toMatchObject({ status: 'success', kind: 'add' })
    expect((s.api.requestMultipart.mock.calls[0][1].get('file') as File).name).toBe('原名.txt')
    expect(s.get().manifest.entries[0]).toMatchObject({ itemId: 'i1', fileId: 'new-file', fileName: '原名.txt' })
    await expect(
      s.service.syncApply({ baseId: 'local-1', planId: preview.planId, confirmDeletes: false })
    ).rejects.toThrow()
    expect(s.api.requestMultipart).toHaveBeenCalledTimes(1)
  })

  it.each(['expired', 'changed', 'epoch', 'owner'])('拒绝 %s 计划而不写远端', async (kind) => {
    const s = setupSync()
    const preview = await s.service.syncPreview({ baseId: 'local-1' })
    if (kind === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_001)
    if (kind === 'changed') s.chunks[0].content = '已变化'
    if (kind === 'epoch') auth.acquireLease.mockReturnValue({ ...lease, generation: 2 })
    if (kind === 'owner') s.api.request.mockResolvedValue({ public: [], owned: [], shared: [] })
    try {
      await expect(
        s.service.syncApply({ baseId: 'local-1', planId: preview.planId, confirmDeletes: false })
      ).rejects.toThrow()
      expect(s.api.requestMultipart).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('上传超时持久化 unknown，后续预览禁止自动再上传', async () => {
    const s = setupSync()
    s.api.requestMultipart.mockRejectedValue(new Error('timeout'))
    const p = await s.service.syncPreview({ baseId: 'local-1' })
    expect((await s.service.syncApply({ baseId: 'local-1', planId: p.planId, confirmDeletes: false })).status).toBe(
      'unknown'
    )
    expect(s.get().manifest.operations[0].phase).toBe('writing')
    const next = await s.service.syncPreview({ baseId: 'local-1' })
    expect(next.status).toBe('unknown')
    await expect(
      s.service.syncApply({ baseId: 'local-1', planId: next.planId, confirmDeletes: false })
    ).rejects.toThrow()
    expect(s.api.requestMultipart).toHaveBeenCalledTimes(1)
  })

  it('更新验证新副本后删除旧副本，无需本地删除确认', async () => {
    const s = setupSync()
    s.get().manifest.entries.push({ itemId: 'i1', fileId: 'old-file', fileName: '原名.txt', hash: 'old' })
    const p = await s.service.syncPreview({ baseId: 'local-1' })
    expect(p.changes[0].kind).toBe('update')
    expect(p.warnings.join('')).toContain('验证后')
    const result = await s.service.syncApply({ baseId: 'local-1', planId: p.planId, confirmDeletes: false })
    expect(result.status).toBe('complete')
    expect(s.get().manifest.operations[0]).toMatchObject({
      remoteFileId: encodeOrgId('old-file'),
      newFileId: 'new-file',
      phase: 'complete'
    })
    expect(s.get().manifest.entries[0].fileId).toBe('new-file')
    const calls = s.api.request.mock.calls
    expect(calls.findIndex(([, opts]) => opts?.method === 'DELETE')).toBeGreaterThan(
      calls.findIndex(([path]) => path.endsWith('/chunks'))
    )
    expect(p.warnings.join('')).toContain('索引失效时间未承诺')
    expect(p.warnings.join('')).toContain('非原子')
  })

  it('缺少删除确认拒绝整个批次；确认后软删除并移除 manifest 映射', async () => {
    const s = setupSync()
    s.get().manifest.entries.push({ itemId: 'removed', fileId: 'old-file', fileName: '旧.txt', hash: 'old' })
    let p = await s.service.syncPreview({ baseId: 'local-1' })
    await expect(s.service.syncApply({ baseId: 'local-1', planId: p.planId, confirmDeletes: false })).rejects.toThrow()
    expect(s.api.requestMultipart).not.toHaveBeenCalled()
    p = await s.service.syncPreview({ baseId: 'local-1' })
    expect(p.warnings.join('')).toContain('索引')
    const result = await s.service.syncApply({ baseId: 'local-1', planId: p.planId, confirmDeletes: true })
    expect(result.status).toBe('complete')
    expect(result.files.find((f) => f.kind === 'delete')?.status).toBe('success')
    expect(s.get().manifest.entries.some((e: any) => e.fileId === 'old-file')).toBe(false)
    expect(s.api.request.mock.calls.some(([, opts]) => opts?.method === 'DELETE')).toBe(true)
  })

  it.each(['timeout', 'forbidden', 'visible', 'cycle'])('清理 %s 保留 journal，重开后仅清理不重传', async (mode) => {
    const s = setupSync()
    s.get().manifest.entries.push({ itemId: 'i1', fileId: 'old-file', fileName: '原名.txt', hash: 'old' })
    const request = s.api.request.getMockImplementation()!
    let failed = true
    let deleting = false
    s.api.request.mockImplementation(async (path: string, opts?: any) => {
      if (opts?.method === 'DELETE') {
        deleting = true
        if (failed && mode === 'timeout') throw new Error('timeout')
        if (failed && mode === 'forbidden') {
          const { OrgApiHttpError } = await import('../OrgApiClient')
          throw new OrgApiHttpError(403, 'forbidden')
        }
        return { deleted: 1 }
      }
      if (deleting && path.includes('/items')) {
        if (failed && mode === 'cycle') return { items: [], total: 1, next_cursor: 'loop' }
        if (failed && mode === 'visible') {
          const page = await request(`/api/kb/v1/knowledge/bases/${codeSpaceId}/items`)
          if (!path.includes('?')) return { items: [], total: 1, next_cursor: 'page2' }
          return { ...page, items: [{ ...page.items[0], document_id: 'old-file', data: { file_id: 'old-file' } }] }
        }
        return { items: [], total: 0 }
      }
      return request(path, opts)
    })
    const p = await s.service.syncPreview({ baseId: 'local-1' })
    const result = await s.service.syncApply({ baseId: 'local-1', planId: p.planId, confirmDeletes: false })
    expect(result.status).toBe(mode === 'forbidden' ? 'partial' : 'unknown')
    expect(s.get().manifest.operations[0]).toMatchObject({ phase: 'cleanup_pending', newFileId: 'new-file' })
    expect(s.get().manifest.entries[0].fileId).toBe('old-file')
    failed = false
    s.chunks[0].content = '清理期间本地再次修改'
    const reopened = makeService(s.api)
    const next = await reopened.syncPreview({ baseId: 'local-1' })
    expect(next.status).toBe('pending')
    expect(next.warnings.join('')).toContain('仅清理')
    expect((await reopened.syncApply({ baseId: 'local-1', planId: next.planId, confirmDeletes: false })).status).toBe(
      'complete'
    )
    expect(s.api.requestMultipart).toHaveBeenCalledTimes(1)
    expect(s.get().manifest.entries[0].fileId).toBe('new-file')
    expect((await reopened.syncStatus({ baseId: 'local-1' })).state).toBe('pending')
  })

  it('重开清理时旧文件已软删除，仅查询目录完成，不重传或再次 DELETE', async () => {
    const s = setupSync()
    s.get().manifest.entries.push({ itemId: 'i1', fileId: 'old-file', fileName: '原名.txt', hash: 'old' })
    const request = s.api.request.getMockImplementation()!
    s.api.request.mockImplementation(async (path: string, opts?: any) => {
      if (opts?.method === 'DELETE') throw new Error('timeout')
      return request(path, opts)
    })
    const p = await s.service.syncPreview({ baseId: 'local-1' })
    await s.service.syncApply({ baseId: 'local-1', planId: p.planId, confirmDeletes: false })
    const { OrgApiHttpError } = await import('../OrgApiClient')
    s.api.request.mockImplementation(async (path: string, opts?: any) => {
      if (path.endsWith('/old-file')) throw new OrgApiHttpError(404, 'not found')
      return request(path, opts)
    })
    const reopened = makeService(s.api)
    const next = await reopened.syncPreview({ baseId: 'local-1' })
    const deletesBefore = s.api.request.mock.calls.filter(([, opts]) => opts?.method === 'DELETE').length
    expect((await reopened.syncApply({ baseId: 'local-1', planId: next.planId, confirmDeletes: false })).status).toBe(
      'complete'
    )
    expect(s.api.request.mock.calls.filter(([, opts]) => opts?.method === 'DELETE')).toHaveLength(deletesBefore)
    expect(s.api.requestMultipart).toHaveBeenCalledTimes(1)
    expect(s.get().manifest.entries[0].fileId).toBe('new-file')
  })

  it.each(['space', 'id', 'directory'])('旧文件 %s 归属异常禁止上传和 DELETE', async (mode) => {
    const s = setupSync()
    s.get().manifest.entries.push({ itemId: 'i1', fileId: 'old-file', fileName: '原名.txt', hash: 'old' })
    const p = await s.service.syncPreview({ baseId: 'local-1' })
    const request = s.api.request.getMockImplementation()!
    s.api.request.mockImplementation(async (path: string, opts?: any) => {
      const result = await request(path, opts)
      if (!path.endsWith('/old-file')) return result
      return {
        ...result,
        ...(mode === 'space' ? { space_id: 'other' } : mode === 'id' ? { id: 'other' } : { is_dir: true })
      }
    })
    expect((await s.service.syncApply({ baseId: 'local-1', planId: p.planId, confirmDeletes: false })).status).toBe(
      'partial'
    )
    expect(s.api.requestMultipart).not.toHaveBeenCalled()
    expect(s.api.request.mock.calls.some(([, opts]) => opts?.method === 'DELETE')).toBe(false)
  })

  it('归属不匹配禁止 DELETE，上传验证失败也不删除', async () => {
    const s = setupSync()
    s.get().manifest.entries.push({ itemId: 'i1', fileId: 'old-file', fileName: '原名.txt', hash: 'old' })
    const p = await s.service.syncPreview({ baseId: 'local-1' })
    const request = s.api.request.getMockImplementation()!
    s.api.request.mockImplementation(async (path: string, opts?: any) => {
      const result = await request(path, opts)
      return path.endsWith('/new-file') ? { ...result, file_hash: 'wrong' } : result
    })
    await s.service.syncApply({ baseId: 'local-1', planId: p.planId, confirmDeletes: false })
    expect(s.api.request.mock.calls.some(([, opts]) => opts?.method === 'DELETE')).toBe(false)
    expect(s.get().manifest.operations[0].phase).toBe('verifying')
  })

  it('写前落盘失败时不上传；验证失败保留新文件 ID', async () => {
    const s = setupSync()
    const p = await s.service.syncPreview({ baseId: 'local-1' })
    vi.mocked(orgStateStore.setShareAssociation).mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    await expect(s.service.syncApply({ baseId: 'local-1', planId: p.planId, confirmDeletes: false })).rejects.toThrow(
      'disk full'
    )
    expect(s.api.requestMultipart).not.toHaveBeenCalled()
    const next = await s.service.syncPreview({ baseId: 'local-1' })
    s.api.request.mockImplementation(async (path: string) =>
      path.includes('catalog') ? codeCatalog : { id: 'new-file', space_id: 'other', name: '原名.txt', is_dir: false }
    )
    expect((await s.service.syncApply({ baseId: 'local-1', planId: next.planId, confirmDeletes: false })).status).toBe(
      'unknown'
    )
    expect(s.get().manifest.operations[0]).toMatchObject({ newFileId: 'new-file', phase: 'verifying' })
  })

  it('无关联时状态为 unshared，历史关联缺 manifest 时为 unconfirmed', async () => {
    const service = makeService(makeApiClient())
    expect(await service.syncStatus({ baseId: 'local-1' })).toEqual({ state: 'unshared', lastSyncedAt: null })
    vi.mocked(orgStateStore.getShareAssociation).mockReturnValue({
      shareId: codeSpaceId,
      files: [],
      completion: 'completed'
    })
    expect(await service.syncStatus({ baseId: 'local-1' })).toEqual({ state: 'unconfirmed', lastSyncedAt: null })
  })

  it('历史关联预览不猜文件映射，也不上传', async () => {
    const api = makeApiClient()
    vi.mocked(orgStateStore.getShareAssociation).mockReturnValue({
      shareId: codeSpaceId,
      files: [],
      completion: 'completed'
    })
    const preview = await makeService(api).syncPreview({ baseId: 'local-1' })
    expect(preview).toMatchObject({ status: 'unconfirmed', changes: [], shareId: encodeOrgId(codeSpaceId) })
    expect(preview.warnings.length).toBeGreaterThan(0)
    expect(api.requestMultipart).not.toHaveBeenCalled()
  })
})

describe('分享码授权与结果', () => {
  beforeEach(() => vi.mocked(orgStateStore.getShareAssociations).mockReturnValue({}))

  // 仅允许本地关联副本，历史 owned 空间不能绕过来源约束。
  it('本地关联副本须有可信 owner，创建只读码并编码两个 ID', async () => {
    vi.mocked(orgStateStore.getShareAssociations).mockReturnValue({
      [JSON.stringify([lease.issuerId, lease.userId, lease.groupId, 'local'])]: {
        shareId: codeSpaceId,
        completion: 'completed',
        files: [{ fileName: 'a', status: 'success', fileId: encodeOrgId('f'), chunkCount: 1, error: null }]
      }
    })
    const api = makeApiClient()
    api.request.mockResolvedValueOnce(codeCatalog).mockResolvedValueOnce(codeShare)
    const result = await makeService(api).createShareCode({
      baseId: encodeOrgId(codeSpaceId),
      expireDays: 7,
      password: 'pass',
      maxViews: 2
    })
    expect(result).toEqual({
      id: encodeOrgId(codeShare.id),
      spaceId: encodeOrgId(codeSpaceId),
      shareCode: 'AbCd_123',
      shareType: 1,
      hasPassword: true,
      maxViews: null,
      viewCount: 0,
      expiresAt: null,
      revokedAt: null,
      createdAt: codeShare.created_at
    })
    expect(JSON.parse(api.request.mock.calls[1][1].body)).toEqual({
      share_type: 1,
      expire_days: 7,
      password: 'pass',
      max_views: 2
    })
  })

  it('本人完整副本允许永久只读分享且状态按账号隔离', async () => {
    vi.mocked(orgStateStore.getShareAssociations).mockReturnValue({
      [JSON.stringify([lease.issuerId, lease.userId, lease.groupId, 'local'])]: {
        shareId: codeSpaceId,
        completion: 'completed',
        files: [{ fileName: 'a', status: 'success', fileId: encodeOrgId('f'), chunkCount: 1, error: null }]
      },
      [JSON.stringify([lease.issuerId, 'other', lease.groupId, 'local'])]: {
        shareId: codeSpaceId,
        completion: 'incomplete',
        files: []
      }
    })
    const api = makeApiClient()
    api.request.mockResolvedValueOnce(codeCatalog).mockResolvedValueOnce(codeShare)
    expect(
      (await makeService(api).createShareCode({ baseId: encodeOrgId(codeSpaceId), expireDays: null })).shareCode
    ).toBe('AbCd_123')
    expect(JSON.parse(api.request.mock.calls[1][1].body)).toEqual({ share_type: 1, expire_days: null })
  })

  it('授权校验后切号不继续创建', async () => {
    const api = makeApiClient()
    api.request.mockImplementation(async () => {
      auth.assertLease.mockImplementation(() => {
        throw new Error('stale')
      })
      return codeCatalog
    })
    await expect(
      makeService(api).createShareCode({ baseId: encodeOrgId(codeSpaceId), expireDays: 7 })
    ).rejects.toMatchObject({ code: E.ORGKB_UNAUTHORIZED })
    expect(api.request.mock.calls).toHaveLength(1)
  })

  it.each([{ expireDays: 366 }, { password: 'bad' }, { maxViews: Number.MAX_SAFE_INTEGER + 1 }])(
    '直接服务调用拒绝无效分享参数',
    async (patch) => {
      const api = makeApiClient()
      await expect(
        makeService(api).createShareCode({ baseId: encodeOrgId(codeSpaceId), expireDays: 7, ...patch })
      ).rejects.toMatchObject({ code: E.ORGKB_BAD_INPUT })
      expect(api.request.mock.calls).toHaveLength(0)
    }
  )

  it.each(['incomplete', 'unconfirmed', 'completed'] as const)(
    '本机副本状态 %s 不允许未成功文件绕过',
    async (completion) => {
      vi.mocked(orgStateStore.getShareAssociations).mockReturnValue({
        [JSON.stringify([lease.issuerId, lease.userId, lease.groupId, 'local'])]: {
          shareId: codeSpaceId,
          completion,
          files: [{ fileName: 'a', status: 'unknown', fileId: null, chunkCount: null, error: null }]
        }
      })
      const api = makeApiClient()
      api.request.mockResolvedValue(codeCatalog)
      await expect(
        makeService(api).createShareCode({ baseId: encodeOrgId(codeSpaceId), expireDays: null })
      ).rejects.toMatchObject({ code: E.ORGKB_SHARE_INCOMPLETE })
      expect(api.request.mock.calls.filter((c) => c[1]?.method === 'POST')).toHaveLength(0)
    }
  )

  it.each([
    { public: [{ id: codeSpaceId, name: '公共', my_role: 'owner' }], shared: [], owned: codeCatalog.owned },
    { public: [], shared: [], owned: [{ id: codeSpaceId, name: '无 owner' }] },
    { public: [], shared: [{ id: codeSpaceId, name: '成员', my_role: 'admin' }], owned: [] }
  ])('拒绝公共、成员和 owner 不明的空间', async (catalog) => {
    const api = makeApiClient()
    api.request.mockResolvedValue(catalog)
    await expect(
      makeService(api).createShareCode({ baseId: encodeOrgId(codeSpaceId), expireDays: 7 })
    ).rejects.toMatchObject({ code: E.ORGKB_FORBIDDEN })
  })

  it('网络结果未知只发一次创建请求，提示 UI 查询列表', async () => {
    vi.mocked(orgStateStore.getShareAssociations).mockReturnValue({
      [JSON.stringify([lease.issuerId, lease.userId, lease.groupId, 'local'])]: {
        shareId: codeSpaceId,
        completion: 'completed',
        files: [{ fileName: 'a', status: 'success', fileId: encodeOrgId('f'), chunkCount: 1, error: null }]
      }
    })
    const api = makeApiClient()
    api.request.mockResolvedValueOnce(codeCatalog).mockRejectedValueOnce(new TypeError('fetch failed secret'))
    await expect(
      makeService(api).createShareCode({ baseId: encodeOrgId(codeSpaceId), expireDays: null })
    ).rejects.toMatchObject({ code: E.ORGKB_SHARE_CREATE_UNKNOWN })
    expect(api.request.mock.calls.filter((c) => c[1]?.method === 'POST')).toHaveLength(1)
  })

  it('直接领取返回原样名称和编码 baseId，不先消费公开访问', async () => {
    const api = makeApiClient()
    api.request.mockResolvedValue({
      id: codeSpaceId,
      name: ' 原样名称 ',
      space_kind: 'online',
      access_sources: ['share']
    })
    expect(await makeService(api).receiveShare({ shareCode: 'AbCd_123', password: 'pass' })).toEqual({
      baseId: encodeOrgId(codeSpaceId),
      name: ' 原样名称 '
    })
    expect(api.request.mock.calls).toEqual([
      ['/api/kb/v1/shares/AbCd_123/receive', expect.objectContaining({ method: 'POST', body: '{"password":"pass"}' })]
    ])
  })

  it('切号后丢弃分享列表', async () => {
    const api = makeApiClient()
    api.request.mockImplementation(async () => {
      auth.assertLease.mockImplementation(() => {
        throw new Error('stale')
      })
      return [codeShare]
    })
    await expect(makeService(api).shares({ baseId: encodeOrgId(codeSpaceId) })).rejects.toMatchObject({
      code: E.ORGKB_UNAUTHORIZED
    })
  })

  it('吊销编码 ID，支持 204', async () => {
    const api = makeApiClient()
    api.request.mockResolvedValue(undefined)
    expect(
      await makeService(api).revokeShare({ baseId: encodeOrgId(codeSpaceId), shareId: encodeOrgId(codeShare.id) })
    ).toEqual({ ok: true })
    expect(api.request.mock.calls[0]).toEqual([
      `/api/kb/v1/spaces/${codeSpaceId}/shares/${codeShare.id}`,
      { method: 'DELETE' }
    ])
  })
})

describe('OrgKnowledgeService catalog/items', () => {
  it('目录只返回当前身份上下文的本地关联，不按名称匹配', async () => {
    vi.mocked(orgStateStore.getShareAssociations).mockReturnValueOnce({
      [JSON.stringify(['server-1', 'u', 'g', 'local-1'])]: { shareId: 's1', completion: 'completed', files: [] },
      [JSON.stringify(['server-1', 'other', 'g', 'local-2'])]: { shareId: 's2', completion: 'completed', files: [] }
    })
    const api = makeApiClient()
    api.request.mockResolvedValue({
      public: [],
      shared: [],
      owned: [
        { id: 's1', name: '同名' },
        { id: 's2', name: '同名' }
      ]
    })
    const result = await makeService(api).catalog()
    expect(result.owned[0].localBaseId).toBe('local-1')
    expect(result.owned[1].localBaseId).toBeUndefined()
  })
  it('encodes server ids into orgkb: ids', async () => {
    const api = makeApiClient()
    api.request.mockResolvedValue({
      public: [],
      shared: [],
      owned: [{ id: 'space-1', name: 'Owned', description: null, document_count: 3 }]
    })
    const svc = makeService(api)
    const catalog = await svc.catalog()
    expect(catalog.owned[0].id.startsWith('orgkb:')).toBe(true)
    expect(catalog.owned[0].documentCount).toBe(3)
  })

  it('listItems rejects non-orgkb id with BAD_INPUT', async () => {
    const svc = makeService(makeApiClient())
    await expect(svc.listItems('not-orgkb')).rejects.toBeInstanceOf(OrgKnowledgeError)
    await expect(svc.listItems('not-orgkb')).rejects.toMatchObject({ code: E.ORGKB_BAD_INPUT })
  })

  it('listItems decodes and re-encodes, mapping field names', async () => {
    const api = makeApiClient()
    const rawBase = 'space-9'
    api.request.mockResolvedValue({
      items: [
        {
          id: 'it-1',
          base_id: rawBase,
          group_id: null,
          error: null,
          data: { source: 'a.txt', file_id: 'source-file' },
          type: 'file',
          title: 'T',
          status: 'completed',
          document_id: 'doc-1',
          created_at: '2026-10-15T00:00:00Z',
          updated_at: '2026-10-15T00:00:00Z'
        }
      ],
      total: 1
    })
    const svc = makeService(api)
    const page = await svc.listItems(encodeOrgId(rawBase))
    expect(page.items[0].id.startsWith('orgkb:')).toBe(true)
    expect(page.items[0].documentId?.startsWith('orgkb:')).toBe(true)
    expect(page.items[0].title).toBe('T')
    expect(page.items[0].fileId).toBe(encodeOrgId('source-file'))
  })

  it('缺少显式映射时仅接受文件接口确认的同一标识', async () => {
    const api = makeApiClient()
    api.request
      .mockResolvedValueOnce({
        items: [
          {
            id: 'item',
            base_id: 'base',
            group_id: null,
            type: 'file',
            title: '文件',
            status: 'completed',
            error: null,
            document_id: 'doc',
            data: { source: 'a.pdf' },
            created_at: '2026-10-15T00:00:00Z',
            updated_at: '2026-10-15T00:00:00Z'
          }
        ],
        total: 1
      })
      .mockResolvedValueOnce({ id: 'doc', is_dir: false })
    const page = await makeService(api).listItems(encodeOrgId('base'))
    expect(page.items[0].fileId).toBe(encodeOrgId('doc'))
    expect(api.request).toHaveBeenLastCalledWith('/api/kb/v1/files/doc')
  })

  it('inline HTML 仅回传纯文本，不作为可执行预览', async () => {
    const api = makeApiClient()
    api.request.mockResolvedValue({ kind: 'inline', file_name: 'a.html', mime_type: 'text/html; charset=utf-8' })
    api.requestText.mockResolvedValue('<script>alert(1)</script>')
    expect(await makeService(api).preview({ fileId: encodeOrgId('f') })).toMatchObject({
      kind: 'text',
      content: '<script>alert(1)</script>'
    })
    expect(api.requestBytes).not.toHaveBeenCalled()
  })

  it('不获取不受支持的活动图片类型', async () => {
    const api = makeApiClient()
    api.request.mockResolvedValue({ kind: 'inline', file_name: 'a.svg', mime_type: 'image/svg+xml' })
    expect(await makeService(api).preview({ fileId: encodeOrgId('f') })).not.toHaveProperty('base64')
    expect(api.requestBytes).not.toHaveBeenCalled()
  })

  it('账号切换后丢弃已到达的目录响应', async () => {
    const api = makeApiClient()
    vi.mocked(api.request).mockImplementation(async () => {
      auth.assertLease.mockImplementation(() => {
        throw new Error('stale')
      })
      return { public: [], shared: [], owned: [] }
    })
    await expect(makeService(api).catalog()).rejects.toMatchObject({ code: E.ORGKB_UNAUTHORIZED })
  })

  it('text 预览调用鉴权 preview 接口，不依赖签名 URL', async () => {
    const api = makeApiClient()
    vi.mocked(api.request).mockResolvedValue({ kind: 'text', file_name: 'a.docx' })
    vi.mocked(api.requestText).mockResolvedValue('解析正文')
    expect(await makeService(api).preview({ fileId: encodeOrgId('f:1') })).toMatchObject({ content: '解析正文' })
    expect(api.requestText).toHaveBeenCalledWith('/api/kb/v1/files/f%3A1/preview')
  })

  it('预览元信息到达后切号，不继续获取正文', async () => {
    const api = makeApiClient()
    api.request.mockImplementation(async () => {
      auth.assertLease.mockImplementation(() => {
        throw new Error('stale')
      })
      return { kind: 'text', file_name: 'a.docx' }
    })
    await expect(makeService(api).preview({ fileId: encodeOrgId('f') })).rejects.toMatchObject({
      code: E.ORGKB_UNAUTHORIZED
    })
    expect(api.requestText).not.toHaveBeenCalled()
  })

  it('PDF 返回原文字节供应用内渲染，不透传会触发下载的预签名地址', async () => {
    const api = makeApiClient()
    api.request.mockResolvedValue({
      kind: 'inline',
      file_name: 'a.pdf',
      mime_type: 'application/pdf',
      url: 'https://storage.example/a.pdf?signature=test'
    })
    expect(await makeService(api).preview({ fileId: encodeOrgId('f') })).toMatchObject({
      kind: 'inline',
      mimeType: 'application/pdf',
      base64: Buffer.from('%PDF-1.7').toString('base64')
    })
    expect(api.requestBytes).toHaveBeenCalledWith('/api/kb/v1/files/f/preview')
  })

  it.each(['javascript:alert(1)', 'file:///tmp/a.pdf', 'https://user:pass@storage.example/a.pdf'])(
    '拒绝不安全预览地址 %s',
    async (url) => {
      const api = makeApiClient()
      api.request.mockResolvedValue({ kind: 'inline', file_name: 'a.pdf', mime_type: 'application/pdf', url })
      await expect(makeService(api).preview({ fileId: encodeOrgId('f') })).rejects.toThrow()
    }
  )

  it('MIME 缺失时仅在 PDF 文件名与文件头一致后提供原文预览', async () => {
    const api = makeApiClient()
    api.request.mockResolvedValue({ kind: 'inline', file_name: '研究.PDF', mime_type: null })
    api.requestBytes.mockResolvedValue(Buffer.from('%PDF-1.7\n'))
    expect(await makeService(api).preview({ fileId: encodeOrgId('f') })).toMatchObject({
      kind: 'inline',
      mimeType: 'application/pdf',
      base64: Buffer.from('%PDF-1.7\n').toString('base64')
    })
  })

  it.each([
    ['fake.pdf', '<html>not a PDF</html>'],
    ['wrong.png', '%PDF-1.7\n'],
    ['empty.pdf', '']
  ])('MIME 缺失且文件名与内容不符时不提供预览：%s', async (fileName, content) => {
    const api = makeApiClient()
    api.request.mockResolvedValue({ kind: 'inline', file_name: fileName, mime_type: null })
    api.requestBytes.mockResolvedValue(Buffer.from(content))
    const result = await makeService(api).preview({ fileId: encodeOrgId('f') })
    expect(result.mimeType).toBeNull()
    expect(result).not.toHaveProperty('base64')
  })

  it('inline 预览不泄漏签名地址或将二进制当文本读取', async () => {
    const api = makeApiClient()
    api.request.mockResolvedValue({
      kind: 'inline',
      file_name: 'a.pdf',
      mime_type: 'application/pdf',
      // url: 'https://signed/f'
      url: null
    })
    expect(await makeService(api).preview({ fileId: encodeOrgId('f') })).toEqual({
      kind: 'inline',
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
      content: '',
      base64: Buffer.from('%PDF-1.7').toString('base64')
    })
    expect(api.requestBytes).toHaveBeenCalledWith('/api/kb/v1/files/f/preview')
    expect(api.requestText).not.toHaveBeenCalled()
  })

  it('拒绝直接服务调用中超过30天的邀请且不发请求', async () => {
    const api = makeApiClient()
    await expect(
      makeService(api).invite({ baseId: encodeOrgId('s'), userId: 1, expireDays: 31 })
    ).rejects.toMatchObject({ code: E.ORGKB_BAD_INPUT })
    expect(api.request).not.toHaveBeenCalled()
  })

  it('preview fetches content server-side without exposing the URL', async () => {
    const api = makeApiClient()
    api.request.mockResolvedValue({
      kind: 'text',
      url: 'https://signed/f',
      file_name: 'a.txt',
      mime_type: 'text/plain'
    })
    vi.mocked(api.requestText).mockResolvedValue('hello')
    const svc = makeService(api)
    const preview = await svc.preview({ fileId: encodeOrgId('f-1') })
    expect(preview.content).toBe('hello')
    expect(preview.kind).toBe('text')
    expect((preview as Record<string, unknown>).url).toBeUndefined()
    vi.unstubAllGlobals()
  })
})

describe('OrgKnowledgeService share', () => {
  it('注册不恢复的共享任务并通过 JobManager 返回已保存结果', async () => {
    const result = { shareId: 'space', files: [], completion: 'completed' as const }
    vi.mocked(orgStateStore.getShareAssociation).mockReturnValue(result)
    const service = makeService(makeApiClient())
    expect(shareJobs.registerHandler).toHaveBeenLastCalledWith(
      'enterprise.knowledge-share',
      expect.objectContaining({ recovery: 'abandon', execute: expect.any(Function) })
    )
    await expect(service.share('local-1')).resolves.toMatchObject({ shareId: encodeOrgId('space') })
    expect(shareJobs.enqueue).not.toHaveBeenCalled()
  })

  function fakeKS(items: Array<{ id: string; type: string }>, opts: { filePath?: string; chunks?: unknown[] } = {}) {
    return {
      listBasesForDiscovery: () => ({ items: [{ id: 'local-1', name: 'My Base' }], total: 1 }),
      listRootItems: () => items.map((item) => ({ status: 'completed', data: { relativePath: 'a.txt' }, ...item })),
      getFilePath: () => opts.filePath ?? '/mock/a.txt',
      listItemChunks: (_baseId: string, itemId: string) =>
        opts.chunks ?? [
          {
            id: 'c1',
            itemId,
            content: 'x',
            metadata: { chunkIndex: 0, tokenCount: 1, source: 'a.txt', itemType: 'file' }
          }
        ]
    }
  }

  beforeEach(() => {
    vi.mocked(application.get).mockImplementation((name: string) =>
      name === 'KnowledgeService' ? ({} as never) : (undefined as never)
    )
  })

  it('排队期间会话失效时任务执行阻断，不创建远端空间', async () => {
    const api = makeApiClient()
    makeService(api)
    auth.assertLease.mockImplementation(() => {
      throw new Error('会话失效')
    })
    const handler = shareJobs.registerHandler.mock.calls.at(-1)![1]
    const patchMetadata = vi.fn()
    await expect(
      handler.execute({
        input: { localBaseId: 'local-1', key: 'key', lease },
        signal: new AbortController().signal,
        patchMetadata,
        reportProgress: vi.fn()
      })
    ).rejects.toMatchObject({ code: E.ORGKB_UNAUTHORIZED })
    expect(patchMetadata).toHaveBeenCalledWith({ errorCode: E.ORGKB_UNAUTHORIZED })
    expect(api.request).not.toHaveBeenCalled()
  })

  it('取消后不继续上传后续文件，保留已确认结果与未确认清单', async () => {
    const api = makeApiClient()
    const controller = new AbortController()
    makeService(api)
    vi.mocked(application.get).mockReturnValue(
      fakeKS([
        { id: 'first', type: 'file' },
        { id: 'second', type: 'file' }
      ]) as never
    )
    api.request.mockResolvedValue({ share_id: 'space' })
    api.requestMultipart.mockImplementation(async () => {
      controller.abort(new Error('已取消'))
      return { share_id: 'space', file_id: 'file', chunk_count: 1 }
    })
    const handler = shareJobs.registerHandler.mock.calls.at(-1)![1]
    const ctx = {
      input: { localBaseId: 'local-1', key: 'key', lease },
      signal: controller.signal,
      patchMetadata: vi.fn(),
      reportProgress: vi.fn()
    }
    await expect(handler.execute(ctx)).rejects.toThrow('已取消')
    expect(api.requestMultipart).toHaveBeenCalledTimes(1)
    expect(orgStateStore.setShareAssociation).toHaveBeenLastCalledWith('key', {
      shareId: 'space',
      completion: 'incomplete',
      manifest: expect.objectContaining({ state: 'incomplete' }),
      files: [expect.objectContaining({ status: 'success' }), expect.objectContaining({ status: 'unknown' })]
    })
    expect(ctx.reportProgress).toHaveBeenCalledWith(50, expect.any(Object))
  })

  it.each(['success', 'failure', 'unknown'] as const)('重开保留 %s 结果及完成状态且不重传', async (status) => {
    vi.mocked(application.get).mockReturnValue(fakeKS([{ id: 'i1', type: 'file' }]) as never)
    let stored: unknown
    vi.mocked(orgStateStore.getShareAssociation).mockImplementation(() => stored as never)
    vi.mocked(orgStateStore.setShareAssociation).mockImplementation((_key, value) => {
      stored = structuredClone(value)
    })
    const api = makeApiClient()
    api.request.mockResolvedValue({ share_id: 's1' })
    if (status === 'success') api.requestMultipart.mockResolvedValue({ share_id: 's1', file_id: 'f1', chunk_count: 1 })
    else if (status === 'failure') {
      const { OrgApiHttpError } = await import('../OrgApiClient')
      api.requestMultipart.mockRejectedValue(new OrgApiHttpError(403, 'forbidden'))
    } else api.requestMultipart.mockRejectedValue(new TypeError('network'))
    const first = await makeService(api).share('local-1')
    const reopened = await makeService(api).share('local-1', true)
    expect(reopened.completion).toEqual(first.completion)
    expect(reopened.files[0].status).toBe(status)
    expect(reopened).toHaveProperty('completion', status === 'success' ? 'completed' : 'incomplete')
    expect(api.requestMultipart).toHaveBeenCalledTimes(1)
    expect(api.request).toHaveBeenCalledTimes(1)
  })

  it('旧共享关联标记为未确认', async () => {
    vi.mocked(orgStateStore.getShareAssociation).mockReturnValue({
      shareId: 's1',
      completion: 'unconfirmed',
      files: []
    })
    expect(await makeService(makeApiClient()).share('local-1')).toMatchObject({ completion: 'unconfirmed', files: [] })
  })

  it.each(['note', 'url', 'processing'])('混合库包含 %s 时预检阻断整个共享', async (kind) => {
    const unsupported =
      kind === 'processing' ? { id: 'bad', type: 'file', status: 'processing' } : { id: 'bad', type: kind }
    vi.mocked(application.get).mockReturnValue(fakeKS([{ id: 'ok', type: 'file' }, unsupported] as never) as never)
    const api = makeApiClient()
    api.request.mockResolvedValue({ share_id: 's1' })
    api.requestMultipart.mockResolvedValue({ share_id: 's1', file_id: 'f1', chunk_count: 1 })
    await expect(makeService(api).share('local-1')).rejects.toThrow(/bad/)
    expect(api.request).not.toHaveBeenCalled()
  })

  it.each(['note', 'url', 'processing'])('目录内无分块的 %s 也不能被静默遗漏', async (kind) => {
    vi.mocked(application.get).mockReturnValue(fakeKS([{ id: 'folder', type: 'directory' }]) as never)
    getSubtreeItems.mockReturnValue([
      { id: 'nested', type: kind === 'processing' ? 'file' : kind, status: kind === 'processing' ? kind : 'completed' }
    ] as never)
    const api = makeApiClient()
    api.request.mockResolvedValue({ share_id: 's1' })
    api.requestMultipart.mockResolvedValue({ share_id: 's1', file_id: 'f', chunk_count: 1 })
    await expect(makeService(api).share('local-1')).rejects.toThrow(/nested/)
    expect(api.request).not.toHaveBeenCalled()
  })

  it('throws BAD_INPUT when local base does not exist', async () => {
    const ks = { listBasesForDiscovery: () => ({ items: [], total: 0 }) }
    vi.mocked(application.get).mockImplementation((name: string) =>
      name === 'KnowledgeService' ? (ks as never) : (undefined as never)
    )
    const svc = makeService(makeApiClient())
    await expect(svc.share('local-1')).rejects.toMatchObject({ code: E.ORGKB_BAD_INPUT })
  })

  it('throws SHARE_NO_CONTENT when nothing is exportable', async () => {
    const ks = fakeKS([{ id: 'i1', type: 'note' }])
    vi.mocked(application.get).mockImplementation((name: string) =>
      name === 'KnowledgeService' ? (ks as never) : (undefined as never)
    )
    const svc = makeService(makeApiClient())
    await expect(svc.share('local-1')).rejects.toMatchObject({ code: E.ORGKB_SHARE_NO_CONTENT })
  })

  it('registers space, persists association, and uploads per file', async () => {
    const ks = fakeKS([{ id: 'i1', type: 'file' }])
    vi.mocked(application.get).mockImplementation((name: string) =>
      name === 'KnowledgeService' ? (ks as never) : (undefined as never)
    )
    const api = makeApiClient()
    api.request.mockResolvedValue({ share_id: 's1' })
    api.requestMultipart.mockResolvedValue({ share_id: 's1', file_id: 'f1', chunk_count: 1 })
    const svc = makeService(api)
    const result = await svc.share('local-1')
    expect(result.shareId.startsWith('orgkb:')).toBe(true)
    expect(result.files[0].status).toBe('success')
    expect(result.files[0].fileId).toBe(encodeOrgId('f1'))
    expect(api.requestMultipart).toHaveBeenCalled()
  })

  it('原文件不可读时不创建远端空间', async () => {
    const ks = fakeKS([{ id: 'i1', type: 'file' }])
    vi.mocked(application.get).mockReturnValue(ks as never)
    vi.mocked(stat).mockRejectedValue(new Error('ENOENT'))
    const api = makeApiClient()
    await expect(makeService(api).share('local-1')).rejects.toThrow('ENOENT')
    expect(api.request).not.toHaveBeenCalled()
  })

  it('跳过未完成文件及网页快照', async () => {
    const ks = fakeKS([
      { id: 'i1', type: 'file', status: 'processing' },
      { id: 'u', type: 'url', status: 'completed' }
    ] as never)
    vi.mocked(application.get).mockReturnValue(ks as never)
    const api = makeApiClient()
    await expect(makeService(api).share('local-1')).rejects.toMatchObject({ code: E.ORGKB_SHARE_NO_CONTENT })
    expect(api.request).not.toHaveBeenCalled()
  })

  it('上传协议分块并编码返回文件 ID，关联按账号隔离', async () => {
    vi.mocked(application.get).mockReturnValue(fakeKS([{ id: 'i1', type: 'file' }]) as never)
    const api = makeApiClient()
    vi.mocked(api.request).mockResolvedValue({ share_id: 's1' })
    vi.mocked(api.requestMultipart).mockResolvedValue({ share_id: 's1', file_id: 'f1', chunk_count: 1 })
    const result = await makeService(api).share('local-1')
    expect(result.files[0].fileId).toBe(encodeOrgId('f1'))
    const form = vi.mocked(api.requestMultipart).mock.calls[0][1]
    expect(JSON.parse(String(form.get('chunks')))).toEqual([
      {
        chunk_id: 'c1',
        item_id: 'i1',
        document_id: 'i1',
        content: 'x',
        metadata: { chunk_index: 0, token_count: 1, source: 'a.txt', item_type: 'file' }
      }
    ])
    expect(orgStateStore.setShareAssociation).toHaveBeenCalledWith(
      JSON.stringify(['server-1', 'u', 'g', 'local-1']),
      expect.objectContaining({ shareId: 's1', completion: 'completed', files: expect.any(Array) })
    )
  })

  it('创建空间期间切换账号后不写关联也不上传', async () => {
    vi.mocked(application.get).mockReturnValue(fakeKS([{ id: 'i1', type: 'file' }]) as never)
    const api = makeApiClient()
    vi.mocked(api.request).mockImplementation(async () => {
      auth.assertLease.mockImplementation(() => {
        throw new Error('stale')
      })
      return { share_id: 's1' }
    })
    await expect(makeService(api).share('local-1')).rejects.toMatchObject({ code: E.ORGKB_UNAUTHORIZED })
    expect(orgStateStore.setShareAssociation).not.toHaveBeenCalled()
    expect(api.requestMultipart).not.toHaveBeenCalled()
  })

  it('上传期间切换账号后停止后续文件且不返回旧账号结果', async () => {
    vi.mocked(application.get).mockReturnValue(
      fakeKS([
        { id: 'i1', type: 'file' },
        { id: 'i2', type: 'file' }
      ]) as never
    )
    const api = makeApiClient()
    api.request.mockResolvedValue({ share_id: 's1' })
    api.requestMultipart.mockImplementation(async () => {
      auth.assertLease.mockImplementation(() => {
        throw new Error('stale')
      })
      return { share_id: 's1', file_id: 'f1', chunk_count: 1 }
    })
    await expect(makeService(api).share('local-1')).rejects.toMatchObject({ code: E.ORGKB_UNAUTHORIZED })
    expect(api.requestMultipart).toHaveBeenCalledTimes(1)
  })

  it('保留部分成功并区分明确失败与结果未知，不重试上传', async () => {
    vi.mocked(application.get).mockReturnValue(
      fakeKS([
        { id: 'i1', type: 'file' },
        { id: 'i2', type: 'file' },
        { id: 'i3', type: 'file' }
      ]) as never
    )
    const { OrgApiHttpError } = await import('../OrgApiClient')
    const api = makeApiClient()
    api.request.mockResolvedValue({ share_id: 's1' })
    api.requestMultipart
      .mockResolvedValueOnce({ share_id: 's1', file_id: 'f1', chunk_count: 1 })
      .mockRejectedValueOnce(new OrgApiHttpError(403, 'forbidden'))
      .mockRejectedValueOnce(new TypeError('network'))
    const result = await makeService(api).share('local-1')
    expect(result.files.map((file) => file.status)).toEqual(['success', 'failure', 'failure'])
    expect(api.requestMultipart).toHaveBeenCalledTimes(2)
  })

  it('does not re-register an existing association', async () => {
    const ks = fakeKS([{ id: 'i1', type: 'file' }])
    vi.mocked(application.get).mockImplementation((name: string) =>
      name === 'KnowledgeService' ? (ks as never) : (undefined as never)
    )
    const stateStore = await import('../OrgStateStore')
    vi.mocked(stateStore.orgStateStore.getShareAssociation).mockReturnValue({
      shareId: 's1',
      completion: 'unconfirmed',
      files: []
    })
    const api = makeApiClient()
    api.requestMultipart.mockResolvedValue({ share_id: 's1', file_id: 'f1', chunk_count: 1 })
    const svc = makeService(api)
    await svc.share('local-1')
    expect(api.request).not.toHaveBeenCalledWith(expect.stringContaining('local-share/spaces'), expect.anything())
    expect(api.requestMultipart).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
  })

  it('并发分享同一本地库只创建和上传一次', async () => {
    vi.mocked(application.get).mockReturnValue(fakeKS([{ id: 'i1', type: 'file' }]) as never)
    let stored: ReturnType<typeof orgStateStore.getShareAssociation>
    vi.mocked(orgStateStore.getShareAssociation).mockImplementation(() => stored)
    vi.mocked(orgStateStore.setShareAssociation).mockImplementation((_key, id) => {
      stored = typeof id === 'string' ? { shareId: id, completion: 'unconfirmed', files: [] } : structuredClone(id)
    })
    const api = makeApiClient()
    api.request.mockResolvedValue({ share_id: 's1' })
    api.requestMultipart.mockResolvedValue({ share_id: 's1', file_id: 'f1', chunk_count: 1 })
    const svc = makeService(api)
    const results = await Promise.all([svc.share('local-1'), svc.share('local-1')])
    expect(results.map((result) => result.shareId)).toEqual([encodeOrgId('s1'), encodeOrgId('s1')])
    expect(api.requestMultipart).toHaveBeenCalledTimes(1)
    expect(api.request).toHaveBeenCalledTimes(1)
  })

  it('目录中的嵌套叶子分别上传原文件及对应分块', async () => {
    const ks = fakeKS([{ id: 'folder', type: 'directory' }], {
      chunks: [
        {
          id: 'c1',
          itemId: 'leaf1',
          content: '一',
          metadata: { chunkIndex: 0, itemType: 'file', source: 'leaf1.txt' }
        },
        { id: 'c2', itemId: 'leaf2', content: '二', metadata: { chunkIndex: 0, itemType: 'file', source: 'leaf2.txt' } }
      ]
    })
    getSubtreeItems.mockReturnValue([
      { id: 'leaf1', type: 'file', status: 'completed', data: { relativePath: 'leaf1.txt' } },
      { id: 'leaf2', type: 'file', status: 'completed', data: { relativePath: 'leaf2.txt' } }
    ] as never)
    const originalChunks = ks.listItemChunks
    ks.listItemChunks = (baseId, itemId) =>
      originalChunks(baseId, itemId).filter((chunk) => (chunk as { itemId: string }).itemId === itemId)
    ks.getFilePath = vi.fn().mockReturnValueOnce('/mock/leaf1.txt').mockReturnValueOnce('/mock/leaf2.txt')
    vi.mocked(application.get).mockReturnValue(ks as never)
    const api = makeApiClient()
    api.request.mockResolvedValue({ share_id: 's1' })
    api.requestMultipart.mockResolvedValue({ share_id: 's1', file_id: 'f1', chunk_count: 1 })
    const result = await makeService(api).share('local-1')
    expect(result.files.map((file) => file.fileName)).toEqual(['leaf1.txt', 'leaf2.txt'])
    expect(
      api.requestMultipart.mock.calls.map(([, form]) => JSON.parse(String(form.get('chunks')))[0].document_id)
    ).toEqual(['leaf1', 'leaf2'])
  })
})

describe('OrgKnowledgeService collaborators', () => {
  it('过滤本人并原样回传服务端 total（不虚构/扣减）', async () => {
    auth.acquireLease.mockReturnValue({ generation: 1, issuerId: 'server-1', groupId: 'g', userId: '7' })
    const api = makeApiClient()
    api.request.mockResolvedValue({
      items: [
        { id: 3, username: 'alice' },
        { id: 7, username: 'me' },
        { id: 9, username: 'carol' }
      ],
      total: 100,
      page: 1,
      pageSize: 20
    })
    const result = await makeService(api).collaborators({})
    expect(result.items).toEqual([
      { id: 3, username: 'alice' },
      { id: 9, username: 'carol' }
    ])
    expect(result.total).toBe(100)
    expect(api.request).toHaveBeenCalledWith('/api/collaborators')
  })

  it('透传 keyword/page/pageSize 到 /api/collaborators', async () => {
    const api = makeApiClient()
    api.request.mockResolvedValue({ items: [], total: 0, page: 2, pageSize: 20 })
    await makeService(api).collaborators({ keyword: 'bo', page: 2, pageSize: 20 })
    expect(api.request).toHaveBeenCalledWith('/api/collaborators?keyword=bo&page=2&pageSize=20')
  })
})

describe('OrgKnowledgeService invite（本地 baseId）', () => {
  const space = 'space-1'
  const association = { shareId: space, completion: 'completed' as const, files: [], manifest: {} as never }
  function ownerCatalog() {
    return { public: [], shared: [], owned: [{ id: space, name: 'n', my_role: 'owner' }] }
  }
  function mockApi(members: unknown[], addMemberResult?: unknown) {
    const api = makeApiClient()
    api.request.mockImplementation(async (path: string, options?: { method?: string }) => {
      if (path.includes('/catalog')) return ownerCatalog()
      if (path.includes('/members')) {
        if (options?.method === 'POST')
          return (
            addMemberResult ?? {
              user_id: 5,
              username: 'x',
              role: 'viewer',
              joined_at: '2026-01-01T00:00:00Z',
              status: 'pending',
              expires_at: null
            }
          )
        return members
      }
      return {}
    })
    return api
  }

  it('拒绝 orgkb 远端 id', async () => {
    const api = makeApiClient()
    await expect(makeService(api).invite({ baseId: encodeOrgId('s'), userId: 2 })).rejects.toMatchObject({
      code: E.ORGKB_BAD_INPUT
    })
    expect(api.request).not.toHaveBeenCalled()
  })

  it('使用当前账号的共享关联发送邀请', async () => {
    const key = JSON.stringify(['server-1', 'u', 'g', 'local-1'])
    vi.mocked(orgStateStore.getShareAssociation).mockImplementation((storedKey) =>
      storedKey === key ? association : undefined
    )
    const api = mockApi([])
    await expect(makeService(api).invite({ baseId: 'local-1', userId: 5 })).resolves.toMatchObject({
      userId: 5
    })
  })

  it.each([
    ['server-2', 'u', 'g', 'local-1'],
    ['server-1', 'other-user', 'g', 'local-1'],
    ['server-1', 'u', 'other-group', 'local-1']
  ])('拒绝其他身份上下文的关联 %s/%s/%s', async (issuerId, userId, groupId, baseId) => {
    const key = JSON.stringify([issuerId, userId, groupId, baseId])
    vi.mocked(orgStateStore.getShareAssociation).mockImplementation((storedKey) =>
      storedKey === key || storedKey === baseId ? association : undefined
    )
    const api = mockApi([])
    await expect(makeService(api).invite({ baseId, userId: 5 })).rejects.toMatchObject({
      code: E.ORGKB_BAD_INPUT
    })
    expect(api.request).not.toHaveBeenCalled()
  })

  it('缺少本地已完成关联时拒绝且不发请求', async () => {
    const api = makeApiClient()
    vi.mocked(orgStateStore.getShareAssociation).mockReturnValue(undefined)
    await expect(makeService(api).invite({ baseId: 'local-1', userId: 2 })).rejects.toMatchObject({
      code: E.ORGKB_BAD_INPUT
    })
    expect(api.request).not.toHaveBeenCalled()
  })

  it('本地关联未完成时拒绝', async () => {
    const api = makeApiClient()
    vi.mocked(orgStateStore.getShareAssociation).mockReturnValue({
      shareId: space,
      completion: 'incomplete',
      files: [],
      manifest: {} as never
    })
    await expect(makeService(api).invite({ baseId: 'local-1', userId: 2 })).rejects.toMatchObject({
      code: E.ORGKB_BAD_INPUT
    })
    expect(api.request).not.toHaveBeenCalled()
  })

  it('非本人 owner 空间被拒', async () => {
    const api = makeApiClient()
    vi.mocked(orgStateStore.getShareAssociation).mockReturnValue(association)
    api.request.mockResolvedValue({ public: [], shared: [], owned: [{ id: space, name: 'n', my_role: 'admin' }] })
    await expect(makeService(api).invite({ baseId: 'local-1', userId: 2 })).rejects.toMatchObject({
      code: E.ORGKB_FORBIDDEN
    })
    expect(api.request).not.toHaveBeenCalledWith(expect.stringContaining('/members'), expect.anything())
  })

  it('邀请本人被拒', async () => {
    auth.acquireLease.mockReturnValue({ generation: 1, issuerId: 'server-1', groupId: 'g', userId: '2' })
    const api = mockApi([])
    vi.mocked(orgStateStore.getShareAssociation).mockReturnValue(association)
    await expect(makeService(api).invite({ baseId: 'local-1', userId: 2 })).rejects.toMatchObject({
      code: E.ORGKB_BAD_INPUT
    })
  })

  it('已有 active 成员时阻止重复邀请', async () => {
    const api = mockApi([
      {
        user_id: 5,
        username: 'x',
        role: 'viewer',
        joined_at: '2026-01-01T00:00:00Z',
        status: 'active',
        expires_at: null
      }
    ])
    vi.mocked(orgStateStore.getShareAssociation).mockReturnValue(association)
    await expect(makeService(api).invite({ baseId: 'local-1', userId: 5 })).rejects.toMatchObject({
      code: E.ORGKB_MEMBER_EXISTS
    })
    expect(api.request).not.toHaveBeenCalledWith(
      expect.stringContaining('/members'),
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('已有 pending 成员时同样阻止', async () => {
    const api = mockApi([
      {
        user_id: 5,
        username: 'x',
        role: 'viewer',
        joined_at: '2026-01-01T00:00:00Z',
        status: 'pending',
        expires_at: null
      }
    ])
    vi.mocked(orgStateStore.getShareAssociation).mockReturnValue(association)
    await expect(makeService(api).invite({ baseId: 'local-1', userId: 5 })).rejects.toMatchObject({
      code: E.ORGKB_MEMBER_EXISTS
    })
  })

  it('expired 成员可重新邀请', async () => {
    const api = mockApi([
      {
        user_id: 5,
        username: 'x',
        role: 'viewer',
        joined_at: '2026-01-01T00:00:00Z',
        status: 'expired',
        expires_at: null
      }
    ])
    vi.mocked(orgStateStore.getShareAssociation).mockReturnValue(association)
    const result = await makeService(api).invite({ baseId: 'local-1', userId: 5 })
    expect(result).toMatchObject({ userId: 5, status: 'pending' })
    expect(api.request).toHaveBeenCalledWith(
      `/api/kb/v1/spaces/${space}/members`,
      expect.objectContaining({ method: 'POST', body: expect.stringContaining('"user_id":5') })
    )
  })

  it('removed 成员可重新邀请', async () => {
    const api = mockApi([
      {
        user_id: 5,
        username: 'x',
        role: 'viewer',
        joined_at: '2026-01-01T00:00:00Z',
        status: 'removed',
        expires_at: null
      }
    ])
    vi.mocked(orgStateStore.getShareAssociation).mockReturnValue(association)
    const result = await makeService(api).invite({ baseId: 'local-1', userId: 5 })
    expect(result).toMatchObject({ userId: 5 })
  })

  it('无现成成员时正常发起邀请', async () => {
    const api = mockApi([])
    vi.mocked(orgStateStore.getShareAssociation).mockReturnValue(association)
    const result = await makeService(api).invite({ baseId: 'local-1', userId: 5 })
    expect(result).toMatchObject({ userId: 5, status: 'pending' })
  })
})

describe('OrgKnowledgeService createShareCode 本地关联约束', () => {
  it('拒绝无本地关联的空间（仅允许本地知识库）', async () => {
    const api = makeApiClient()
    api.request.mockResolvedValue({
      public: [],
      shared: [],
      owned: [{ id: codeSpaceId, name: '副本', my_role: 'owner' }]
    })
    vi.mocked(orgStateStore.getShareAssociations).mockReturnValue({})
    await expect(
      makeService(api).createShareCode({ baseId: encodeOrgId(codeSpaceId), expireDays: 7 })
    ).rejects.toMatchObject({ code: E.ORGKB_FORBIDDEN })
    expect(api.request).not.toHaveBeenCalledWith(expect.stringContaining('/shares'), expect.anything())
  })
})
