import { net } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RemoteKnowledgeClient, type RemoteKnowledgeClientConfig } from '../RemoteKnowledgeClient'

vi.mock('electron', () => ({
  net: { fetch: vi.fn() }
}))

const fetchMock = vi.mocked(net.fetch)

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function makeConfig(overrides: Partial<RemoteKnowledgeClientConfig> = {}): RemoteKnowledgeClientConfig {
  return {
    id: 'svc1',
    name: 's',
    baseUrl: 'https://kb.example.com',
    authType: 'bearer',
    headers: undefined,
    timeoutMs: 5000,
    enabled: true,
    hasApiKey: true,
    apiKey: 'secret',
    ...overrides
  }
}

const chunkA = {
  chunk_id: 'c-a',
  base_id: 'b1',
  document_id: 'd-a',
  title: 'Title A',
  content: 'Content A',
  score: 0.9
}
const chunkB = {
  chunk_id: 'c-b',
  base_id: 'b1',
  document_id: 'd-b',
  title: 'Title B',
  content: 'Content B',
  score: 0.4
}

describe('RemoteKnowledgeClient', () => {
  let client: RemoteKnowledgeClient

  beforeEach(() => {
    vi.clearAllMocks()
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ chunks: [chunkA, chunkB] })))
    client = new RemoteKnowledgeClient(makeConfig())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends Authorization: Bearer for bearer auth', async () => {
    await client.search({ query: 'q', base_ids: ['b1'], top_k: 8 })
    const [, init] = fetchMock.mock.calls[0]
    const headers = new Headers(init?.headers)
    expect(headers.get('Authorization')).toBe('Bearer secret')
  })

  it('sends X-API-Key for api_key auth', async () => {
    client = new RemoteKnowledgeClient(makeConfig({ authType: 'api_key' }))
    await client.search({ query: 'q', base_ids: ['b1'], top_k: 8 })
    const [, init] = fetchMock.mock.calls[0]
    const headers = new Headers(init?.headers)
    expect(headers.get('X-API-Key')).toBe('secret')
    expect(headers.has('Authorization')).toBe(false)
  })

  it('merges custom headers and lets the auth header win on collision', async () => {
    // custom header present
    client = new RemoteKnowledgeClient(makeConfig({ headers: { 'X-Tenant': 't1' } }))
    await client.search({ query: 'q', base_ids: ['b1'], top_k: 8 })
    let headers = new Headers(fetchMock.mock.calls[0][1]?.headers)
    expect(headers.get('X-Tenant')).toBe('t1')
    expect(headers.get('Authorization')).toBe('Bearer secret')

    // collision: auth header wins over a custom Authorization
    client = new RemoteKnowledgeClient(makeConfig({ headers: { Authorization: 'Bearer custom-override' } }))
    await client.search({ query: 'q', base_ids: ['b1'], top_k: 8 })
    headers = new Headers(fetchMock.mock.calls[1][1]?.headers)
    expect(headers.get('Authorization')).toBe('Bearer secret')
  })

  it('maps a search response to the chunks array', async () => {
    const result = await client.search({ query: 'q', base_ids: ['b1'], top_k: 8 })
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ chunk_id: 'c-a', score: 0.9 })
  })

  it('force-truncates results beyond top_k', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...chunkA, chunk_id: `c-${i}`, score: 1 - i * 0.01 }))
    fetchMock.mockResolvedValue(jsonResponse({ chunks: many }))
    const result = await client.search({ query: 'q', base_ids: ['b1'], top_k: 8 })
    expect(result).toHaveLength(8)
  })

  it('clamps out-of-range scores into [0, 1]', async () => {
    const chunks = [
      { ...chunkA, chunk_id: 'hi', score: 1.5 },
      { ...chunkB, chunk_id: 'lo', score: -0.2 }
    ]
    fetchMock.mockResolvedValue(jsonResponse({ chunks }))
    const result = await client.search({ query: 'q', base_ids: ['b1'], top_k: 8 })
    expect(result).toHaveLength(2)
    expect(result.find((c) => c.chunk_id === 'hi')?.score).toBe(1)
    expect(result.find((c) => c.chunk_id === 'lo')?.score).toBe(0)
  })

  it('rejects a 401 with the wire error code in the message', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 'unauthorized', message: 'token expired' } }, 401))
    await expect(client.search({ query: 'q', base_ids: ['b1'], top_k: 8 })).rejects.toThrow(/unauthorized/)
  })

  it('rejects a non-JSON error response with a readable upstream message', async () => {
    fetchMock.mockResolvedValue(new Response('not json at all', { status: 500 }))
    await expect(client.search({ query: 'q', base_ids: ['b1'], top_k: 8 })).rejects.toThrow(/upstream_error/)
  })

  it('rejects on network-layer failure without a bare throw', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    await expect(client.search({ query: 'q', base_ids: ['b1'], top_k: 8 })).rejects.toThrow(/network_error/)
  })

  it('aborts after timeout and sends an AbortSignal', async () => {
    client = new RemoteKnowledgeClient(makeConfig({ timeoutMs: 50 }))
    let capturedSignal: AbortSignal | null | undefined
    fetchMock.mockImplementation((_url, init) => {
      capturedSignal = init?.signal
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject((init.signal as AbortSignal)?.reason), { once: true })
      })
    })

    await expect(client.search({ query: 'q', base_ids: ['b1'], top_k: 8 })).rejects.toThrow(/timeout|abort/i)
    expect(capturedSignal).toBeInstanceOf(AbortSignal)
  })

  it('reads a document via POST /v1/knowledge/read', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ document_id: 'doc-7', title: 'T', content: 'C', total_chars: 10, truncated: false })
    )
    const result = await client.read({ base_id: 'b1', document_id: 'doc-7' })
    expect(result).toMatchObject({ document_id: 'doc-7', title: 'T', content: 'C' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://kb.example.com/v1/knowledge/read')
    expect(init?.method).toBe('POST')
  })

  it('checks health via GET /v1/health', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok' }))
    await client.health()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://kb.example.com/v1/health')
    expect(init?.method).toBe('GET')
  })

  it('lists bases via GET /v1/knowledge/bases', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ bases: [{ id: 'kb-1', name: 'n', description: 'd', document_count: 2 }] })
    )
    const bases = await client.listBases()
    expect(bases).toEqual([{ id: 'kb-1', name: 'n', description: 'd', documentCount: 2 }])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://kb.example.com/v1/knowledge/bases')
    expect(init?.method).toBe('GET')
  })

  it('ignores invalid document counts from older or non-conforming services', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        bases: [
          { id: 'zero', name: 'Zero', document_count: 0 },
          { id: 'negative', name: 'Negative', document_count: -1 },
          { id: 'decimal', name: 'Decimal', document_count: 1.5 },
          { id: 'string', name: 'String', document_count: '2' },
          { id: 'unsafe', name: 'Unsafe', document_count: Number.MAX_SAFE_INTEGER + 1 }
        ]
      })
    )

    await expect(client.listBases()).resolves.toEqual([
      { id: 'zero', name: 'Zero', documentCount: 0 },
      { id: 'negative', name: 'Negative' },
      { id: 'decimal', name: 'Decimal' },
      { id: 'string', name: 'String' },
      { id: 'unsafe', name: 'Unsafe' }
    ])
  })

  it('normalizes a baseUrl with a trailing slash', async () => {
    client = new RemoteKnowledgeClient(makeConfig({ baseUrl: 'https://kb.example.com/' }))
    fetchMock.mockResolvedValue(jsonResponse({ status: 'ok' }))
    await client.health()
    expect(fetchMock.mock.calls[0][0]).toBe('https://kb.example.com/v1/health')
  })
})
