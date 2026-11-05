import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { JavaKnowledgeClient } from '../JavaKnowledgeClient'
import { uploadJavaKnowledgeFile, type JavaKnowledgeUploadParams } from '../JavaKnowledgeUpload'

vi.unmock('node:fs')

const UUID_A = '11111111-1111-1111-1111-111111111111'
const FILE_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const okUpload = (knowledgeId = UUID_A, fileId = FILE_A, chunkCount = 1) =>
  Response.json({ code: 200, msg: '操作成功', data: { knowledgeId, fileId, chunkCount }, requestId: 'r-up' })

/** 解析 multipart/form-data 主体为字段与文件，用于断言请求形态与流式交付。 */
function parseMultipart(body: Buffer, boundary: string) {
  const fields: Record<string, string> = {}
  const files: Record<string, { filename?: string; data: Buffer }> = {}
  const sep = Buffer.from(`--${boundary}`)
  let idx = body.indexOf(sep)
  while (idx !== -1) {
    const after = idx + sep.length
    if (body.slice(after, after + 2).toString('utf8') === '--') break
    const headerEnd = body.indexOf('\r\n\r\n', after)
    if (headerEnd === -1) break
    const header = body.slice(after, headerEnd).toString('utf8')
    const contentStart = headerEnd + 4
    const next = body.indexOf(sep, contentStart)
    const contentEnd = next === -1 ? body.length : next - 2
    const content = body.slice(contentStart, contentEnd)
    const name = header.match(/name="([^"]*)"/)?.[1]
    const filename = header.match(/filename="([^"]*)"/)?.[1]
    if (name) {
      if (filename !== undefined) files[name] = { filename, data: content }
      else fields[name] = content.toString('utf8')
    }
    idx = next
  }
  return { fields, files }
}

interface Captured {
  url?: string
  method?: string
  headers?: Record<string, string>
  body?: Buffer
  boundary?: string
}

function setup(responder: (captured: Captured) => Response) {
  const captured: Captured = {}
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    let body: Buffer | undefined
    const stream = init?.body as ReadableStream<Uint8Array> | undefined
    if (stream && typeof stream.getReader === 'function') {
      const reader = stream.getReader()
      const chunks: Buffer[] = []
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(Buffer.from(value))
      }
      body = Buffer.concat(chunks)
    }
    const contentType = headers['content-type'] ?? ''
    const boundary = contentType.split('boundary=')[1]?.split(';')[0]?.trim()
    Object.assign(captured, { url, method, headers, body, boundary })
    return responder(captured)
  })
  const onSessionExpired = vi.fn()
  const getAccessToken = vi.fn(async () => 'secret-token')
  const client = new JavaKnowledgeClient({
    baseUrl: 'https://ent.test',
    getAccessToken,
    fetchImpl,
    onSessionExpired
  })
  return { client, fetchImpl, onSessionExpired, getAccessToken, captured }
}

function baseParams(over: Partial<JavaKnowledgeUploadParams> = {}): JavaKnowledgeUploadParams {
  return {
    knowledgeId: UUID_A,
    fileName: '合同.pdf',
    chunks: [{ chunk_id: 'c1', content: 'x' }],
    ...over
  }
}

let tmp: string
let filePath: string
let fileContent: Buffer
let fileHash: string
let fileSize: number

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'javaupload-'))
  filePath = join(tmp, '合同.pdf')
  fileContent = Buffer.from('SNOW-LANG-ORIGINAL-FILE-CONTENT-雪浪云')
  writeFileSync(filePath, fileContent)
  fileSize = fileContent.length
  fileHash = createHash('sha256').update(fileContent).digest('hex')
})

afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* noop */
  }
})

