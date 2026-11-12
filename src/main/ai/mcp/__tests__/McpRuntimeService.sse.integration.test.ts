import { getEventListeners } from 'node:events'
import { createServer, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import type { Socket } from 'node:net'

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { MockMainCacheServiceUtils } from '@test-mocks/main/CacheService'
import { net } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { application } from '@application'
import { BaseService } from '@main/core/lifecycle'
import type { McpServer } from '@shared/data/types/mcpServer'

vi.mock('open', () => ({ default: vi.fn() }))
const { servers } = vi.hoisted(() => ({ servers: new Map<string, McpServer>() }))
vi.mock('@data/services/McpServerService', () => ({
  mcpServerService: { getById: (id: string) => servers.get(id) }
}))

const { McpRuntimeService } = await import('../McpRuntimeService')
const require = createRequire(import.meta.url)
const cjs = require('@modelcontextprotocol/sdk/client/sse.js') as { SSEClientTransport: typeof SSEClientTransport }

async function localServer({ holdInitialize = false } = {}) {
  const sockets = new Set<Socket>()
  const requests: string[] = []
  const authorization: Array<string | undefined> = []
  const streams = new Map<string, ServerResponse>()
  const messages: Array<{ id?: number; method: string; params?: { name?: string; arguments?: { text?: string } } }> = []
  const pendingReplies: Array<() => void> = []
  const reply = (id: number | undefined, result: unknown) => {
    streams.get('/normal')!.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`)
  }
  const server = createServer(async (req, res) => {
    const path = req.url!
    requests.push(path)
    authorization.push(req.headers.authorization)
    streams.set(path, res)
    if (path === '/token') {
      res
        .writeHead(200, { 'content-type': 'application/json', Connection: 'close' })
        .end(JSON.stringify({ access_token: 'synthetic-refreshed', token_type: 'Bearer' }))
      return
    }
    if (path.startsWith('/.well-known/')) {
      res.writeHead(404, { Connection: 'close' }).end()
      return
    }
    if (path === '/headers' || path === '/http') return
    if (path === '/unauthorized') {
      res.writeHead(401).end()
      return
    }
    if (req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      const message = JSON.parse(body) as (typeof messages)[number]
      messages.push(message)
      res.writeHead(202, { Connection: 'close' }).end()
      if (message.method === 'initialize') {
        const initialize = () =>
          reply(message.id, {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'local', version: '1' }
          })
        if (holdInitialize) pendingReplies.push(initialize)
        else initialize()
      } else if (message.method === 'tools/list') {
        reply(message.id, {
          tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }]
        })
      } else if (message.method === 'tools/call' && message.params?.name === 'echo') {
        reply(message.id, { content: [{ type: 'text', text: message.params.arguments?.text ?? '' }] })
      } else if (message.method === 'ping') {
        reply(message.id, {})
      }
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.flushHeaders()
    if (path === '/normal') res.write('event: endpoint\ndata: /messages\n\n')
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return {
    url: (path: string) => new URL(`http://127.0.0.1:${address.port}${path}`),
    requests,
    sockets,
    streams,
    messages,
    pendingReplies,
    authorization,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  }
}

// Node fetch 的空闲连接可能延后关闭；期限只判失败，不代替原始 Promise settle。
vi.setConfig({ testTimeout: 15_000 })
const cleanups: Array<() => Promise<unknown>> = []
beforeEach(() => {
  BaseService.resetInstances()
  servers.clear()
  MockMainCacheServiceUtils.resetMocks()
  vi.mocked(net.fetch).mockImplementation((url, init) => fetch(url, init))
})
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  vi.restoreAllMocks()
})

