import { type ChildProcess, spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Real HTTP integration: the client's `net.fetch` is the Electron bridge over
// global fetch, so this suite mocks only the bridge and lets every byte
// otherwise flow over a real loopback TCP connection to the spawned mock
// server (tests/fixtures/remote-knowledge-server.mjs). Health/bases/search/read,
// the error model, auth and timeout behavior are exercised, not stubbed.
vi.mock('electron', () => ({
  net: {
    fetch: (...args: Parameters<typeof fetch>) => fetch(...args)
  }
}))

import { RemoteKnowledgeClient } from '../RemoteKnowledgeClient'

const SERVER_SCRIPT = path.resolve(__dirname, '../../../../../tests/fixtures/remote-knowledge-server.mjs')

interface MockServer {
  child: ChildProcess
  baseUrl: string
}

/** Spawns the mock server on a free port and waits until /v1/health answers. */
async function startMockServer(env: Record<string, string> = {}): Promise<MockServer> {
  const child = spawn(process.execPath, [SERVER_SCRIPT], {
    env: { ...process.env, PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')

  let output = ''
  const portPromise = new Promise<string>((resolve, reject) => {
    const onData = (chunk: string) => {
      output += chunk
      const match = output.match(/127\.0\.0\.1:(\d+)/)
      if (match) {
        child.stdout?.off('data', onData)
        resolve(match[1])
      }
    }
    child.stdout?.on('data', onData)
    child.once('exit', (code) => reject(new Error(`mock server exited early (code ${code}): ${output}`)))
  })

  const port = await Promise.race([
    portPromise,
    delay(10_000).then(() => Promise.reject(new Error('mock server start timeout')))
  ])
  const baseUrl = `http://127.0.0.1:${port}`

  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/v1/health`)
      // 401 counts as ready too: the server is listening and enforcing auth
      // (the AUTH_TOKEN instance rejects the unauthenticated probe).
      if (response.ok || response.status === 401) return { child, baseUrl }
    } catch {
      // not listening yet
    }
    await delay(100)
  }
  child.kill()
  throw new Error('mock server did not become ready in time')
}

const runningServers: ChildProcess[] = []

// Populated in beforeAll alongside the spawned servers:
// - `default`: no auth required (AUTH_TOKEN unset).
// - `authed`: requires `Authorization: Bearer secret-token`.
const servers: { default: MockServer; authed: MockServer } = {} as never

beforeAll(async () => {
  servers.default = await startMockServer()
  runningServers.push(servers.default.child)
  servers.authed = await startMockServer({ AUTH_TOKEN: 'secret-token' })
  runningServers.push(servers.authed.child)
})

afterAll(() => {
  for (const child of runningServers) child.kill()
})

function makeClient(overrides: Partial<ConstructorParameters<typeof RemoteKnowledgeClient>[0]> = {}) {
  return new RemoteKnowledgeClient({
    id: 'svc-int',
    name: 'integration',
    baseUrl: servers.default.baseUrl,
    authType: 'bearer',
    timeoutMs: 5000,
    ...overrides
  })
}

describe('RemoteKnowledgeClient (real HTTP against mock server)', () => {
  it('health check succeeds over real HTTP', async () => {
    await expect(makeClient().health()).resolves.toBeUndefined()
  })

  it('lists bases from the mock corpus', async () => {
    const bases = await makeClient().listBases()
    expect(bases.map((base) => base.id)).toEqual(['getting-started', 'recipes', 'faq'])
    expect(bases[0]).toMatchObject({ name: 'Getting Started', description: 'Onboarding guides' })
  })

  it('searches and returns scored chunks for a keyword query', async () => {
    const chunks = await makeClient().search({ query: 'pancakes syrup', base_ids: ['recipes'], top_k: 5 })

    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0]).toMatchObject({ base_id: 'recipes', document_id: 'doc-pancakes' })
    for (const chunk of chunks) {
      expect(chunk.score).toBeGreaterThanOrEqual(0)
      expect(chunk.score).toBeLessThanOrEqual(1)
    }
  })

  it('respects top_k truncation on the response', async () => {
    const chunks = await makeClient().search({
      query: 'the',
      base_ids: ['getting-started', 'recipes', 'faq'],
      top_k: 2
    })
    expect(chunks.length).toBeLessThanOrEqual(2)
  })

  it('reads a full document and a narrowed chunk with truncation metadata', async () => {
    const full = await makeClient().read({ base_id: 'recipes', document_id: 'doc-pancakes' })

    expect(full).toMatchObject({ document_id: 'doc-pancakes', title: 'Pancakes' })
    // Full-document read: the returned content IS the whole document.
    expect(full.total_chars).toBe(full.content.length)
    expect(full.truncated).toBe(false)

    // Chunk read: one split of the document, flagged truncated against the full text.
    const chunk = await makeClient().read({
      base_id: 'recipes',
      document_id: 'doc-pancakes',
      chunk_id: 'doc-pancakes-p0-c1'
    })
    expect(chunk.content.length).toBeLessThan(chunk.total_chars!)
    expect(chunk.truncated).toBe(true)
  })

  it('maps 404 to the wire error code', async () => {
    await expect(makeClient().read({ base_id: 'recipes', document_id: 'doc-missing' })).rejects.toThrow(
      /not_found: Unknown document/
    )
  })

  it('rejects with 401 unauthorized when the bearer token mismatches', async () => {
    const client = makeClient({ id: 'svc-auth-wrong', baseUrl: servers.authed.baseUrl, apiKey: 'wrong-token' })
    await expect(client.health()).rejects.toThrow(/^unauthorized:/)
  })

  it('succeeds with the correct bearer token', async () => {
    const client = makeClient({ id: 'svc-auth-ok', baseUrl: servers.authed.baseUrl, apiKey: 'secret-token' })
    await expect(client.health()).resolves.toBeUndefined()
  })

  it('times out when the server delays beyond timeoutMs', async () => {
    // `X-Test-Delay` makes the server sleep 2000ms before answering; the 300ms
    // client timeout must abort first.
    const client = makeClient({
      id: 'svc-timeout',
      timeoutMs: 300,
      headers: { 'X-Test-Delay': '2000' }
    })
    await expect(client.health()).rejects.toThrow(/request_timeout/)
  })

  it('strips a trailing slash from the baseUrl when building request URLs', async () => {
    await expect(makeClient({ baseUrl: `${servers.default.baseUrl}/` }).health()).resolves.toBeUndefined()
  })

  it('propagates connection refusal as network_error', async () => {
    const client = makeClient({ id: 'svc-refused', baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 })
    await expect(client.health()).rejects.toThrow(/^network_error:/)
  })
})