describe('JavaKnowledgeUpload 进度与文件名', () => {
  it('原件逐块报告累计字节，响应前已有中间进度，不包含 multipart 开销', async () => {
    const largePath = join(tmp, 'large.bin')
    const size = 256 * 1024 + 17
    writeFileSync(largePath, Buffer.alloc(size, 1))
    const values: number[] = []
    const { client } = setup(() => {
      expect(values.length).toBeGreaterThan(1)
      expect(values[0]).toBeGreaterThan(0)
      expect(values[0]).toBeLessThan(size)
      expect(values.at(-1)).toBe(size)
      expect(values.every((value, index) => index === 0 || value > values[index - 1])).toBe(true)
      return okUpload()
    })
    await uploadJavaKnowledgeFile(
      client,
      baseParams({ filePath: largePath, fileSize: size, progress: (bytes) => values.push(bytes) })
    )
  })

  it('元数据模式报告逻辑文件大小，不读取原件', async () => {
    const values: number[] = []
    const { client } = setup(() => okUpload())
    await uploadJavaKnowledgeFile(
      client,
      baseParams({ uploadOriginal: false, filePath: '/不存在', fileSize: 123, progress: (bytes) => values.push(bytes) })
    )
    expect(values).toEqual([123])
  })

  it('合法引号按原生 FormData 规则编码 filename，展示名保持原样', async () => {
    const name = '合同"终稿%.pdf'
    const form = new FormData()
    form.append('file', new Blob(['x']), name)
    const nativeBody = await new Response(form).text()
    const expectedHeader = nativeBody.split('\r\n').find((line) => line.startsWith('Content-Disposition:'))
    const { client, captured } = setup(() => okUpload())
    await uploadJavaKnowledgeFile(client, baseParams({ fileName: name, filePath, fileSize }))
    expect(parseMultipart(captured.body!, captured.boundary!).fields.fileName).toBe(name)
    expect(captured.body!.toString()).toContain(expectedHeader)
    expect(Number(captured.headers!['content-length'])).toBe(captured.body!.length)
  })

  it('进度回调取消后释放原件流，不继续读取或重试', async () => {
    const original = fs.createReadStream
    const streams: fs.ReadStream[] = []
    const spy = vi.spyOn(fs, 'createReadStream').mockImplementation((...args) => {
      const stream = original(...args)
      streams.push(stream)
      return stream
    })
    syncBuiltinESMExports()
    const { client, fetchImpl } = setup(() => okUpload())
    try {
      await expect(
        uploadJavaKnowledgeFile(
          client,
          baseParams({
            filePath,
            fileSize,
            progress: () => {
              throw new Error('取消上传')
            }
          })
        )
      ).rejects.toThrow('取消上传')
      expect(streams).toHaveLength(1)
      expect(streams[0].destroyed).toBe(true)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
      syncBuiltinESMExports()
    }
  })
})

describe('JavaKnowledgeUpload 传输形态', () => {
  it('带原件上传：camelCase 字段、token 头、无 Bearer、无旧路由、流式交付', async () => {
    const { client, fetchImpl, captured } = setup(() => okUpload())
    const result = await uploadJavaKnowledgeFile(client, baseParams({ filePath, fileSize, expectedHash: fileHash }))
    expect(result).toEqual({ knowledgeId: UUID_A, fileId: FILE_A, chunkCount: 1 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // 路由：Java 原生端点，无 /api/kb/v1 旧路由；scope=client 查询参数。
    expect(captured.url).toBe('https://ent.test/api/v1/knowledge/file/importChunks?scope=client')
    expect(captured.method).toBe('POST')
    // token 头、无 Bearer。
    expect(captured.headers?.['token']).toBe('secret-token')
    expect(captured.headers?.['authorization']).toBeUndefined()

    const { fields, files } = parseMultipart(captured.body!, captured.boundary!)
    // camelCase 字段存在，且旧 snake 字段不存在。
    expect(fields.id).toBe(UUID_A)
    expect(fields.fileName).toBe('合同.pdf')
    expect(fields.parentId).toBeUndefined()
    expect(fields['file_name']).toBeUndefined()
    expect(fields['chunks_file']).toBeUndefined()
    expect(fields['parent_id']).toBeUndefined()
    expect(files.chunksFile).toBeDefined()
    expect(JSON.parse(files.chunksFile.data.toString('utf8'))).toEqual([{ chunk_id: 'c1', content: 'x' }])
    expect(files.file).toBeDefined()
    // 原件以流式交付，字节完整。
    expect(captured.body!.includes(fileContent)).toBe(true)
    expect(files.file.data.equals(fileContent)).toBe(true)
  })

  it('请求体为流式（ReadableStream）而非整文件 Buffer 缓冲', async () => {
    const seen: Array<'stream' | 'string' | 'buffer'> = []
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const b = init?.body
      if (typeof b === 'string') seen.push('string')
      else if (b instanceof Uint8Array) seen.push('buffer')
      else if (b && typeof (b as ReadableStream<Uint8Array>).getReader === 'function') seen.push('stream')
      else seen.push('buffer')
      return okUpload()
    })
    const client = new JavaKnowledgeClient({
      baseUrl: 'https://ent.test',
      getAccessToken: async () => 't',
      fetchImpl,
      onSessionExpired: vi.fn()
    })
    await uploadJavaKnowledgeFile(client, baseParams({ filePath, fileSize, expectedHash: fileHash }))
    expect(seen).toEqual(['stream'])
  })
})

