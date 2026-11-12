import { mockMainLoggerService as logs } from '@test-mocks/MainLoggerService'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { JavaKnowledgeClient } from '../JavaKnowledgeClient'

const UUID_A = '11111111-1111-1111-1111-111111111111'
const UUID_B = '22222222-2222-2222-2222-222222222222'
const FILE_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const CHUNK_A = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

const envelope = (data: unknown, code = 200, requestId = 'req-kn') =>
  Response.json({ code, msg: '测试响应', data, requestId })

const space = (id: string, category = 'PUBLIC') => ({
  id,
  tenantId: 9,
  name: '库',
  category,
  spaceKind: 'local',
  creationOrigin: 'ADMIN_CREATED',
  canDownload: true
})

const file = (knowledgeId: string, fileId: string) => ({
  knowledgeId,
  fileId,
  name: 'a.txt',
  directory: false,
  mimeType: 'text/plain',
  fileSize: 10,
  parseStatus: 'ready'
})

const chunk = (knowledgeId: string, fileId: string, chunkId: string) => ({
  knowledgeId,
  fileId,
  chunkId,
  chunkIndex: 0,
  content: 'x'
})

const content = (knowledgeId: string, fileId: string, c = 'hello') => ({
  knowledgeId,
  fileId,
  title: 'a',
  content: c,
  totalChars: c.length,
  truncated: false
})

function setup(responses: Response[]) {
  const fetchImpl = vi.fn<typeof fetch>()
  for (const response of responses) fetchImpl.mockResolvedValueOnce(response)
  const onSessionExpired = vi.fn()
  const client = new JavaKnowledgeClient({
    baseUrl: 'https://ent.test',
    getAccessToken: async () => 'secret-token',
    fetchImpl,
    onSessionExpired
  })
  return { client, fetchImpl, onSessionExpired }
}

