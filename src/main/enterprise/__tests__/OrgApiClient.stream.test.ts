import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import { OrgApiClient } from '../OrgApiClient'
let root: string | undefined

it.each(['bearer', 'cookie'])('%s目录文件multipart可解析parent_id且长度准确', async (mode) => {
  root = await mkdtemp(join(tmpdir(), 'multipart-'))
  const path = join(root, 'file')
  await writeFile(path, 'abc')
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    const bytes = Buffer.from(await new Response(init.body as ReadableStream).arrayBuffer())
    if (mode === 'bearer') expect(bytes.length).toBe(Number((init.headers as any)['content-length']))
    const form = await new Response(bytes, {
      headers: { 'content-type': (init.headers as any)['content-type'] }
    }).formData()
    expect(form.get('parent_id')).toBe('trusted-parent')
    expect(form.get('file_name')).toBe('原文.txt')
    expect(await (form.get('file') as File).text()).toBe('abc')
    return Response.json({ ok: true })
  })
  vi.stubGlobal('fetch', fetcher)
  const client = new OrgApiClient(
    async () => ({ accessToken: 'token', authMode: mode === 'cookie' ? 'management-cookie' : undefined }) as never,
    fetcher
  )
  expect(
    await client.requestFileMultipart(
      '/upload',
      { path, fileName: '原文.txt', size: 3, chunks: [], parentId: 'trusted-parent' },
      () => {}
    )
  ).toEqual({ ok: true })
})

it.each(['bearer', 'cookie'])('%s上传无响应5分钟后中止且关闭源流，不重放', async (mode) => {
  root = await mkdtemp(join(tmpdir(), 'multipart-'))
  const path = join(root, 'file')
  await writeFile(path, Buffer.alloc(1024 * 1024))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let signal: AbortSignal | null | undefined
  let body: ReadableStream<Uint8Array> | undefined
  const fetcher = vi.fn((_url: unknown, init: RequestInit) => {
    signal = init.signal
    body = init.body as ReadableStream<Uint8Array>
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal!.reason), { once: true })
    })
  })
  vi.stubGlobal('fetch', fetcher)
  const client = new OrgApiClient(
    async () => ({ accessToken: 'token', authMode: mode === 'cookie' ? 'management-cookie' : undefined }) as never,
    fetcher
  )
  const result = client
    .requestFileMultipart('/upload', { path, fileName: 'file', size: 1024 * 1024, chunks: [] }, () => {})
    .catch((error) => error)
  await vi.advanceTimersByTimeAsync(300_000)
  expect(signal?.aborted).toBe(true)
  expect(await result).toMatchObject({ name: 'TimeoutError' })
  const reader = body!.getReader()
  while (!(await reader.read().catch(() => ({ done: true }))).done) {
    /* 排空已缓冲的前缀。 */
  }
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('持续消费字节可超过5分钟，停止进展后才超时', async () => {
  root = await mkdtemp(join(tmpdir(), 'multipart-'))
  const path = join(root, 'file')
  await writeFile(path, Buffer.alloc(1024 * 1024))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let reader!: ReadableStreamDefaultReader<Uint8Array>
  let signal!: AbortSignal
  const started = Promise.withResolvers<void>()
  vi.stubGlobal('fetch', (_url: unknown, init: RequestInit) => {
    reader = (init.body as ReadableStream<Uint8Array>).getReader()
    signal = init.signal!
    started.resolve()
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })
  const client = new OrgApiClient(async () => ({ accessToken: 'token' }) as never)
  let uploadedBytes = 0
  const result = client
    .requestFileMultipart('/upload', { path, fileName: 'file', size: 1024 * 1024, chunks: [] }, (bytes) => {
      uploadedBytes = bytes
    })
    .catch((error) => error)
  await started.promise
  for (let index = 0; index < 4; index++) {
    await vi.advanceTimersByTimeAsync(200_000)
    expect(signal.aborted).toBe(false)
    const before = uploadedBytes
    while (uploadedBytes === before) expect((await reader.read()).done).toBe(false)
  }
  await vi.advanceTimersByTimeAsync(300_000)
  expect(signal.aborted).toBe(true)
  expect(await result).toMatchObject({ name: 'TimeoutError' })
})