describe('JavaKnowledgeUpload 元数据仅上传', () => {
  it('uploadOriginal=false 时不发送原件字节', async () => {
    const { client, captured } = setup(() => okUpload())
    await uploadJavaKnowledgeFile(client, baseParams({ uploadOriginal: false }))
    const { files } = parseMultipart(captured.body!, captured.boundary!)
    expect(files.file).toBeUndefined()
    expect(files.chunksFile).toBeDefined()
    // 主体中不得出现原件内容。
    expect(captured.body!.includes(fileContent)).toBe(false)
  })
})

describe('JavaKnowledgeUpload 外部取消', () => {
  it('元数据已发送、等待响应时取消网络请求，结果未知且不重试', async () => {
    const controller = new AbortController()
    const ready = Promise.withResolvers<void>()
    let networkSignal: AbortSignal | undefined
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      networkSignal = init!.signal!
      await new Response(init!.body).arrayBuffer()
      ready.resolve()
      return new Promise<Response>((_resolve, reject) => {
        networkSignal!.addEventListener('abort', () => reject(networkSignal!.reason), { once: true })
      })
    })
    const client = new JavaKnowledgeClient({
      baseUrl: 'https://ent.test',
      getAccessToken: async () => 't',
      onSessionExpired: vi.fn(),
      fetchImpl
    })
    const pending = uploadJavaKnowledgeFile(client, baseParams({ signal: controller.signal }))
    try {
      await ready.promise
      controller.abort()
      expect(networkSignal!.aborted).toBe(true)
      await expect(pending).rejects.toThrow('上传已取消，结果需核对')
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    } finally {
      controller.abort()
      if (!networkSignal!.aborted) networkSignal!.dispatchEvent(new Event('abort'))
      await pending.catch(() => {})
    }
  })

  it('原件背压停读时取消并关闭文件，不继续报告进度或重试', async () => {
    const largePath = join(tmp, 'abort-large.bin')
    writeFileSync(largePath, Buffer.alloc(4 * 1024 * 1024))
    const original = fs.createReadStream
    const streams: fs.ReadStream[] = []
    const spy = vi.spyOn(fs, 'createReadStream').mockImplementation((...args) => {
      const stream = original(...args)
      streams.push(stream)
      return stream
    })
    syncBuiltinESMExports()
    const controller = new AbortController()
    const ready = Promise.withResolvers<void>()
    const progress = vi.fn()
    let networkSignal: AbortSignal | undefined
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      networkSignal = init!.signal!
      const reader = (init!.body as ReadableStream<Uint8Array>).getReader()
      while (progress.mock.calls.length === 0) await reader.read()
      ready.resolve()
      return new Promise<Response>((_resolve, reject) => {
        networkSignal!.addEventListener('abort', () => reject(networkSignal!.reason), { once: true })
      })
    })
    const client = new JavaKnowledgeClient({
      baseUrl: 'https://ent.test',
      getAccessToken: async () => 't',
      onSessionExpired: vi.fn(),
      fetchImpl
    })
    const pending = uploadJavaKnowledgeFile(
      client,
      baseParams({ signal: controller.signal, filePath: largePath, progress })
    )
    try {
      await ready.promise
      const reports = progress.mock.calls.length
      controller.abort()
      expect(networkSignal!.aborted).toBe(true)
      await expect(pending).rejects.toThrow('上传已取消，结果需核对')
      expect(streams).toHaveLength(1)
      expect(streams[0].closed).toBe(true)
      expect(progress).toHaveBeenCalledTimes(reports)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    } finally {
      controller.abort()
      if (!networkSignal!.aborted) networkSignal!.dispatchEvent(new Event('abort'))
      await pending.catch(() => {})
      spy.mockRestore()
      syncBuiltinESMExports()
    }
  })

  it.each(['已取消', '取 token 时取消', '租约检查时取消'])('%s 时不发送请求', async (stage) => {
    const controller = new AbortController()
    if (stage === '已取消') controller.abort()
    const fetchImpl = vi.fn<typeof fetch>(async () => okUpload())
    const client = new JavaKnowledgeClient({
      baseUrl: 'https://ent.test',
      getAccessToken: async () => {
        if (stage === '取 token 时取消') controller.abort()
        return 't'
      },
      onSessionExpired: vi.fn(),
      fetchImpl
    })
    await expect(
      uploadJavaKnowledgeFile(
        client,
        baseParams({
          signal: controller.signal,
          beforeSend: () => {
            if (stage === '租约检查时取消') controller.abort()
          }
        })
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([false, true])('上传结束移除外部取消监听（失败=%s）', async (fail) => {
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const { client } = setup(() => {
      if (fail) throw new Error('网络中断')
      return okUpload()
    })
    const pending = uploadJavaKnowledgeFile(client, baseParams({ signal: controller.signal }))
    if (fail) await expect(pending).rejects.toThrow('网络中断')
    else await pending
    const listener = add.mock.calls.find(([event]) => event === 'abort')?.[1]
    expect(listener).toBeDefined()
    expect(remove).toHaveBeenCalledWith('abort', listener)
  })
})

describe('JavaKnowledgeUpload 传输清理', () => {
  it('fetch 异常后中止正在读取的原件并释放句柄', async () => {
    const original = fs.createReadStream
    const streams: fs.ReadStream[] = []
    const spy = vi.spyOn(fs, 'createReadStream').mockImplementation((...args) => {
      const stream = original(...args)
      streams.push(stream)
      return stream
    })
    syncBuiltinESMExports()
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const reader = (init!.body as ReadableStream<Uint8Array>).getReader()
      while (streams.length === 0) await reader.read()
      throw new Error('网络中断，结果未知')
    })
    const client = new JavaKnowledgeClient({
      baseUrl: 'https://ent.test',
      getAccessToken: async () => 't',
      onSessionExpired: vi.fn(),
      fetchImpl
    })
    try {
      await expect(uploadJavaKnowledgeFile(client, baseParams({ filePath, fileSize }))).rejects.toThrow('网络中断')
      expect(streams).toHaveLength(1)
      expect(streams[0].destroyed).toBe(true)
      expect(streams[0].closed).toBe(true)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
      syncBuiltinESMExports()
    }
  })

  it('持续推进超过五分钟仍成功，不受总超时限制', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const reader = (init!.body as ReadableStream<Uint8Array>).getReader()
      let bytes = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.length
      }
      expect(bytes).toBe(4)
      expect(init!.signal!.aborted).toBe(false)
      return okUpload()
    })
    const client = new JavaKnowledgeClient({
      baseUrl: 'https://ent.test',
      getAccessToken: async () => 't',
      onSessionExpired: vi.fn(),
      fetchImpl,
      timeoutMs: 1
    })
    async function* body(reset: () => void) {
      for (let i = 0; i < 4; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 120_000))
        reset()
        yield Buffer.from('x')
      }
    }
    try {
      const pending = client.uploadMultipart('/upload', 'application/octet-stream', 4, body)
      await vi.advanceTimersByTimeAsync(8 * 60_000)
      await expect(pending).resolves.toMatchObject({ chunkCount: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('无进展超时中止请求并结束主体生成器，不重试', async () => {
    vi.useFakeTimers()
    let closed = false
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const reader = (init!.body as ReadableStream<Uint8Array>).getReader()
      for (;;) {
        const { done } = await reader.read()
        if (done) break
      }
      return okUpload()
    })
    const client = new JavaKnowledgeClient({
      baseUrl: 'https://ent.test',
      getAccessToken: async () => 't',
      onSessionExpired: vi.fn(),
      fetchImpl
    })
    async function* body(_reset: () => void, signal: AbortSignal) {
      try {
        yield Buffer.from('x')
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve(), { once: true })
        })
        signal.throwIfAborted()
      } finally {
        closed = true
      }
    }
    try {
      const pending = client.uploadMultipart('/upload', 'application/octet-stream', 1, body)
      const assertion = expect(pending).rejects.toMatchObject({
        name: 'TimeoutError',
        message: '上传无进展超时，结果需核对'
      })
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      await assertion
      expect(closed).toBe(true)
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('JavaKnowledgeUpload 无重试 / 无 30s 总超时', () => {
  it('仅发起一次请求（无重试）', async () => {
    const { client, fetchImpl } = setup(() => okUpload())
    await uploadJavaKnowledgeFile(client, baseParams({ filePath, fileSize, expectedHash: fileHash }))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('即使 timeoutMs 极小也不被 30s 总超时中断（沿用无进展超时语义）', async () => {
    // 关键：uploadMultipart 不得引用 options.timeoutMs（即不套 30s 总超时）。
    // 这里把 timeoutMs 设到极小，若误用则会立即中止上传；成功即证明未套用。
    const captured: Captured = {}
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries())
      Object.assign(captured, { headers })
      expect(Number(headers['content-length'])).toBeGreaterThan(0)
      return okUpload()
    })
    const client = new JavaKnowledgeClient({
      baseUrl: 'https://ent.test',
      getAccessToken: async () => 't',
      fetchImpl,
      onSessionExpired: vi.fn(),
      timeoutMs: 1
    })
    await expect(
      uploadJavaKnowledgeFile(client, baseParams({ filePath, fileSize, expectedHash: fileHash }))
    ).resolves.toEqual({ knowledgeId: UUID_A, fileId: FILE_A, chunkCount: 1 })
  })
})

