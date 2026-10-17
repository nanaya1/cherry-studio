import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { application } from '@application'
import { knowledgeItemService } from '@data/services/KnowledgeItemService'

import { OrgApiClient } from '../OrgApiClient'
import { OrgKnowledgeService } from '../OrgKnowledgeService'
import { orgStateStore } from '../OrgStateStore'

vi.mock('@data/services/KnowledgeItemService', () => ({ knowledgeItemService: { getSubtreeItems: () => [] } }))
vi.mock('../OrgStateStore', () => {
  const states = new Map()
  const shares = new Map()
  return {
    orgStateStore: {
      getFirstShareUpload: (key: string) => structuredClone(states.get(key)),
      setFirstShareUpload: (key: string, value: unknown) => states.set(key, structuredClone(value)),
      getShareAssociation: (key: string) => shares.get(key),
      setShareAssociation: (key: string, value: unknown) => shares.set(key, structuredClone(value)),
      reset: () => {
        states.clear()
        shares.clear()
      }
    }
  }
})
let root: string
let file: string
let service: OrgKnowledgeService
let api: {
  request: ReturnType<typeof vi.fn<(path: string) => Promise<unknown>>>
  requestFileMultipart: ReturnType<typeof vi.fn>
}
beforeEach(async () => {
  ;(orgStateStore as any).reset()
  root = await mkdtemp(join(tmpdir(), 'first-share-'))
  file = join(root, '原文.txt')
  await writeFile(file, 'file-bytes')
  vi.mocked(application.get).mockReturnValue({
    listBasesForDiscovery: ({ scope }: any) => ({ items: [{ id: scope.baseIds[0], name: scope.baseIds[0] }] }),
    listRootItems: () => [{ id: 'i', type: 'file', status: 'completed', data: { relativePath: '原文.txt' } }],
    getFilePath: () => file,
    listItemChunks: async () => [
      { id: 'c', itemId: 'i', content: '正文', metadata: { chunkIndex: 0, itemType: 'file' } }
    ]
  } as never)
  api = {
    request: vi.fn(async (path: string) => {
      if (path.endsWith('/local-share/spaces')) return { share_id: 'space' }
      if (path.endsWith('/files/file'))
        return {
          id: 'file',
          space_id: 'space',
          name: '原文.txt',
          is_dir: false,
          file_hash: createHash('sha256').update('file-bytes').digest('hex')
        }
      const item = {
        id: 'item',
        base_id: 'space',
        group_id: null,
        type: 'file',
        title: '原文.txt',
        status: 'completed',
        error: null,
        document_id: 'file',
        data: { file_id: 'file' },
        created_at: '2026-10-16T00:00:00Z',
        updated_at: '2026-10-16T00:00:00Z'
      }
      if (path.endsWith('/chunks'))
        return {
          chunks: [
            { chunk_id: 'rc', item_id: 'item', document_id: 'file', content: '正文', metadata: { chunk_index: 0 } }
          ],
          total: 1
        }
      if (path.endsWith('/items')) return { items: [item], total: 1 }
      return item
    }),
    requestFileMultipart: vi.fn(async (_path, _entry, progress) => {
      progress(4)
      progress(10)
      return { share_id: 'space', file_id: 'file', chunk_count: 1 }
    })
  }
  service = new OrgKnowledgeService({
    apiClient: api,
    acquireLease: () => ({ issuerId: 's', userId: 'u', groupId: 'g', generation: 1 }),
    assertLease: () => {}
  } as never)
})
afterEach(async () => {
  service.dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})