it.each([200, 422])('上传收到%s响应但响应体挂起仍有界，完成后清理计时器', async (status) => {
  root = await mkdtemp(join(tmpdir(), 'multipart-'))
  const path = join(root, 'file')
  await writeFile(path, 'abc')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          init.signal?.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true })
        }
      }),
      { status }
    )
    return response
  })
  const client = new OrgApiClient(async () => ({ accessToken: 'token' }) as never)
  const result = client
    .requestFileMultipart('/upload', { path, fileName: 'file', size: 3, chunks: [] }, () => {})
    .catch((error) => error)
  await vi.advanceTimersByTimeAsync(300_000)
  expect(await result).toMatchObject({ name: 'TimeoutError' })
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['size', 'hash'])('文件%s变化时请求体报错且不能提交完整multipart', async (change) => {
  root = await mkdtemp(join(tmpdir(), 'multipart-'))
  const path = join(root, 'file')
  await writeFile(path, 'changed')
  let received = ''
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    const reader = (init.body as ReadableStream<Uint8Array>).getReader()
    while (true) {
      const next = await reader.read()
      if (next.done) break
      received += Buffer.from(next.value).toString()
    }
    return new Response('{}')
  })
  const client = new OrgApiClient(async () => ({ accessToken: 'token' }) as never)
  await expect(
    client.requestFileMultipart(
      '/upload',
      {
        path,
        fileName: 'file',
        size: change === 'size' ? 3 : 7,
        chunks: [],
        hash: createHash('sha256').update('initial').digest('hex')
      },
      () => {}
    )
  ).rejects.toThrow(change === 'size' ? '大小发生变化' : '内容发生变化')
  expect(received).not.toMatch(/--\r\n$/)
})

it('提前拒绝请求后必须停止读取文件和进度回调', async () => {
  root = await mkdtemp(join(tmpdir(), 'multipart-'))
  const path = join(root, 'file')
  await writeFile(path, Buffer.alloc(1024 * 1024))
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
    reader = (init.body as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    throw new Error('连接关闭')
  })
  const progress = vi.fn()
  const client = new OrgApiClient(async () => ({ accessToken: 'token' }) as never)
  await expect(
    client.requestFileMultipart('/upload', { path, fileName: 'file', size: 1024 * 1024, chunks: [] }, progress)
  ).rejects.toThrow('连接关闭')
  const calls = progress.mock.calls.length
  const ended = await reader!.read().catch(() => ({ done: true }))
  expect(ended.done).toBe(true)
  expect(progress.mock.calls).toHaveLength(calls)
})
afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  if (root) await rm(root, { recursive: true, force: true })
})
it('Cookie流式传输不设置Chromium拒绝的Content-Length且携带会话', async () => {
  root = await mkdtemp(join(tmpdir(), 'multipart-'))
  const path = join(root, 'file')
  await writeFile(path, 'abc')
  const cookieFetch = vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.headers).not.toHaveProperty('content-length')
    expect(init.credentials).toBe('include')
    expect(init.redirect).toBe('error')
    const reader = (init.body as ReadableStream<Uint8Array>).getReader()
    let body = ''
    while (true) {
      const next = await reader.read()
      if (next.done) break
      body += Buffer.from(next.value).toString()
    }
    expect(body).toContain('abc')
    expect(body).toMatch(/--\r\n$/)
    return new Response('{"ok":true}')
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const client = new OrgApiClient(async () => ({ authMode: 'management-cookie' }) as never, cookieFetch)
  expect(
    await client.requestFileMultipart('/upload', { path, fileName: 'file', size: 3, chunks: [] }, () => {})
  ).toEqual({ ok: true })
  expect(vi.getTimerCount()).toBe(0)
})

it('逐块消费multipart时持续报告字节，401后不重放消费过的流', async () => {
  root = await mkdtemp(join(tmpdir(), 'multipart-'))
  const path = join(root, 'file')
  await writeFile(path, Buffer.alloc(1024 * 1024, 97))
  const progress: number[] = []
  const fetcher = vi.fn(async (_url, init) => {
    expect(init.headers['content-type']).toContain('multipart/form-data; boundary=')
    const reader = init.body.getReader()
    let bytes = 0
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
    }
    expect(bytes).toBe(Number(init.headers['content-length']))
    expect(progress.length).toBeGreaterThan(2)
    expect(progress.at(-1)).toBe(1024 * 1024)
    return new Response('{}', { status: 401 })
  })
  vi.stubGlobal('fetch', fetcher)
  const client = new OrgApiClient(async () => ({ accessToken: 'token' }) as never)
  await expect(
    client.requestFileMultipart(
      '/api/kb/v1/local-share/spaces/s/files',
      { path, fileName: '原文.txt', size: 1024 * 1024, chunks: [] },
      (value) => progress.push(value)
    )
  ).rejects.toMatchObject({ status: 401 })
  expect(fetcher).toHaveBeenCalledTimes(1)
})