describe('JavaKnowledgeUpload beforeSend 租约', () => {
  it('取 token 后、发请求前：租约抛错则不发请求', async () => {
    const { client, fetchImpl } = setup(() => okUpload())
    await expect(
      uploadJavaKnowledgeFile(
        client,
        baseParams({
          beforeSend: () => {
            throw new Error('账号已切换')
          }
        })
      )
    ).rejects.toThrow('账号已切换')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('账号切换租约：租约在取 token 之后才校验', async () => {
    let tokenFetchedBeforeLease = false
    const getAccessToken = vi.fn(async () => {
      tokenFetchedBeforeLease = true
      return 't'
    })
    const lease = { account: 'alice' }
    const fetchImpl = vi.fn<typeof fetch>(async () => okUpload())
    const client = new JavaKnowledgeClient({
      baseUrl: 'https://ent.test',
      getAccessToken,
      fetchImpl,
      onSessionExpired: vi.fn()
    })
    // 租约校验当前账号，与取 token 后一致 → 通过。
    await uploadJavaKnowledgeFile(
      client,
      baseParams({
        beforeSend: () => {
          if (!tokenFetchedBeforeLease) throw new Error('租约早于 token')
          if (lease.account !== 'alice') throw new Error('账号已切换')
        }
      })
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    // 切换账号后应停止发送。
    lease.account = 'bob'
    await expect(
      uploadJavaKnowledgeFile(
        client,
        baseParams({
          beforeSend: () => {
            if (lease.account !== 'alice') throw new Error('账号已切换')
          }
        })
      )
    ).rejects.toThrow('账号已切换')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('JavaKnowledgeUpload 原件指纹校验', () => {
  it('指纹一致则成功', async () => {
    const { client } = setup(() => okUpload())
    await expect(
      uploadJavaKnowledgeFile(client, baseParams({ filePath, fileSize, expectedHash: fileHash }))
    ).resolves.toMatchObject({ knowledgeId: UUID_A, fileId: FILE_A })
  })

  it('指纹不一致则拒绝（不静默放行）', async () => {
    const { client } = setup(() => okUpload())
    await expect(
      uploadJavaKnowledgeFile(client, baseParams({ filePath, fileSize, expectedHash: '0'.repeat(64) }))
    ).rejects.toThrow(/文件内容发生变化|文件大小发生变化/)
  })
})

describe('JavaKnowledgeUpload 文件名非法应拒绝', () => {
  const illegals = ['a/b.pdf', 'a\\b.pdf', 'ab.pdf', '   ', 'x'.repeat(251)]
  for (const name of illegals) {
    it(`拒绝非法文件名：${JSON.stringify(name)}`, async () => {
      const { client, fetchImpl } = setup(() => okUpload())
      await expect(
        uploadJavaKnowledgeFile(client, baseParams({ fileName: name, filePath, fileSize, expectedHash: fileHash }))
      ).rejects.toThrow(/文件名称/)
      expect(fetchImpl).not.toHaveBeenCalled()
    })
  }
})

describe('JavaKnowledgeUpload 响应校验', () => {
  it.each([1, 3])('返回 chunkCount=%s 与请求两块不一致时拒绝，不重发', async (count) => {
    const { client, fetchImpl } = setup(() => okUpload(UUID_A, FILE_A, count))
    await expect(
      uploadJavaKnowledgeFile(client, baseParams({ chunks: [{ content: 'a' }, { content: 'b' }] }))
    ).rejects.toThrow(/分块数/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('返回 chunkCount=0 视为未知结果，抛错不自动重发', async () => {
    const { client, fetchImpl } = setup(() => okUpload(UUID_A, FILE_A, 0))
    await expect(
      uploadJavaKnowledgeFile(client, baseParams({ filePath, fileSize, expectedHash: fileHash }))
    ).rejects.toThrow(/分块数|无效/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('知识库归属不符（knowledgeId 不匹配）抛错', async () => {
    const { client, fetchImpl } = setup(() => okUpload('22222222-2222-2222-2222-222222222222', FILE_A, 3))
    await expect(
      uploadJavaKnowledgeFile(client, baseParams({ filePath, fileSize, expectedHash: fileHash }))
    ).rejects.toThrow(/归属/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('业务码非 200 抛错（经由 unwrap，不重试）', async () => {
    const { client, fetchImpl } = setup(() =>
      Response.json({ code: 50001, msg: '参数错误', data: null, requestId: 'r' })
    )
    await expect(
      uploadJavaKnowledgeFile(client, baseParams({ filePath, fileSize, expectedHash: fileHash }))
    ).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('HTTP 401 触发会话失效且不再重试', async () => {
    const { client, fetchImpl, onSessionExpired } = setup(() => new Response(null, { status: 401 }))
    await expect(
      uploadJavaKnowledgeFile(client, baseParams({ filePath, fileSize, expectedHash: fileHash }))
    ).rejects.toThrow()
    expect(onSessionExpired).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('JavaKnowledgeUpload parentId', () => {
  it('提供 parentId 时随表单字段发送，且须为 32 位十六进制', async () => {
    const { client, captured } = setup(() => okUpload())
    await uploadJavaKnowledgeFile(client, baseParams({ parentId: FILE_A }))
    const { fields } = parseMultipart(captured.body!, captured.boundary!)
    expect(fields.parentId).toBe(FILE_A)
  })

  it('未提供 parentId 时不发送该字段', async () => {
    const { client, captured } = setup(() => okUpload())
    await uploadJavaKnowledgeFile(client, baseParams({}))
    const { fields } = parseMultipart(captured.body!, captured.boundary!)
    expect(fields.parentId).toBeUndefined()
  })

  it('非法 parentId 直接拒绝', async () => {
    const { client, fetchImpl } = setup(() => okUpload())
    await expect(uploadJavaKnowledgeFile(client, baseParams({ parentId: 'xyz' }))).rejects.toThrow(/父目录/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