// 捕获真实 start/connect 永不 settle、仅关闭 socket 却假报 stop 成功的缺陷。
describe.each([
  ['ESM', SSEClientTransport],
  ['CJS', cjs.SSEClientTransport]
] as const)('%s SSE 真实连接', (_name, Transport) => {
  it.each(['/headers', '/events'])('关闭拒绝原始 connect：%s', async (path) => {
    const server = await localServer()
    cleanups.push(server.close)
    const transport = new Transport(server.url(path))
    cleanups.push(() => transport.close())
    const client = new Client({ name: 'test', version: '1' })
    const outcome = client.connect(transport).then(
      () => 'success',
      (error: Error) => error
    )
    await vi.waitFor(() => expect(server.requests).toContain(path))
    await transport.close()
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(server.sockets.size).toBe(0), { timeout: 6_000 })
    expect(getEventListeners((transport as any)._abortController.signal, 'abort')).toHaveLength(0)
  })

  it('正常 endpoint 和 initialize 成功，重复关闭仅通知一次且不可重新启动', async () => {
    const server = await localServer()
    cleanups.push(server.close)
    const transport = new Transport(server.url('/normal'))
    cleanups.push(() => transport.close())
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(transport)
    expect(client.getServerVersion()).toEqual({ name: 'local', version: '1' })
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['echo'])
    expect(await client.callTool({ name: 'echo', arguments: { text: '本机合成回声' } })).toEqual({
      content: [{ type: 'text', text: '本机合成回声' }]
    })
    const closed = vi.fn()
    transport.onclose = closed
    await transport.close()
    await transport.close()
    expect(closed).toHaveBeenCalledTimes(1)
    await expect(transport.start()).rejects.toThrow()
    await vi.waitFor(() => expect(server.sockets.size).toBe(0), { timeout: 6_000 })
  })

  it('有效 OAuth token 保留正常 SSE 和 POST 授权头，AUTHORIZED 续体仍可启动', async () => {
    const server = await localServer()
    cleanups.push(server.close)
    let token = { access_token: 'synthetic-oauth', token_type: 'Bearer', refresh_token: 'synthetic-refresh' }
    const provider = {
      redirectUrl: server.url('/callback').href,
      clientMetadata: { redirect_uris: [server.url('/callback').href] },
      discoveryState: () => ({
        authorizationServerUrl: server.url('/').href,
        resourceMetadata: { resource: server.url('/normal').href },
        authorizationServerMetadata: {
          issuer: server.url('/').href,
          authorization_endpoint: server.url('/authorize').href,
          token_endpoint: server.url('/token').href
        }
      }),
      tokens: () => token,
      saveTokens: (value: typeof token) => {
        token = value
      },
      clientInformation: () => ({ client_id: 'local-test' })
    } as unknown as OAuthClientProvider
    const transport = new Transport(server.url('/normal'), { authProvider: provider })
    cleanups.push(() => transport.close())
    const client = new Client({ name: 'test', version: '1' })
    await client.connect(transport)
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['echo'])
    expect(server.authorization.every((header) => header === 'Bearer synthetic-oauth')).toBe(true)
    await client.close()
    await vi.waitFor(() => expect(server.sockets.size).toBe(0), { timeout: 6_000 })
    const authorized = new Transport(server.url('/normal'), { authProvider: provider })
    cleanups.push(() => authorized.close())
    await (authorized as any)._authThenStart()
    expect(token.access_token).toBe('synthetic-refreshed')
    expect(server.requests).toContain('/token')
    expect(server.authorization.at(-1)).toBe('Bearer synthetic-refreshed')
    await authorized.close()
    await vi.waitFor(() => expect(server.sockets.size).toBe(0), { timeout: 6_000 })
  })

  it('关闭结束所有 OAuth 嵌套 start，迟到 tokens 不得重新发起连接', async () => {
    const server = await localServer()
    cleanups.push(server.close)
    let release!: (value: undefined) => void
    const tokens = new Promise<undefined>((resolve) => {
      release = resolve
    })
    const provider = { tokens: () => tokens } as unknown as OAuthClientProvider
    const transport = new Transport(server.url('/events'), { authProvider: provider })
    cleanups.push(() => transport.close())
    const pending = [transport.start(), (transport as any)._startOrAuth()].map((promise: Promise<void>) =>
      promise.then(
        () => 'success',
        (error: Error) => error
      )
    )
    await transport.close()
    release(undefined)
    for (const outcome of await Promise.all(pending)) expect(outcome).toMatchObject({ name: 'AbortError' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(server.requests).toEqual([])
    expect(getEventListeners((transport as any)._abortController.signal, 'abort')).toHaveLength(0)
  })

  it('OAuth AUTHORIZED 续体在 close 后不得重连', async () => {
    const server = await localServer()
    cleanups.push(server.close)
    let release!: (value: { access_token: string; token_type: string }) => void
    const tokens = new Promise<{ access_token: string; token_type: string }>((resolve) => {
      release = resolve
    })
    const provider = {
      tokens: () => tokens,
      clientInformation: () => ({ client_id: 'local-test' })
    } as unknown as OAuthClientProvider
    const transport = new Transport(server.url('/events'), { authProvider: provider })
    cleanups.push(() => transport.close())
    const outcome = (transport as any)._authThenStart().then(
      () => 'success',
      (error: Error) => error
    )
    await transport.close()
    release({ access_token: 'test-only', token_type: 'Bearer' })
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    expect(server.requests).toEqual([])
  })
})

function runtimeFor(server: Awaited<ReturnType<typeof localServer>>, path = '/normal') {
  const config = {
    id: 'local-runtime',
    name: 'local-runtime',
    isActive: true,
    type: 'sse',
    baseUrl: server.url(path).href,
    headers: { Authorization: 'Bearer test-only' }
  } as McpServer
  servers.set(config.id, config)
  const runtime = new McpRuntimeService()
  cleanups.push(() => (runtime as any).onStop())
  return { runtime, config }
}

function expectEmptyRuntime(runtime: InstanceType<typeof McpRuntimeService>) {
  for (const key of ['clients', 'pendingClients', 'connectingTransports', 'pendingProbes', 'activeToolCalls']) {
    expect((runtime as any)[key].size, key).toBe(0)
  }
}