describe('JavaKnowledgeClient 请求日志', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each(['detail', 'preview'] as const)('记录 %s 权限拒绝的接口、资源和服务端请求ID', async (endpoint) => {
    const { client } = setup([envelope(null, 10007, 'req-denied')])
    await expect(
      endpoint === 'detail' ? client.getFile(UUID_A, FILE_A) : client.preview(UUID_A, FILE_A)
    ).rejects.toThrow('无权限')
    expect(logs.warn).toHaveBeenCalledWith(
      'knowledge request completed',
      expect.objectContaining({
        method: 'GET',
        path: `/api/v1/knowledge/file/${endpoint}`,
        scope: 'client',
        id: UUID_A,
        fileId: FILE_A,
        status: 200,
        code: 10007,
        requestId: 'req-denied',
        outcome: 'failed',
        durationMs: expect.any(Number)
      })
    )
    expect(JSON.stringify([logs.info.mock.calls, logs.warn.mock.calls])).not.toContain('secret-token')
  })

  it('成功响应记录请求ID但不泄漏查询词、正文和服务端msg', async () => {
    const { client } = setup([envelope({ chunks: [] }, 200, 'req-search')])
    await client.search({ knowledgeIds: [UUID_A], query: 'private-query' })
    expect(logs.info).toHaveBeenCalledWith(
      'knowledge request completed',
      expect.objectContaining({
        method: 'POST',
        path: '/api/v1/knowledge/search',
        status: 200,
        code: 200,
        requestId: 'req-search',
        outcome: 'success'
      })
    )
    const serialized = JSON.stringify([logs.info.mock.calls, logs.warn.mock.calls])
    for (const secret of ['private-query', 'secret-token', '测试响应']) expect(serialized).not.toContain(secret)
  })

  it('并发响应逆序返回时请求ID不会串到其他资源', async () => {
    const { client, fetchImpl } = setup([])
    let resolveFirst!: (response: Response) => void
    fetchImpl.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        })
    )
    fetchImpl.mockResolvedValueOnce(envelope(null, 10007, 'req-second'))
    const first = client.getFile(UUID_A, FILE_A).catch((error: unknown) => error)
    await expect(client.getFile(UUID_B, FILE_A)).rejects.toThrow('req-second')
    resolveFirst(envelope(null, 10007, 'req-first'))
    expect(await first).toBeInstanceOf(Error)
    const completed = logs.warn.mock.calls.map(([, entry]) => entry)
    expect(completed).toEqual([
      expect.objectContaining({ id: UUID_B, requestId: 'req-second' }),
      expect.objectContaining({ id: UUID_A, requestId: 'req-first' })
    ])
  })

  it('文件字节不进入日志', async () => {
    const { client } = setup([new Response('private-file', { headers: { 'content-type': 'text/plain' } })])
    expect((await client.preview(UUID_A, FILE_A)).bytes.toString()).toBe('private-file')
    expect(logs.info).toHaveBeenCalledWith(
      'knowledge request completed',
      expect.objectContaining({ status: 200, outcome: 'success' })
    )
    expect(JSON.stringify(logs.info.mock.calls)).not.toContain('private-file')
  })

  it('HTTP拒绝记录状态且不读取错误正文', async () => {
    const response = new Response('private-error-body', { status: 403 })
    const { client } = setup([response])
    await expect(client.getFile(UUID_A, FILE_A)).rejects.toThrow('403')
    expect(response.bodyUsed).toBe(false)
    expect(logs.warn).toHaveBeenCalledWith(
      'knowledge request completed',
      expect.objectContaining({ status: 403, outcome: 'failed' })
    )
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain('private-error-body')
  })

  it('网络故障保留请求上下文但不输出可能带凭据的异常消息', async () => {
    const { client, fetchImpl } = setup([])
    fetchImpl.mockRejectedValueOnce(new Error('secret-token private-network-error'))
    await expect(client.getFile(UUID_A, FILE_A)).rejects.toThrow('private-network-error')
    expect(logs.warn).toHaveBeenCalledWith(
      'knowledge request completed',
      expect.objectContaining({ path: '/api/v1/knowledge/file/detail', outcome: 'failed' })
    )
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain('secret-token')
  })

  it('流式上传同样记录业务拒绝且不记录multipart正文', async () => {
    const { client } = setup([envelope(null, 10007, 'req-upload')])
    await expect(
      client.uploadMultipart(
        `/api/v1/knowledge/file/upload?scope=client&knowledgeId=${UUID_A}&token=private-query-token`,
        'multipart/form-data; boundary=test',
        0,
        async function* () {}
      )
    ).rejects.toThrow('无权限')
    expect(logs.warn).toHaveBeenCalledWith(
      'knowledge request completed',
      expect.objectContaining({ method: 'POST', knowledgeId: UUID_A, code: 10007, requestId: 'req-upload' })
    )
    const serialized = JSON.stringify([logs.info.mock.calls, logs.warn.mock.calls])
    expect(serialized).not.toContain('private-query-token')
    expect(serialized).not.toContain('secret-token')
  })
})

describe('JavaKnowledgeClient 传输与鉴权', () => {
  it('无 token 不发出请求', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = new JavaKnowledgeClient({
      baseUrl: 'https://ent.test',
      getAccessToken: async () => '',
      fetchImpl,
      onSessionExpired: vi.fn()
    })
    await expect(client.getSpace(UUID_A)).rejects.toThrow('未登录')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('HTTP 401 触发会话失效', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 401 }))
    const onSessionExpired = vi.fn()
    const client = new JavaKnowledgeClient({
      baseUrl: 'https://ent.test',
      getAccessToken: async () => 't',
      fetchImpl,
      onSessionExpired
    })
    await expect(client.getCatalog()).rejects.toThrow()
    expect(onSessionExpired).toHaveBeenCalled()
  })
})

