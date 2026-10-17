import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { OrgApiClient } from '../OrgApiClient'
import { getKnowledgeSpacePath, OrgKnowledgeClient, OrgKnowledgeProtocolError } from '../OrgKnowledgeClient'

function makeApiClient(
  overrides: Partial<Record<'request' | 'requestMultipart' | 'requestText', ReturnType<typeof vi.fn>>>
) {
  return {
    request: overrides.request ?? vi.fn(),
    requestMultipart: overrides.requestMultipart ?? vi.fn(),
    requestText: overrides.requestText ?? vi.fn()
  } as unknown as OrgApiClient
}

describe('OrgKnowledgeClient', () => {
  it('根据部署模式选择 modern 代理或知识库直连路径', () => {
    expect(getKnowledgeSpacePath('space id', true)).toBe('/api/kb/v1/spaces/space%20id')
    expect(getKnowledgeSpacePath('space id', false)).toBe('/api/v1/spaces/space%20id')
  })
  it.each([false, true])('部署模式%s读取空间策略时使用正确接口', async (management) => {
    vi.resetModules()
    vi.stubEnv('MAIN_VITE_ORG_SERVER_BASE_URL', management ? 'https://management.example.test' : '')
    try {
      const { OrgKnowledgeClient: Client } = await import('../OrgKnowledgeClient')
      const request = vi.fn().mockResolvedValue({ id: 'space', name: '库', allow_local_file_upload: true })
      const client = new Client(makeApiClient({ request }))
      await expect(client.getSpace('space')).resolves.toMatchObject({ allow_local_file_upload: true })
      expect(request.mock.calls[0][0]).toBe(management ? '/api/kb/v1/spaces/space' : '/api/v1/spaces/space')
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })
  it.each([false, true])('创建携带策略%s且不发送visibility，详情保留策略与独立下载权限', async (mode) => {
    const request = vi.fn().mockResolvedValueOnce({ share_id: 'space' }).mockResolvedValueOnce({
      id: 'space',
      name: '库',
      allow_local_file_upload: mode,
      can_download: false
    })
    const client = new OrgKnowledgeClient(makeApiClient({ request }))
    await client.createShareSpace('库', mode)
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ name: '库', allow_local_file_upload: mode })
    expect(await client.getSpace('space')).toMatchObject({ allow_local_file_upload: mode, can_download: false })
  })
  it('共享目录创建透传父目录，校验folder_id和空间归属字段', async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ folder_id: 'folder', name: '合同', space_id: 'space', parent_id: 'parent' })
    const client = new OrgKnowledgeClient(makeApiClient({ request }))
    expect(await client.createShareFolder('space', { fileName: '合同' }, 'parent')).toMatchObject({
      folder_id: 'folder',
      parent_id: 'parent'
    })
    expect(request).toHaveBeenCalledWith(
      '/api/v1/local-share/spaces/space/folders',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: '合同', parent_id: 'parent' }) }),
      undefined
    )
    request.mockResolvedValue({ folder_id: '', name: '合同', space_id: 'space' })
    await expect(client.createShareFolder('space', { fileName: '合同' }, null)).rejects.toThrow('响应结构不符合契约')
  })
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('DELETE 遵守本地 OpenAPI 的宽松对象响应且编码文件 ID', async () => {
    const request = vi.fn().mockResolvedValue({ deleted: 1 })
    const client = new OrgKnowledgeClient(makeApiClient({ request }))
    await client.deleteFile('f:1')
    expect(request).toHaveBeenCalledWith(
      '/api/kb/v1/files/f%3A1',
      expect.objectContaining({ method: 'DELETE' }),
      undefined
    )
    request.mockResolvedValue(undefined)
    await expect(client.deleteFile('f:1')).rejects.toThrow('响应结构不符合契约')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('deleteShareSpace 走现有路由 DELETE 且 204 无响应体视为成功', async () => {
    const request = vi.fn().mockResolvedValue(undefined)
    const client = new OrgKnowledgeClient(makeApiClient({ request }))
    await expect(client.deleteShareSpace('space')).resolves.toBeUndefined()
    expect(request).toHaveBeenCalledWith(
      '/api/v1/spaces/space',
      expect.objectContaining({ method: 'DELETE' }),
      undefined
    )
    const init = request.mock.calls[0][1] as RequestInit
    expect((init.signal as AbortSignal)?.constructor?.name).toBe('AbortSignal')
  })

  it('deleteShareSpace 远程 404 抛 OrgApiHttpError 不假定成功', async () => {
    const { OrgApiHttpError } = await import('../OrgApiClient')
    const request = vi.fn().mockRejectedValue(new OrgApiHttpError(404, 'not found'))
    const client = new OrgKnowledgeClient(makeApiClient({ request }))
    await expect(client.deleteShareSpace('space')).rejects.toBeInstanceOf(OrgApiHttpError)
    await expect(client.deleteShareSpace('space')).rejects.toMatchObject({ status: 404 })
  })

  it('分享列表遵守 ShareOut 默认值且剥离额外敏感字段', async () => {
    const share = {
      id: 'c357f93f-572b-4c16-868b-c2f43c20a88e',
      space_id: 'ccbc8b6e-172b-4fb2-8cb8-6773565336bd',
      share_code: 'AbCd_123',
      share_type: 1,
      max_views: null,
      view_count: 0,
      expires_at: null,
      revoked_at: null,
      created_at: '2026-10-15T00:00:00Z',
      password: 'private-pass'
    }
    const request = vi.fn().mockResolvedValue([share])
    const result = await new OrgKnowledgeClient(makeApiClient({ request })).listShares('space')
    expect(result[0].has_password).toBe(false)
    expect(result[0]).not.toHaveProperty('password')
    expect(request).toHaveBeenCalledWith('/api/kb/v1/spaces/space/shares')
  })

  it.each([
    { id: 'bad' },
    { id: 'ccbc8b6e-172b-4fb2-8cb8-6773565336bd' },
    { space: { id: 'ccbc8b6e-172b-4fb2-8cb8-6773565336bd', name: 'name' } }
  ])('拒绝与直接领取契约不符的响应', async (raw) => {
    const client = new OrgKnowledgeClient(makeApiClient({ request: vi.fn().mockResolvedValue(raw) }))
    await expect(client.receiveShare({ shareCode: 'AbCd_123' })).rejects.toThrow('分享响应结构不符合契约')
  })

  it('catalog hits /api/kb/catalog?scope=client and validates three arrays', async () => {
    const request = vi.fn().mockResolvedValue({ public: [], shared: [], owned: [] })
    const client = new OrgKnowledgeClient(makeApiClient({ request }))
    const catalog = await client.getCatalog()
    expect(request).toHaveBeenCalledWith('/api/kb/catalog?scope=client')
    expect(catalog).toEqual({ public: [], shared: [], owned: [] })
  })

  it('listCollaborators hits /api/collaborators with paging and validates response', async () => {
    const request = vi.fn().mockResolvedValue({ items: [{ id: 7, username: 'bob' }], total: 42, page: 2, pageSize: 20 })
    const client = new OrgKnowledgeClient(makeApiClient({ request }))
    const result = await client.listCollaborators({ keyword: 'bo', page: 2, pageSize: 20 })
    expect(request).toHaveBeenCalledWith('/api/collaborators?keyword=bo&page=2&pageSize=20')
    expect(result).toEqual({ items: [{ id: 7, username: 'bob' }], total: 42, page: 2, pageSize: 20 })
  })

  it('listCollaborators omits empty keyword and defaults paging', async () => {
    const request = vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 })
    const client = new OrgKnowledgeClient(makeApiClient({ request }))
    await client.listCollaborators({ keyword: '   ', page: undefined, pageSize: undefined })
    expect(request).toHaveBeenCalledWith('/api/collaborators')
  })

  it('listCollaborators rejects a malformed response', async () => {
    const request = vi.fn().mockResolvedValue({ items: [{ id: 'x' }], total: 1, page: 1, pageSize: 20 })
    const client = new OrgKnowledgeClient(makeApiClient({ request }))
    await expect(client.listCollaborators({})).rejects.toBeInstanceOf(OrgKnowledgeProtocolError)
  })

  it('接受真实 SpaceOut 的更新时间且兼容没有 document_count 的目录', async () => {
    const base = { id: 'space', name: '空间', updated_at: '2026-10-17T00:00:00Z' }
    const client = new OrgKnowledgeClient(
      makeApiClient({ request: vi.fn().mockResolvedValue({ public: [base], shared: [], owned: [] }) })
    )
    const result = (await client.getCatalog()).public[0]
    expect(result).toMatchObject(base)
    expect(result.document_count).toBeUndefined()
  })

  it('列表响应混入其他知识库条目时拒绝展示', async () => {
    const request = vi.fn().mockResolvedValue({
      items: [
        {
          id: 'item',
          base_id: 'B',
          group_id: null,
          type: 'file',
          title: '乙库私密文件',
          status: 'completed',
          error: null,
          document_id: null,
          data: {},
          created_at: '2026-10-17T00:00:00Z',
          updated_at: '2026-10-17T00:00:00Z'
        }
      ],
      total: 1
    })
    const client = new OrgKnowledgeClient(makeApiClient({ request }))
    await expect(client.listItems('A')).rejects.toBeInstanceOf(OrgKnowledgeProtocolError)
  })

  it('listItems encodes baseId and passes cursor', async () => {
    const request = vi.fn().mockResolvedValue({ items: [], total: 0 })
    const client = new OrgKnowledgeClient(makeApiClient({ request }))
    await client.listItems('b:1', 'cur:2')
    expect(request).toHaveBeenCalledWith(expect.stringContaining('/api/kb/v1/knowledge/bases/'), {
      signal: expect.any(AbortSignal)
    })
    const arg = request.mock.calls[0][0] as string
    expect(arg).toContain('cursor=cur%3A2')
  })

  it('search posts base_ids with empty filters and top_k', async () => {
    const request = vi.fn().mockResolvedValue({ chunks: [] })
    const client = new OrgKnowledgeClient(makeApiClient({ request }))
    await client.search({ baseIds: ['b:1'], query: 'q', topK: 5 })
    const [, init] = request.mock.calls[0]
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body).toMatchObject({ query: 'q', base_ids: ['b:1'], top_k: 5, filters: {} })
  })

  it('uploadShareFile sends multipart FormData with file and chunks', async () => {
    const requestMultipart = vi.fn().mockResolvedValue({ share_id: 's', file_id: 'f', chunk_count: 2 })
    const client = new OrgKnowledgeClient(makeApiClient({ requestMultipart }))
    const form = new FormData()
    form.append('file', new Blob(['x'], { type: 'application/octet-stream' }), 'a.txt')
    form.append('chunks', JSON.stringify([{ id: 'c1' }]))
    const res = await client.uploadShareFile('s1', form)
    expect(requestMultipart).toHaveBeenCalled()
    const passedForm = requestMultipart.mock.calls[0][1] as FormData
    expect(passedForm.get('file')).not.toBeNull()
    expect(passedForm.get('chunks')).not.toBeNull()
    expect(res.file_id).toBe('f')
  })

  it('通过鉴权 preview 端点获取 text 正文', async () => {
    const requestText = vi.fn().mockResolvedValue('hello world')
    const client = new OrgKnowledgeClient(makeApiClient({ requestText }))
    expect(await client.fetchPreviewContent('f:1')).toBe('hello world')
    expect(requestText).toHaveBeenCalledWith('/api/kb/v1/files/f%3A1/preview')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('接受 OpenAPI 中省略默认字段的读取和成员响应', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ document_id: 'd', title: 'T', content: '正文' })
      .mockResolvedValueOnce([{ user_id: 1, role: 'viewer', joined_at: '2026-10-15T00:00:00Z' }])
    const client = new OrgKnowledgeClient(makeApiClient({ request }))
    expect(await client.read({ baseId: 'b', documentId: 'd' })).toMatchObject({ truncated: false })
    expect(await client.listMembers('b')).toEqual([
      { user_id: 1, role: 'viewer', joined_at: '2026-10-15T00:00:00Z', username: '', status: 'active' }
    ])
  })

  it.each([-1, 1.5])('拒绝非法分页总数 %s', async (total) => {
    const client = new OrgKnowledgeClient(makeApiClient({ request: vi.fn().mockResolvedValue({ items: [], total }) }))
    await expect(client.listItems('b')).rejects.toBeInstanceOf(OrgKnowledgeProtocolError)
  })

  it.each([-0.1, 1.1])('拒绝超出 OpenAPI 范围的搜索分数 %s', async (score) => {
    const client = new OrgKnowledgeClient(
      makeApiClient({
        request: vi.fn().mockResolvedValue({
          chunks: [{ chunk_id: 'c', base_id: 'b', document_id: 'd', title: '', content: '', score }]
        })
      })
    )
    await expect(client.search({ baseIds: ['b'], query: 'q' })).rejects.toBeInstanceOf(OrgKnowledgeProtocolError)
  })

  it('拒绝缺少必填字段或字段类型不符的邀请', async () => {
    const client = new OrgKnowledgeClient(
      makeApiClient({
        request: vi
          .fn()
          .mockResolvedValue([{ id: 'i', space_id: 's', name: '', role: 'viewer', inviter: {}, expires: null }])
      })
    )
    await expect(client.listInvitations()).rejects.toBeInstanceOf(OrgKnowledgeProtocolError)
  })

  it('拒绝 OpenAPI 要求非空的搜索和读取文档 ID', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        chunks: [{ chunk_id: '', base_id: 'b', document_id: 'd', title: '', content: '', score: 0 }]
      })
      .mockResolvedValueOnce({ document_id: '', title: '', content: '' })
    const client = new OrgKnowledgeClient(makeApiClient({ request }))
    await expect(client.search({ baseIds: ['b'], query: 'q' })).rejects.toBeInstanceOf(OrgKnowledgeProtocolError)
    await expect(client.read({ baseId: 'b', documentId: 'd' })).rejects.toBeInstanceOf(OrgKnowledgeProtocolError)
  })

  it('解析合法邀请及分享默认字段，并拒绝非整数上传计数', async () => {
    const invitation = {
      id: 'c357f93f-572b-4c16-868b-c2f43c20a88e',
      space_id: 'ccbc8b6e-172b-4fb2-8cb8-6773565336bd',
      name: 'S',
      inviter: null,
      role: 'viewer',
      expires: null
    }
    const request = vi.fn().mockResolvedValueOnce([invitation]).mockResolvedValueOnce({ share_id: 's' })
    const requestMultipart = vi.fn().mockResolvedValue({ share_id: 's', file_id: 'f', chunk_count: 1.5 })
    const client = new OrgKnowledgeClient(makeApiClient({ request, requestMultipart }))
    expect(await client.listInvitations()).toEqual([invitation])
    expect(await client.createShareSpace('S')).toEqual({ share_id: 's', visibility: 1, is_space: true })
    await expect(client.uploadShareFile('s', new FormData())).rejects.toBeInstanceOf(OrgKnowledgeProtocolError)
  })

  it('throws OrgKnowledgeProtocolError on unexpected server shape', async () => {
    const request = vi.fn().mockResolvedValue({ public: 'not-an-array' })
    const client = new OrgKnowledgeClient(makeApiClient({ request }))
    await expect(client.getCatalog()).rejects.toBeInstanceOf(OrgKnowledgeProtocolError)
  })

  it('renameSpace PUT 编码 spaceId，发送 {name} 并 30s 超时', async () => {
    const request = vi.fn().mockResolvedValue({ id: 'space', name: '新名' })
    const client = new OrgKnowledgeClient(makeApiClient({ request }))
    await expect(client.renameSpace('space', '新名')).resolves.toEqual({ id: 'space', name: '新名' })
    expect(request).toHaveBeenCalledWith(
      '/api/v1/spaces/space',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ name: '新名' }) }),
      undefined
    )
    const init = request.mock.calls[0][1] as RequestInit
    expect((init.signal as AbortSignal)?.constructor?.name).toBe('AbortSignal')
  })

  it('renameSpace 携带写守卫作为第三参数', async () => {
    const request = vi.fn().mockResolvedValue({ id: 'space', name: '新名' })
    const guard = vi.fn(() => () => {})
    const client = new OrgKnowledgeClient(makeApiClient({ request }), guard)
    await expect(client.renameSpace('space', '新名')).resolves.toEqual({ id: 'space', name: '新名' })
    expect(guard).toHaveBeenCalled()
    expect(request).toHaveBeenCalledWith(
      '/api/v1/spaces/space',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ name: '新名' }) }),
      expect.any(Function)
    )
  })

  it('预签名预览直取字节时省略账号凭据并限制响应大小', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    vi.stubGlobal('fetch', fetcher)
    const client = new OrgKnowledgeClient(makeApiClient({}))

    await expect(
      client.fetchPresignedPreviewBytes('https://minio.example.test/object?X-Amz-Signature=secret', 3)
    ).resolves.toEqual(Buffer.from([1, 2, 3]))
    expect(fetcher).toHaveBeenCalledWith(
      'https://minio.example.test/object?X-Amz-Signature=secret',
      expect.objectContaining({ credentials: 'omit', signal: expect.any(AbortSignal) })
    )
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('headers')
  })

  it('预签名 URL 拒绝 userinfo、HTTP 错误和 Content-Length 超限', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('denied', { status: 403 }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'Content-Length': '4' } })
      )
    vi.stubGlobal('fetch', fetcher)
    const client = new OrgKnowledgeClient(makeApiClient({}))

    await expect(client.fetchPresignedPreviewBytes('https://user:pass@minio.example.test/object', 10)).rejects.toThrow()
    await expect(client.fetchPresignedPreviewBytes('https://minio.example.test/object', 10)).rejects.toThrow('HTTP 403')
    await expect(client.fetchPresignedPreviewBytes('https://minio.example.test/object', 3)).rejects.toThrow('过大')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('预签名响应流读取超过上限时取消读取并报错', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const read = vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: new Uint8Array([1, 2]) })
      .mockResolvedValueOnce({ done: false, value: new Uint8Array([3, 4]) })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: { getReader: () => ({ read, cancel, releaseLock: vi.fn() }) }
      })
    )
    const client = new OrgKnowledgeClient(makeApiClient({}))

    await expect(client.fetchPresignedPreviewBytes('https://minio.example.test/object', 3)).rejects.toThrow('过大')
    expect(cancel).toHaveBeenCalled()
  })

  it.each([{}, { id: 'space' }, { name: 'x' }, { id: 1, name: 'x' }])(
    'renameSpace 拒绝缺少 id/name 的响应 %#',
    async (raw) => {
      const client = new OrgKnowledgeClient(makeApiClient({ request: vi.fn().mockResolvedValue(raw) }))
      await expect(client.renameSpace('space', '新名')).rejects.toBeInstanceOf(OrgKnowledgeProtocolError)
    }
  )
})
