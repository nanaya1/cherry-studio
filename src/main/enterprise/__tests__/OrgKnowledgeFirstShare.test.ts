import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, readFile, rm, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { application } from '@application'
import { knowledgeItemService } from '@data/services/KnowledgeItemService'

import { OrgApiClient } from '../OrgApiClient'
import { OrgKnowledgeService } from '../OrgKnowledgeService'
import { orgStateStore } from '../OrgStateStore'

vi.mock('../KnowledgeSourceBindings', () => ({ replaceKnowledgeSourceBindings: vi.fn() }))

vi.mock('@data/services/KnowledgeItemService', () => ({ knowledgeItemService: { getSubtreeItems: () => [] } }))
vi.mock('../OrgStateStore', () => {
  const states = new Map()
  const shares = new Map()
  return {
    orgStateStore: {
      getFirstShareUpload: (key: string) => structuredClone(states.get(key)),
      setFirstShareUpload: (key: string, value: unknown) => states.set(key, structuredClone(value)),
      clearShare: (key: string) => {
        states.delete(key)
        shares.delete(key)
      },
      moveOwnedSpace: vi.fn(),
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
  request: ReturnType<typeof vi.fn<(path: string, options?: any) => Promise<unknown>>>
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
  let policy = true
  api = {
    request: vi.fn(async (path: string, options?: any) => {
      if (path.endsWith('/spaces/space')) return { id: 'space', name: '库', allow_local_file_upload: policy }
      if (path.endsWith('/local-share/spaces')) {
        policy = options?.body
          ? JSON.parse(options.body).allow_local_file_upload
          : (orgStateStore.getFirstShareUpload(JSON.stringify(['s', 'u', 'g', 'A']))?.uploadOriginal ?? true)
        return { share_id: 'space' }
      }
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
it('首次上传失败自动删除本次空间并保留本机原件，允许重新首传', async () => {
  const original = api.request.getMockImplementation()!
  api.request.mockImplementation(async (path, options?: any) => {
    if (path.includes('/catalog'))
      return { owned: [{ id: 'space', name: '库', my_role: 'owner' }], shared: [], public: [] }
    if (options?.method === 'DELETE') return undefined
    return original(path, options)
  })
  api.requestFileMultipart.mockRejectedValueOnce(new Error('上传中断'))
  // expect((await service.share('A')).completion).toBe('incomplete')
  expect(await service.share('A')).toMatchObject({ completion: 'incomplete', error: '上传中断' })
  const key = JSON.stringify(['s', 'u', 'g', 'A'])
  expect(api.request.mock.calls.filter(([, options]: any) => options?.method === 'DELETE')).toHaveLength(1)
  expect(orgStateStore.getFirstShareUpload(key)).toBeUndefined()
  expect(orgStateStore.getShareAssociation(key)).toBeUndefined()
  expect(await readFile(file, 'utf8')).toBe('file-bytes')
  expect(await service.uploadStatus('A')).toBeNull()
  expect((await service.share('A')).completion).toBe('completed')
})

it('第N个文件失败删除整次首传，已成功文件不触碰本机索引', async () => {
  const ks = application.get('KnowledgeService')
  vi.spyOn(ks, 'listRootItems').mockReturnValue([
    { id: 'i', type: 'file', status: 'completed', data: { relativePath: '原文.txt' } },
    { id: 'j', type: 'file', status: 'completed', data: { relativePath: '原文.txt' } }
  ] as never)
  const original = api.request.getMockImplementation()!
  api.request.mockImplementation(async (path, options?: any) => {
    if (path.includes('/catalog'))
      return { owned: [{ id: 'space', name: '库', my_role: 'owner' }], shared: [], public: [] }
    if (options?.method === 'DELETE') {
      expect(orgStateStore.getFirstShareUpload(JSON.stringify(['s', 'u', 'g', 'A']))?.cleanup?.phase).toBe('intent')
      return undefined
    }
    return original(path, options)
  })
  api.requestFileMultipart
    .mockResolvedValueOnce({ share_id: 'space', file_id: 'file', chunk_count: 1 })
    .mockRejectedValueOnce(new Error('第二个文件失败'))
  expect((await service.share('A')).completion).toBe('incomplete')
  expect(api.requestFileMultipart).toHaveBeenCalledTimes(2)
  expect(orgStateStore.getFirstShareUpload(JSON.stringify(['s', 'u', 'g', 'A']))).toBeUndefined()
  expect(await readFile(file, 'utf8')).toBe('file-bytes')
})

it('创建响应丢失没有可信ID不猜删，重启后仍阻断创建', async () => {
  api.request.mockRejectedValueOnce(new Error('创建响应丢失'))
  await service.share('A')
  service.dispose()
  service = new OrgKnowledgeService({
    apiClient: api,
    acquireLease: () => ({ issuerId: 's', userId: 'u', groupId: 'g', generation: 1 }),
    assertLease: () => {}
  } as never)
  expect(await service.uploadStatus('A')).toMatchObject({ phase: 'cleanup_unknown' })
  await expect(service.share('A')).rejects.toThrow()
  expect(api.request).toHaveBeenCalledTimes(1)
  expect(api.requestFileMultipart).not.toHaveBeenCalled()
})

it('DELETE成功后切号按原key记deleted，原账号重登仅清本地不重发', async () => {
  let switched = false
  const original = api.request.getMockImplementation()!
  api.request.mockImplementation(async (path, options?: any) => {
    if (path.includes('/catalog'))
      return { owned: [{ id: 'space', name: '库', my_role: 'owner' }], shared: [], public: [] }
    if (options?.method === 'DELETE') {
      switched = true
      return undefined
    }
    return original(path, options)
  })
  service.dispose()
  service = new OrgKnowledgeService({
    apiClient: api,
    acquireLease: () => ({ issuerId: 's', userId: switched ? 'other' : 'u', groupId: 'g', generation: 1 }),
    assertLease: (lease: any) => {
      if (lease.userId !== (switched ? 'other' : 'u')) throw new Error('stale')
    }
  } as never)
  api.requestFileMultipart.mockRejectedValueOnce(new Error('中断'))
  await expect(service.share('A')).rejects.toThrow('组织账号已切换')
  const key = JSON.stringify(['s', 'u', 'g', 'A'])
  expect(orgStateStore.getFirstShareUpload(key)?.cleanup?.phase).toBe('deleted')
  expect(await service.uploadStatus('A')).toBeNull()
  switched = false
  expect(await service.uploadStatus('A')).toBeNull()
  expect(orgStateStore.getFirstShareUpload(key)).toBeUndefined()
  expect(api.request.mock.calls.filter(([, options]) => options?.method === 'DELETE')).toHaveLength(1)
})

it('可信pending重启先补偿，不再次上传或创建', async () => {
  const key = JSON.stringify(['s', 'u', 'g', 'A'])
  orgStateStore.setFirstShareUpload(key, {
    name: '库',
    creation: 'created',
    shareId: 'space',
    taskId: 'task',
    createdByTask: 'task',
    cleanup: { phase: 'pending', error: '崩溃' },
    files: []
  })
  api.request.mockImplementation(async (_path, options?: any) =>
    options?.method === 'DELETE'
      ? undefined
      : { owned: [{ id: 'space', name: '库', my_role: 'owner' }], shared: [], public: [] }
  )
  expect(await service.uploadStatus('A')).toBeNull()
  expect(orgStateStore.getFirstShareUpload(key)).toBeUndefined()
  expect(api.requestFileMultipart).not.toHaveBeenCalled()
  expect(api.request.mock.calls.filter(([, options]) => options?.method === 'DELETE')).toHaveLength(1)
})

it('已有completed关联及追加失败不能回滚整库', async () => {
  const key = JSON.stringify(['s', 'u', 'g', 'A'])
  orgStateStore.setShareAssociation(key, { shareId: 'space', files: [], completion: 'incomplete' })
  orgStateStore.setFirstShareUpload(key, {
    name: '追加',
    creation: 'created',
    shareId: 'space',
    uploadOriginal: true,
    files: [
      {
        itemId: 'i',
        fileName: '原文.txt',
        size: 10,
        hash: createHash('sha256').update('file-bytes').digest('hex'),
        fingerprint: 'changed',
        phase: 'pending',
        fileId: null,
        error: null,
        uploadOriginal: true
      }
    ]
  })
  await service.share('A')
  expect(api.request.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false)
  expect(orgStateStore.getFirstShareUpload(key)?.cleanup).toBeUndefined()
  orgStateStore.setShareAssociation(key, { shareId: 'space', files: [], completion: 'completed' })
  const saved = orgStateStore.getFirstShareUpload(key)!
  saved.cleanup = { phase: 'pending', error: '旧错误' }
  orgStateStore.setFirstShareUpload(key, saved)
  expect((await service.share('A')).completion).toBe('completed')
  expect(api.request.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false)
})

it('删除结果未知持久阻断重建、上传与自动重放DELETE', async () => {
  const original = api.request.getMockImplementation()!
  api.request.mockImplementation(async (path, options?: any) => {
    if (path.includes('/catalog'))
      return { owned: [{ id: 'space', name: '库', my_role: 'owner' }], shared: [], public: [] }
    if (options?.method === 'DELETE') throw new Error('断网')
    return original(path, options)
  })
  api.requestFileMultipart.mockRejectedValueOnce(new Error('上传中断'))
  await service.share('A')
  expect(await service.uploadStatus('A')).toMatchObject({ phase: 'cleanup_unknown' })
  await expect(service.share('A')).rejects.toThrow()
  expect(api.request.mock.calls.filter(([, options]: any) => options?.method === 'DELETE')).toHaveLength(1)
  expect(api.requestFileMultipart).toHaveBeenCalledTimes(1)
  expect(orgStateStore.getShareAssociation(JSON.stringify(['s', 'u', 'g', 'A']))).toBeUndefined()
})

it.each(['create', 'folder', 'upload'])('真实传输 %s 成功后切号：原账号固化ID并停止，恢复不重放', async (stage) => {
  if (stage === 'folder') {
    vi.spyOn(application.get('KnowledgeService'), 'listRootItems').mockReturnValue([
      { id: 'dir', type: 'directory', status: 'completed', data: { relativePath: '资料' } }
    ] as never)
  }
  let switched = false
  const writes: string[] = []
  const fetcher = vi.fn(async (url: URL | string, init: RequestInit) => {
    const path = new URL(url).pathname
    const current = path.endsWith('/local-share/spaces')
      ? 'create'
      : path.endsWith('/folders')
        ? 'folder'
        : path.includes('/local-share/')
          ? 'upload'
          : 'read'
    if (current !== 'read') writes.push(current)
    let response: unknown
    if (current === 'folder') response = { folder_id: 'folder', space_id: 'space', name: '资料', parent_id: null }
    else if (path.endsWith('/files/folder'))
      response = { id: 'folder', space_id: 'space', name: '资料', parent_id: null, is_dir: true }
    else if (current === 'upload') {
      await new Response(init.body).arrayBuffer()
      response = { share_id: 'space', file_id: 'file', chunk_count: 1 }
    } else response = await api.request(path)
    if (current === stage) switched = true
    return Response.json(response)
  })
  vi.stubGlobal('fetch', fetcher)
  service.dispose()
  service = new OrgKnowledgeService({
    apiClient: new OrgApiClient(
      async () => ({ issuerId: 's', userId: switched ? 'other' : 'u', groupId: 'g', accessToken: 'token' }) as never
    ),
    acquireLease: () => ({ issuerId: 's', userId: switched ? 'other' : 'u', groupId: 'g', generation: 1 }),
    assertLease: (lease: { userId: string }) => {
      if (lease.userId !== (switched ? 'other' : 'u')) throw new Error('stale')
    }
  } as never)
  await expect(service.share('A')).rejects.toThrow('组织账号已切换')
  const key = JSON.stringify(['s', 'u', 'g', 'A'])
  const saved = orgStateStore.getFirstShareUpload(key)!
  expect(saved).toMatchObject({ creation: 'created', shareId: 'space' })
  if (stage === 'folder') expect(saved.folders?.[0].folderId).toBe('folder')
  if (stage === 'upload') expect(saved.files[0].fileId).toBe('file')
  expect(orgStateStore.getFirstShareUpload(JSON.stringify(['s', 'other', 'g', 'A']))).toBeUndefined()
  expect(orgStateStore.getShareAssociation(key)).toBeUndefined()
  const before = [...writes]
  switched = false
  await expect(service.share('A', true)).rejects.toThrow('首次分享已中断')
  expect(orgStateStore.getFirstShareUpload(key)?.cleanup).toBeDefined()
  expect(writes).toEqual(before)
})

it.each(
  ['create', 'folder', 'upload'].flatMap((stage) => ['switch', 'wrong-session'].map((mode) => ({ stage, mode })))
)('真实传输 $stage 凭据获取期间 $mode 禁止发请求', async ({ stage, mode }) => {
  if (stage === 'folder') {
    vi.spyOn(application.get('KnowledgeService'), 'listRootItems').mockReturnValue([
      { id: 'dir', type: 'directory', status: 'completed', data: { relativePath: '资料' } }
    ] as never)
  }
  let switched = false
  let credentials = 0
  const fetcher = vi.fn(async (url: URL | string) => {
    const path = new URL(url).pathname
    return Response.json(await api.request(path))
  })
  vi.stubGlobal('fetch', fetcher)
  service.dispose()
  service = new OrgKnowledgeService({
    apiClient: new OrgApiClient(async () => {
      credentials++
      if (credentials === (stage === 'create' ? 1 : stage === 'folder' ? 3 : 4)) switched = true
      return { issuerId: 's', userId: switched ? 'other' : 'u', groupId: 'g', accessToken: 'token' } as never
    }),
    acquireLease: () => ({ issuerId: 's', userId: 'u', groupId: 'g', generation: 1 }),
    assertLease: () => {
      if (switched && mode === 'switch') throw new Error('stale')
    }
  } as never)
  const attempt = service.share('A')
  if (mode === 'switch') await expect(attempt).rejects.toThrow('组织账号已切换')
  else expect((await attempt).completion).toBe('incomplete')
  expect(
    fetcher.mock.calls.some(([url]) => {
      const path = new URL(url).pathname
      return stage === 'create'
        ? path.endsWith('/local-share/spaces')
        : stage === 'folder'
          ? path.endsWith('/folders')
          : path.endsWith('/files')
    })
  ).toBe(false)
})

it.each(['create', 'folder'])('真实传输 %s 返回401不刷新重放写入', async (stage) => {
  if (stage === 'folder')
    vi.spyOn(application.get('KnowledgeService'), 'listRootItems').mockReturnValue([
      { id: 'dir', type: 'directory', status: 'completed', data: { relativePath: '资料' } }
    ] as never)
  let tokens = 0
  let writes = 0
  vi.stubGlobal('fetch', async (url: URL | string) => {
    const path = new URL(url).pathname
    if (stage === 'create' ? path.endsWith('/local-share/spaces') : path.endsWith('/folders')) {
      writes++
      return Response.json({ detail: '未授权' }, { status: 401 })
    }
    return Response.json(await api.request(path))
  })
  service.dispose()
  service = new OrgKnowledgeService({
    apiClient: new OrgApiClient(
      async () => ({ issuerId: 's', userId: 'u', groupId: 'g', accessToken: `token-${++tokens}` }) as never
    ),
    acquireLease: () => ({ issuerId: 's', userId: 'u', groupId: 'g', generation: 1 }),
    assertLease: () => {}
  } as never)
  expect((await service.share('A')).completion).toBe('incomplete')
  expect(writes).toBe(1)
  expect(tokens).toBe(stage === 'create' ? 1 : 4)
})

it('同库复用promise，异库在第一个await前拒绝，未创建第二个远端库', async () => {
  const first = service.share('A')
  expect(service.share('A')).toBe(first)
  await expect(service.share('B')).rejects.toThrow('「A」正在上传云端，请完成后再试')
  expect((await first).completion).toBe('completed')
  expect(api.request.mock.calls.filter(([path]) => path.endsWith('/local-share/spaces'))).toHaveLength(1)
  expect(await service.uploadStatus('A')).toMatchObject({ phase: 'completed', uploadedBytes: 10, completedFiles: 1 })
})
it.each(['create', 'upload', 'file', 'items', 'chunks'])(
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
      if (path.endsWith('/spaces/space')) return Response.json(await api.request(path))
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
      apiClient: new OrgApiClient(
        async () => ({ issuerId: 's', userId: 'u', groupId: 'g', accessToken: 'token' }) as never
      ),
      acquireLease: () => ({ issuerId: 's', userId: 'u', groupId: 'g', generation: 1 }),
      assertLease: () => {}
    } as never)
    const first = service.share('A')
    await started.promise
    await expect(service.share('B')).rejects.toThrow('正在上传云端')
    await vi.advanceTimersByTimeAsync(stage === 'upload' ? 300_000 : 30_000)
    expect(await service.uploadStatus('A')).toMatchObject({
      phase: stage === 'create' ? 'cleanup_unknown' : 'cleanup_pending'
    })
    const result = await first
    expect(result.completion).toBe('incomplete')
    if (stage !== 'create') expect(result.files[0].status).toBe('unknown')
    const before = { ...writes }
    blocked = false
    await expect(service.share('A', true)).rejects.toThrow('首次分享已中断')
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
  expect(await service.uploadStatus('A')).toMatchObject({ phase: 'cleanup_pending' })
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
  expect(api.request.mock.calls.map(([path]) => path)).toEqual(['/api/v1/spaces/space'])
  expect(api.requestFileMultipart).not.toHaveBeenCalled()
})
it('未分享知识库首次分享始终上传本机原文件', async () => {
  expect((await service.share('A', false, false)).completion).toBe('completed')
  expect(api.requestFileMultipart.mock.calls[0][1]).toMatchObject({ uploadOriginal: true })
  expect(api.request.mock.calls.find(([path]) => path.endsWith('/local-share/spaces'))?.[1]).toMatchObject({
    body: JSON.stringify({ name: 'A', allow_local_file_upload: true })
  })
})

/* 原测试覆盖可选仅分块首传；服务端上传接口要求首传必须包含原文件，保留作历史契约记录。
it.each([false, true])('uploadOriginal=%s 透传并持久化，重启核对沿用原模式', async (uploadOriginal) => {
  const request = api.request.getMockImplementation()!
  let unavailable = true
  api.request.mockImplementation(async (path) => {
    if (path.endsWith('/files/file') && unavailable) throw new Error('暂不可核对')
    const value = await request(path)
    return path.endsWith('/files/file') && !uploadOriginal ? { ...(value as object), file_hash: null } : value
  })
  expect((await service.share('A', false, uploadOriginal)).completion).toBe('incomplete')
  expect(api.requestFileMultipart.mock.calls[0][1]).toMatchObject({ uploadOriginal })
  const key = JSON.stringify(['s', 'u', 'g', 'A'])
  expect(orgStateStore.getFirstShareUpload(key)?.files[0]).toMatchObject({
    uploadOriginal,
    hash: createHash('sha256').update('file-bytes').digest('hex')
  })
  service.dispose()
  service = new OrgKnowledgeService({
    apiClient: api,
    acquireLease: () => ({ issuerId: 's', userId: 'u', groupId: 'g', generation: 1 }),
    assertLease: () => {}
  } as never)
  unavailable = false
  await expect(service.share('A', true, !uploadOriginal)).rejects.toThrow('首次分享已中断')
  expect(api.requestFileMultipart).toHaveBeenCalledTimes(1)
})
*/

it('核对按文件身份恢复持久模式，不用首项模式覆盖其余文件', async () => {
  const ks = application.get('KnowledgeService')
  vi.spyOn(ks, 'listRootItems').mockReturnValue([
    { id: 'i', type: 'file', status: 'completed', data: { relativePath: '原文.txt' } },
    { id: 'j', type: 'file', status: 'completed', data: { relativePath: '原文.txt' } }
  ] as never)
  expect((await service.share('A', false, false)).completion).toBe('completed')
  const key = JSON.stringify(['s', 'u', 'g', 'A'])
  const saved = orgStateStore.getFirstShareUpload(key)!
  saved.files[1].uploadOriginal = true
  saved.files[1].phase = 'unknown'
  orgStateStore.setFirstShareUpload(key, saved)
  orgStateStore.setShareAssociation(key, { shareId: 'space', completion: 'incomplete', files: [] })
  expect((await service.share('A', true)).completion).toBe('completed')
  expect(api.requestFileMultipart).toHaveBeenCalledTimes(2)
})

it.each(['file', 'space', 'name', 'directory', 'parent', 'item-id', 'item-file', 'missing', 'content', 'duplicate'])(
  '仅分块模式拒绝%s异常，不能把不完整或不可信副本标为完成',
  async (mismatch) => {
    const request = api.request.getMockImplementation()!
    const ks = application.get('KnowledgeService')
    if (mismatch === 'duplicate') {
      vi.spyOn(ks, 'listItemChunks').mockResolvedValue([
        { id: 'c', itemId: 'i', content: '正文', metadata: { chunkIndex: 0, itemType: 'file' } },
        { id: 'c2', itemId: 'i', content: '正文', metadata: { chunkIndex: 0, itemType: 'file' } }
      ] as never)
      api.requestFileMultipart.mockResolvedValue({ share_id: 'space', file_id: 'file', chunk_count: 2 })
    }
    api.request.mockImplementation(async (path) => {
      const value = (await request(path)) as any
      if (path.endsWith('/files/file'))
        return {
          ...value,
          file_hash: null,
          ...(mismatch === 'file' ? { id: 'other' } : {}),
          ...(mismatch === 'space' ? { space_id: 'other' } : {}),
          ...(mismatch === 'name' ? { name: 'other.txt' } : {}),
          ...(mismatch === 'directory' ? { is_dir: true } : {}),
          ...(mismatch === 'parent' ? { parent_id: 'other' } : {})
        }
      if (path.endsWith('/items/item'))
        return {
          ...value,
          ...(mismatch === 'item-id' ? { id: 'other' } : {}),
          ...(mismatch === 'item-file' ? { document_id: 'other', data: { file_id: 'other' } } : {})
        }
      if (path.endsWith('/chunks')) {
        if (mismatch === 'missing') return { chunks: [], total: 1 }
        if (mismatch === 'content') return { ...value, chunks: [{ ...value.chunks[0], content: 'other' }] }
        if (mismatch === 'duplicate')
          return {
            chunks: [
              value.chunks[0],
              { ...value.chunks[0], chunk_id: 'rc2', content: 'other', metadata: { chunk_index: 1 } }
            ],
            total: 2
          }
      }
      return value
    })
    expect((await service.share('A', false, false)).completion).toBe('incomplete')
    expect(await service.uploadStatus('A')).toMatchObject({ phase: 'cleanup_pending', completedFiles: 0 })
  }
)

it('仅分块首传仍需可读本机原件来计算副本身份', async () => {
  await rm(file)
  await expect(service.share('A', false, false)).rejects.toThrow()
  expect(api.requestFileMultipart).not.toHaveBeenCalled()
  expect(api.request).not.toHaveBeenCalled()
})

it('核对入口没有历史任务时不得创建云端库', async () => {
  await expect(service.share('A', true)).rejects.toThrow('没有可核对')
  expect(api.request).not.toHaveBeenCalled()
})