describe('JavaKnowledgeClient.getCatalog', () => {
  it('跨页取全量并携带 scope=client 与分类分桶', async () => {
    const { client, fetchImpl } = setup([
      envelope({ items: [space(UUID_A)], total: 2 }),
      envelope({ items: [space(UUID_B)], total: 2 })
    ])
    const items = await client.getCatalog({ category: 'PUBLIC', pageSize: 1 })
    expect(items.map((item) => item.id)).toEqual([UUID_A, UUID_B])
    expect(items[0].canDownload).toBe(true)
    const urls = fetchImpl.mock.calls.map(([url]) => String(url))
    expect(urls).toEqual([
      'https://ent.test/api/v1/knowledge/page?scope=client&page=1&pageSize=1&category=PUBLIC',
      'https://ent.test/api/v1/knowledge/page?scope=client&page=2&pageSize=1&category=PUBLIC'
    ])
    const init = fetchImpl.mock.calls[0][1]!
    expect(new Headers(init.headers).get('token')).toBe('secret-token')
    expect(new Headers(init.headers).has('authorization')).toBe(false)
    expect(init.credentials).toBe('omit')
    expect(init.redirect).toBe('error')
  })

  it('空页且总数未满足时拒绝', async () => {
    const { client } = setup([envelope({ items: [space(UUID_A)], total: 5 }), envelope({ items: [], total: 5 })])
    await expect(client.getCatalog({ pageSize: 1 })).rejects.toThrow('分页不完整')
  })

  it('未知分类请求 fail closed 不发出请求', async () => {
    const { client, fetchImpl } = setup([])
    await expect(client.getCatalog({ category: 'WEIRD' as never })).rejects.toThrow('分类不合法')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('返回未知分类 fail closed', async () => {
    const { client } = setup([envelope({ items: [{ ...space(UUID_A), category: 'WEIRD' }], total: 1 })])
    await expect(client.getCatalog()).rejects.toThrow()
  })
})

describe('JavaKnowledgeClient.getSpace', () => {
  it('校验UUID并暴露camelCase原生数据', async () => {
    const { client, fetchImpl } = setup([envelope(space(UUID_A))])
    const result = await client.getSpace(UUID_A)
    expect(result.id).toBe(UUID_A)
    expect(result.category).toBe('PUBLIC')
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('scope=client')
    expect(url).toContain(`id=${UUID_A}`)
  })

  it('归属不符失败', async () => {
    const { client } = setup([envelope(space(UUID_B))])
    await expect(client.getSpace(UUID_A)).rejects.toThrow('归属')
  })

  it('缺 id 字段被 zod 拒绝', async () => {
    const { client } = setup([envelope({ name: '库', category: 'PUBLIC', spaceKind: 'local' })])
    await expect(client.getSpace(UUID_A)).rejects.toThrow()
  })

  it('非法UUID被本地拒绝', async () => {
    const { client, fetchImpl } = setup([])
    await expect(client.getSpace('not-a-uuid')).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('权限不足不注销，会话失效才通知认证层', async () => {
    const { client, onSessionExpired } = setup([envelope(null, 10007), envelope(null, 10008)])
    await expect(client.getSpace(UUID_A)).rejects.toThrow('无权限')
    expect(onSessionExpired).not.toHaveBeenCalled()
    await expect(client.getSpace(UUID_A)).rejects.toThrow('重新登录')
    expect(onSessionExpired).toHaveBeenCalledTimes(1)
  })
})

describe('JavaKnowledgeClient.listFiles / getFile', () => {
  it('listFiles 单页并校验文件归属', async () => {
    const { client, fetchImpl } = setup([envelope({ items: [file(UUID_A, FILE_A)], total: 1 })])
    const page = await client.listFiles(UUID_A)
    expect(page.items[0].fileId).toBe(FILE_A)
    expect(page.total).toBe(1)
    expect(String(fetchImpl.mock.calls[0][0])).toContain(`knowledgeId=${UUID_A}`)
  })

  it('listFiles 归属不符失败', async () => {
    const { client } = setup([envelope({ items: [file(UUID_B, FILE_A)], total: 1 })])
    await expect(client.listFiles(UUID_A)).rejects.toThrow('归属')
  })

  it('getFile 校验知识库与文件双重归属', async () => {
    const { client } = setup([envelope(file(UUID_A, FILE_A))])
    const result = await client.getFile(UUID_A, FILE_A)
    expect(result.fileId).toBe(FILE_A)
  })

  it('getFile 归属不符失败', async () => {
    const { client } = setup([envelope(file(UUID_B, FILE_A))])
    await expect(client.getFile(UUID_A, FILE_A)).rejects.toThrow('归属')
  })

  it('getFile 非法 fileId 被本地拒绝', async () => {
    const { client, fetchImpl } = setup([])
    await expect(client.getFile(UUID_A, 'bad')).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('JavaKnowledgeClient.listChunks', () => {
  it('校验知识库与文件双重归属', async () => {
    const { client } = setup([envelope({ items: [chunk(UUID_A, FILE_A, CHUNK_A)], total: 1 })])
    const page = await client.listChunks(UUID_A, FILE_A)
    expect(page.items[0].chunkId).toBe(CHUNK_A)
  })

  it('知识库或文件归属不符失败', async () => {
    const { client } = setup([envelope({ items: [chunk(UUID_B, FILE_A, CHUNK_A)], total: 1 })])
    await expect(client.listChunks(UUID_A, FILE_A)).rejects.toThrow('归属')
  })

  it('非法 chunkId 被本地拒绝', async () => {
    const { client, fetchImpl } = setup([])
    await expect(client.read(UUID_A, FILE_A, 'bad')).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('JavaKnowledgeClient.read', () => {
  it('校验知识库与文件归属', async () => {
    const { client } = setup([envelope(content(UUID_A, FILE_A))])
    const result = await client.read(UUID_A, FILE_A)
    expect(result.content).toBe('hello')
  })

  it('归属不符失败', async () => {
    const { client } = setup([envelope(content(UUID_B, FILE_A))])
    await expect(client.read(UUID_A, FILE_A)).rejects.toThrow('归属')
  })

  it('带 chunkId 透传', async () => {
    const { client, fetchImpl } = setup([envelope(content(UUID_A, FILE_A))])
    await client.read(UUID_A, FILE_A, CHUNK_A)
    expect(String(fetchImpl.mock.calls[0][0])).toContain(`chunkId=${CHUNK_A}`)
  })
})

describe('JavaKnowledgeClient.search', () => {
  it('显式 scope=client 且只返回命中库', async () => {
    const { client, fetchImpl } = setup([
      envelope({
        chunks: [{ knowledgeId: UUID_A, fileId: FILE_A, chunkId: CHUNK_A, title: 't', content: 'c', score: 0.9 }],
        modeFallback: null
      })
    ])
    const result = await client.search({ knowledgeIds: [UUID_A], query: 'q' })
    expect(result.hits.map((hit) => hit.knowledgeId)).toEqual([UUID_A])
    const init = fetchImpl.mock.calls[0][1]!
    expect(init.method).toBe('POST')
    const body = JSON.parse(String(init.body))
    expect(body.scope).toBe('client')
    expect(body.knowledgeIds).toEqual([UUID_A])
  })

  it('无 knowledgeIds 拒绝隐式全库', async () => {
    const { client, fetchImpl } = setup([])
    await expect(client.search({ query: 'q' } as never)).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('命中不在显式 knowledgeIds 中 fail closed', async () => {
    const { client } = setup([
      envelope({
        chunks: [{ knowledgeId: UUID_B, fileId: FILE_A, chunkId: CHUNK_A, title: 't', content: 'c', score: 0.9 }],
        modeFallback: null
      })
    ])
    await expect(client.search({ knowledgeIds: [UUID_A], query: 'q' })).rejects.toThrow()
  })

  it('topK/rerank/mode 透传', async () => {
    const { client, fetchImpl } = setup([envelope({ chunks: [], modeFallback: null })])
    await client.search({ knowledgeIds: [UUID_A], query: 'q', topK: 5, rerank: false, mode: 'vector' })
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]!.body))
    expect(body).toMatchObject({ topK: 5, rerank: false, mode: 'vector' })
  })

  it('会话失效触发认证层', async () => {
    const { client, onSessionExpired } = setup([envelope(null, 10008)])
    await expect(client.search({ knowledgeIds: [UUID_A], query: 'q' })).rejects.toThrow('重新登录')
    expect(onSessionExpired).toHaveBeenCalled()
  })
})

describe('JavaKnowledgeClient.preview / download', () => {
  it('preview 返回字节与内容类型', async () => {
    const bytes = Buffer.from([80, 75])
    const { client } = setup([new Response(bytes, { headers: { 'content-type': 'application/pdf' } })])
    const result = await client.preview(UUID_A, FILE_A)
    expect(result.bytes).toEqual(bytes)
    expect(result.contentType).toBe('application/pdf')
  })

  it('preview JSON 错误信封不当作文件', async () => {
    const { client } = setup([Response.json({ code: 10007, msg: '无权限', data: null, requestId: 'r' })])
    await expect(client.preview(UUID_A, FILE_A)).rejects.toThrow('无权限')
  })

  it('preview 业务失效触发会话失效', async () => {
    const { client, onSessionExpired } = setup([Response.json({ code: 10008, data: null })])
    await expect(client.preview(UUID_A, FILE_A)).rejects.toThrow('重新登录')
    expect(onSessionExpired).toHaveBeenCalled()
  })

  it.each(['application/json', 'text/plain'])('合法 JSON 原件按字节返回（%s）', async (contentType) => {
    const bytes = Buffer.from('{"title":"原件","items":[1,2]}')
    const { client } = setup([new Response(bytes, { headers: { 'content-type': contentType } })])
    expect((await client.download(UUID_A, FILE_A)).bytes).toEqual(bytes)
  })

  it('服务端文件响应头明确标记的 JSON 原件允许含 code 字段', async () => {
    const bytes = Buffer.from('{"code":10008,"msg":"原件中的示例"}')
    const { client, onSessionExpired } = setup([
      new Response(bytes, {
        headers: {
          'content-type': 'application/json',
          'content-disposition': 'attachment; filename="example.json"'
        }
      })
    ])
    expect((await client.download(UUID_A, FILE_A)).bytes).toEqual(bytes)
    expect(onSessionExpired).not.toHaveBeenCalled()
  })

  it('以花括号开头的非 JSON 文本仍可预览', async () => {
    const bytes = Buffer.from('{这是一段原文，不是业务信封')
    const { client } = setup([new Response(bytes, { headers: { 'content-type': 'text/plain' } })])
    expect((await client.preview(UUID_A, FILE_A)).bytes).toEqual(bytes)
  })

  it('错误信封即使标为二进制也不得当作原件', async () => {
    const { client } = setup([
      new Response(JSON.stringify({ code: 10007, msg: '无权限', data: null }), {
        headers: { 'content-type': 'application/octet-stream' }
      })
    ])
    await expect(client.download(UUID_A, FILE_A)).rejects.toThrow('无权限')
  })

  it('download 同样返回字节', async () => {
    const bytes = Buffer.from('hello')
    const { client } = setup([new Response(bytes, { headers: { 'content-type': 'text/plain' } })])
    const result = await client.download(UUID_A, FILE_A)
    expect(result.bytes.toString()).toBe('hello')
  })
})

describe('JavaKnowledgeClient 超时', () => {
  it('读取正文受超时限制', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
            }
          }),
          { headers: { 'content-type': 'application/pdf' } }
        )
    )
    const client = new JavaKnowledgeClient({
      baseUrl: 'https://ent.test',
      getAccessToken: async () => 't',
      fetchImpl,
      onSessionExpired: vi.fn(),
      timeoutMs: 10
    })
    await expect(client.preview(UUID_A, FILE_A)).rejects.toThrow('超时')
  })
})