it('同库复用promise，异库在第一个await前拒绝，未创建第二个远端库', async () => {
  const first = service.share('A')
  expect(service.share('A')).toBe(first)
  await expect(service.share('B')).rejects.toThrow('「A」正在上传云端，请完成后再试')
  expect((await first).completion).toBe('completed')
  expect(api.request.mock.calls.filter(([path]) => path.endsWith('/local-share/spaces'))).toHaveLength(1)
  expect(await service.uploadStatus('A')).toMatchObject({ phase: 'completed', uploadedBytes: 10, completedFiles: 1 })
})
it.each(['create', 'upload', 'file', 'items', 'item', 'chunks'])(
  '%s请求无响应超时后释放全局busy，保留unknown且重开不重传',
  async (stage) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), ms)
      return controller.signal
    })
    let blocked = true
    const started = Promise.withResolvers<void>()
    const writes = { create: 0, upload: 0 }
    vi.stubGlobal('fetch', async (url: URL | string, init: RequestInit) => {
      const path = new URL(url).pathname
      const current = path.endsWith('/local-share/spaces')
        ? 'create'
        : path.includes('/local-share/')
          ? 'upload'
          : path.endsWith('/files/file')
            ? 'file'
            : path.endsWith('/chunks')
              ? 'chunks'
              : path.endsWith('/items')
                ? 'items'
                : 'item'
      if (current === 'create' || current === 'upload') writes[current]++
      if (blocked && current === stage) {
        started.resolve()
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
        })
      }
      if (current === 'upload') return Response.json({ share_id: 'space', file_id: 'file', chunk_count: 1 })
      return Response.json(await api.request(path))
    })
    service.dispose()
    service = new OrgKnowledgeService({
      apiClient: new OrgApiClient(async () => ({ accessToken: 'token' }) as never),
      acquireLease: () => ({ issuerId: 's', userId: 'u', groupId: 'g', generation: 1 }),
      assertLease: () => {}
    } as never)
    const first = service.share('A')
    await started.promise
    await expect(service.share('B')).rejects.toThrow('正在上传云端')
    await vi.advanceTimersByTimeAsync(stage === 'upload' ? 300_000 : 30_000)
    expect(await service.uploadStatus('A')).toMatchObject({ phase: 'paused' })
    const result = await first
    expect(result.completion).toBe('incomplete')
    if (stage !== 'create') expect(result.files[0].status).toBe('unknown')
    const before = { ...writes }
    blocked = false
    await service.share('A', true)
    expect(writes).toEqual(before)
    expect((await service.share('B')).completion).toBe('completed')
  }
)