// 捕获工具取消只释放外层等待、旧连接阻塞下一 runtime 或停止后复活连接的缺陷。
it('长工具调用在重复 stop 时真实拒绝，清空 socket；新 runtime 可重新列举并调用', async () => {
  const server = await localServer()
  cleanups.push(server.close)
  const { runtime, config } = runtimeFor(server)
  const outcome = runtime.callTool({ serverId: config.id, name: 'hold', args: {}, callId: 'long-call' }).then(
    () => 'unexpected success',
    (error: Error) => error
  )
  await vi.waitFor(() => expect(server.messages.some((message) => message.method === 'tools/call')).toBe(true))
  await Promise.all([(runtime as any).onStop(), (runtime as any).onStop()])
  expect(await outcome).toMatchObject({ name: 'McpError', code: -32001, data: undefined })
  expect(((await outcome) as Error).message).toContain('AbortError')
  await vi.waitFor(() => expect(server.sockets.size).toBe(0), { timeout: 6_000 })
  expectEmptyRuntime(runtime)
  const requestsAfterStop = server.requests.length
  await expect(runtime.withClient(config.id, (client) => client.listTools())).rejects.toThrow('stopping')
  expect(server.requests).toHaveLength(requestsAfterStop)

  BaseService.resetInstances()
  const { runtime: next } = runtimeFor(server)
  expect((await next.withClient(config.id, (client) => client.listTools())).tools.map((tool) => tool.name)).toEqual([
    'echo'
  ])
  expect(await next.callTool({ serverId: config.id, name: 'echo', args: { text: 'fresh-runtime' } })).toEqual({
    content: [{ type: 'text', text: 'fresh-runtime' }]
  })
  expect(server.requests.filter((path) => path === '/normal')).toHaveLength(2)
  await (next as any).onStop()
  await vi.waitFor(() => expect(server.sockets.size).toBe(0), { timeout: 6_000 })
  expectEmptyRuntime(next)
})

it.each(['endpoint', 'initialize'] as const)('%s 成功事件与 stop 同轮竞争，不得迟到缓存或重连', async (stage) => {
  const server = await localServer({ holdInitialize: true })
  cleanups.push(server.close)
  const { runtime, config } = runtimeFor(server, stage === 'endpoint' ? '/events' : '/normal')
  const operation = vi.fn(async () => 'unexpected success')
  const outcome = runtime.withClient(config.id, operation).then(
    (value) => value,
    (error: Error) => error
  )
  if (stage === 'endpoint') {
    await vi.waitFor(() => expect(server.streams.has('/events')).toBe(true))
    server.streams.get('/events')!.write('event: endpoint\ndata: /messages\n\n')
  } else {
    await vi.waitFor(() => expect(server.pendingReplies).toHaveLength(1))
    server.pendingReplies[0]()
  }
  await (runtime as any).onStop()
  expect(await outcome).toMatchObject({ name: 'AbortError' })
  expect(operation).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(server.sockets.size).toBe(0), { timeout: 6_000 })
  expectEmptyRuntime(runtime)
  expect(application.get('CacheService').getShared(`mcp.status.${config.id}`)).toMatchObject({ state: 'connecting' })
  expect(server.requests.filter((path) => path === '/events' || path === '/normal')).toHaveLength(1)
})

it('SDK connect 已成功但 runtime 续体尚未执行时 stop，不得缓存成功连接', async () => {
  const server = await localServer()
  cleanups.push(server.close)
  const { runtime, config } = runtimeFor(server)
  const original = Client.prototype.connect
  let stopping: Promise<void> | undefined
  vi.spyOn(Client.prototype, 'connect').mockImplementation(async function (this: Client, ...args) {
    await original.apply(this, args)
    stopping = (runtime as any).onStop()
  })
  const operation = vi.fn(async () => 'unexpected success')
  await expect(runtime.withClient(config.id, operation)).rejects.toMatchObject({ name: 'AbortError' })
  expect(stopping).toBeDefined()
  await stopping
  expect(operation).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(server.sockets.size).toBe(0), { timeout: 6_000 })
  expectEmptyRuntime(runtime)
  expect(application.get('CacheService').getShared(`mcp.status.${config.id}`)).toMatchObject({ state: 'connecting' })
  expect(server.requests.filter((path) => path === '/normal')).toHaveLength(1)
})

it('2 SSE + HTTP 同时挂起时 stop 完成，所有原始 connect 拒绝且 socket 全关闭', async () => {
  const server = await localServer()
  cleanups.push(server.close)
  const service = new McpRuntimeService()
  const outcomes = ['/headers', '/events', '/http'].map((path, index) => {
    const config = {
      id: `real-${index}`,
      name: `real-${index}`,
      isActive: true,
      type: index === 2 ? 'streamableHttp' : 'sse',
      baseUrl: server.url(path).href,
      headers: { Authorization: 'Bearer test-only' }
    } as McpServer
    servers.set(config.id, config)
    return service
      .withClient(config.id, async () => 'success')
      .then(
        (value) => value,
        (error: Error) => error
      )
  })
  await vi.waitFor(() => expect(server.requests).toHaveLength(3))
  await (service as any).onStop()
  for (const outcome of await Promise.all(outcomes)) expect(outcome).toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(server.sockets.size).toBe(0), { timeout: 6_000 })
  expect((service as any).pendingClients.size).toBe(0)
  expect((service as any).connectingTransports.size).toBe(0)
  expect((service as any).clients.size).toBe(0)
  expect(server.requests).toHaveLength(3)
})