it.each([20 * 1024 * 1024, 20 * 1024 * 1024 + 1, 2 ** 31, 2 ** 31 + 1])(
  'stat统计%s字节后允许进入分块阶段，中止以避免大文件读取和远端写入',
  async (size) => {
    await truncate(file, size)
    const ks = application.get('KnowledgeService')
    const chunks = vi.spyOn(ks, 'listItemChunks').mockRejectedValue(new Error('测试中止：stat已放行'))
    await expect(service.share('A')).rejects.toThrow('测试中止：stat已放行')
    expect(chunks).toHaveBeenCalledWith('A', 'i')
    expect(api.request).not.toHaveBeenCalled()
    expect(api.requestFileMultipart).not.toHaveBeenCalled()
  }
)
it.each([20 * 1024 * 1024 - 1, 20 * 1024 * 1024, 20 * 1024 * 1024 + 1])(
  '根文件与子目录叶子累计%s字节仍完成首次分享',
  async (total) => {
    await truncate(file, total - 10)
    const leaf = join(root, '子目录原文.txt')
    await writeFile(leaf, 'file-bytes')
    const ks = application.get('KnowledgeService')
    vi.spyOn(ks, 'listRootItems').mockReturnValue([
      { id: 'i', type: 'file', status: 'completed', data: { relativePath: '原文.txt' } },
      // { id: 'dir', type: 'directory', status: 'completed' }
      { id: 'dir', type: 'directory', status: 'completed', data: { relativePath: '资料' } }
    ] as never)
    vi.spyOn(knowledgeItemService, 'getSubtreeItems').mockReturnValue([
      // { id: 'nested', type: 'directory', status: 'completed' },
      // { id: 'leaf', type: 'file', status: 'completed', data: { relativePath: '子目录/原文.txt' } }
      { id: 'nested', groupId: 'dir', type: 'directory', status: 'completed', data: { relativePath: '资料/子目录' } },
      {
        id: 'leaf',
        groupId: 'nested',
        type: 'file',
        status: 'completed',
        data: { relativePath: '资料/子目录/原文.txt' }
      }
    ] as never)
    vi.spyOn(ks, 'getFilePath').mockImplementation((id) => (id === 'leaf' ? leaf : file) as never)
    vi.spyOn(service as any, 'verifyFirstShareFile').mockResolvedValue(undefined)
    const request = api.request.getMockImplementation()!
    const folders = new Map<string, any>()
    api.request.mockImplementation(async (path: string, options?: any) => {
      if (path.endsWith('/folders')) {
        const data = JSON.parse(options.body)
        const id = `folder-${folders.size}`
        folders.set(id, { id, space_id: 'space', is_dir: true, ...data })
        return { folder_id: id, space_id: 'space', ...data }
      }
      return folders.get(path.split('/').at(-1)!) ?? request(path)
    })
    expect((await service.share('A')).completion).toBe('completed')
    expect([...folders.values()].map((folder) => [folder.name, folder.parent_id])).toEqual([
      ['资料', null],
      ['子目录', 'folder-0']
    ])
    expect(api.requestFileMultipart.mock.calls.find(([, value]) => value.itemId === 'leaf')?.[1].parentId).toBe(
      'folder-1'
    )
    expect(await service.uploadStatus('A')).toMatchObject({ totalBytes: total, completedFiles: 2 })
    expect(api.requestFileMultipart).toHaveBeenCalledTimes(2)
  }
)
it.each(['parent', 'space', 'type'])('远端目录%s异常时暂停且不上传文件，重启状态不误判完成', async (mismatch) => {
  const ks = application.get('KnowledgeService')
  vi.spyOn(ks, 'listRootItems').mockReturnValue([
    { id: 'dir', type: 'directory', status: 'completed', data: { relativePath: '资料' } }
  ] as never)
  const request = api.request.getMockImplementation()!
  api.request.mockImplementation(async (path: string) => {
    if (path.endsWith('/folders')) return { folder_id: 'folder', space_id: 'space', name: '资料', parent_id: null }
    if (path.endsWith('/files/folder'))
      return {
        id: 'folder',
        space_id: mismatch === 'space' ? 'other' : 'space',
        name: '资料',
        parent_id: mismatch === 'parent' ? 'other' : null,
        is_dir: mismatch !== 'type'
      }
    return request(path)
  })
  expect((await service.share('A')).completion).toBe('incomplete')
  expect(api.requestFileMultipart).not.toHaveBeenCalled()
  service.dispose()
  service = new OrgKnowledgeService({
    apiClient: api,
    acquireLease: () => ({ issuerId: 's', userId: 'u', groupId: 'g', generation: 1 }),
    assertLease: () => {}
  } as never)
  expect(await service.uploadStatus('A')).toMatchObject({ phase: 'paused', error: '远端目录名称或归属尚未确认' })
})
it('重开核对成功且未变化的文件，不重复上传', async () => {
  expect((await service.share('A')).completion).toBe('completed')
  expect((await service.share('A')).completion).toBe('completed')
  expect(api.requestFileMultipart).toHaveBeenCalledTimes(1)
})
it('历史已关联的库原文件变大后仍复用副本，不读取或重传原文件', async () => {
  expect((await service.share('A')).completion).toBe('completed')
  await truncate(file, 20 * 1024 * 1024)
  api.request.mockClear()
  api.requestFileMultipart.mockClear()
  expect((await service.share('A')).completion).toBe('completed')
  expect(api.request).not.toHaveBeenCalled()
  expect(api.requestFileMultipart).not.toHaveBeenCalled()
})
it('核对入口没有历史任务时不得创建云端库', async () => {
  await expect(service.share('A', true)).rejects.toThrow('没有可核对')
  expect(api.request).not.toHaveBeenCalled()
})
