import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { open } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mockMainLoggerService } from '@test-mocks/MainLoggerService'
import { net } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Track the publish mechanism so we can prove the TOCTOU-prone stat+rename path is
// gone: the target is created atomically with `open(path, 'wx')` (O_EXCL), never a
// checked-then-created rename, so a concurrent target can never be overwritten.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    open: vi.fn(actual.open)
  }
})

import {
  IndustrialVideoDownloader,
  type IndustrialVideoDownloadConfig,
  deriveSafeFileName,
  isWithinDir
} from './IndustrialVideoDownload'

const BASE_URL = 'http://127.0.0.1:8848'
const TOKEN = 'service-secret-token'
const TIMEOUT_MS = 10_000

function makeConfig(overrides: Partial<IndustrialVideoDownloadConfig> = {}): IndustrialVideoDownloadConfig {
  return { baseUrl: BASE_URL, token: TOKEN, timeoutMs: TIMEOUT_MS, ...overrides }
}

function makeDownloader(overrides: Partial<IndustrialVideoDownloadConfig> = {}): IndustrialVideoDownloader {
  return new IndustrialVideoDownloader(makeConfig(overrides))
}

const fetchMock = vi.mocked(net.fetch)

/** Build a 200 Response whose body is the given bytes, with an explicit Content-Length. */
function bytesResponse(bytes: Uint8Array, contentLength?: number): Response {
  const headers: Record<string, string> = { 'content-length': String(contentLength ?? bytes.length) }
  return new Response(new Uint8Array(bytes).buffer, { status: 200, headers })
}

/** Build a 200 streaming Response with explicit (possibly mismatched) headers and no auto CL. */
function streamResponse(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      }
    }),
    { status: 200, headers }
  )
}

/** A 200 Response whose body never yields, until the stream is cancelled on abort. */
function stuckResponse(): Response {
  return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
    status: 200,
    headers: { 'content-length': '100' }
  })
}

function statusResponse(status: number, contentLength?: number): Response {
  const headers: Record<string, string> = {}
  if (contentLength !== undefined) headers['content-length'] = String(contentLength)
  return new Response('', { status, headers })
}

let workspaceDir: string

beforeEach(() => {
  vi.clearAllMocks()
  mockMainLoggerService.warn.mockClear()
  mockMainLoggerService.error.mockClear()
  mockMainLoggerService.info.mockClear()
  workspaceDir = mkdtempSync(join(tmpdir(), 'ivd-ws-'))
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(workspaceDir, { recursive: true, force: true })
})

describe('verified publication', () => {
  it('does not expose the final file name while the body is incomplete', async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            body = controller
          }
        }),
        { headers: { 'content-length': '3' } }
      )
    )
    const pending = makeDownloader().downloadArtifact({ serverPath: 'r/final.mp4', workspaceDir })
    await vi.waitFor(() => expect(readdirSync(workspaceDir).length).toBeGreaterThan(0))
    const exposed = existsSync(join(workspaceDir, 'final.mp4'))
    body.enqueue(new Uint8Array([1, 2, 3]))
    body.close()
    const result = await pending
    expect(exposed).toBe(false)
    expect(result, JSON.stringify(mockMainLoggerService.warn.mock.calls)).toMatchObject({ ok: true })
  })
})

describe('deriveSafeFileName', () => {
  it('takes the last segment of a unix artifact path', () => {
    expect(deriveSafeFileName('final/movie.mp4')).toBe('movie.mp4')
    expect(deriveSafeFileName('movie.mp4')).toBe('movie.mp4')
    expect(deriveSafeFileName('a/b/../c.mp4')).toBe('c.mp4')
  })

  it('defends Windows separators by reducing the path to its last segment', () => {
    // Backslashes are treated as separators, so the artifact name collapses to a
    // safe base name on every platform (no escape, no literal backslash in the file).
    expect(deriveSafeFileName('final\\sub\\movie.mp4')).toBe('movie.mp4')
    expect(deriveSafeFileName('final/dir\\evil.mp4')).toBe('evil.mp4')
  })

  it('rejects traversal, drive letters, empty, dot and control characters', () => {
    expect(deriveSafeFileName('..')).toBeNull()
    expect(deriveSafeFileName('.')).toBeNull()
    expect(deriveSafeFileName('')).toBeNull()
    expect(deriveSafeFileName('final', '..')).toBeNull()
    expect(deriveSafeFileName('final', 'C:evil.mp4')).toBeNull()
    expect(deriveSafeFileName('final', 'inline')).not.toBeNull()
    expect(deriveSafeFileName('final', `a${String.fromCharCode(0)}b.mp4`)).toBeNull()
  })

  it('rejects Windows reserved device names (with or without extension)', () => {
    for (const name of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9', 'con', 'nul.txt', 'COM1.mp4']) {
      expect(deriveSafeFileName('final', name)).toBeNull()
    }
    expect(deriveSafeFileName('final', 'movie.mp4')).not.toBeNull()
    expect(deriveSafeFileName('final', 'com10.mp4')).not.toBeNull()
  })
})

describe('isWithinDir', () => {
  it('accepts nested paths and rejects escapes', () => {
    expect(isWithinDir('/ws', '/ws/movie.mp4')).toBe(true)
    expect(isWithinDir('/ws', '/ws')).toBe(true)
    expect(isWithinDir('/ws', '/ws/../etc/passwd')).toBe(false)
    expect(isWithinDir('/ws', '/other/x')).toBe(false)
  })
})

describe('request shape', () => {
  it('issues GET /download?path=<encoded> with Bearer, manual redirect, and strips trailing slash', async () => {
    const dl = new IndustrialVideoDownloader(makeConfig({ baseUrl: `${BASE_URL}/` }))
    fetchMock.mockResolvedValueOnce(statusResponse(404))
    await dl.downloadArtifact({ serverPath: 'final/movie.mp4', workspaceDir })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${BASE_URL}/download?path=final%2Fmovie.mp4`)
    expect(init?.method).toBe('GET')
    expect(init?.redirect).toBe('manual')
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
  })
})

describe('successful streaming publish (real temp dir IO)', () => {
  it('streams bytes to a real file, verifies size, and publishes without buffering', async () => {
    const bytes = new Uint8Array(2 * 1024 * 1024)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff
    fetchMock.mockResolvedValueOnce(bytesResponse(bytes))

    const dl = makeDownloader()
    const result = await dl.downloadArtifact({ serverPath: 'final/movie.mp4', workspaceDir })

    expect(result, JSON.stringify(mockMainLoggerService.warn.mock.calls)).toMatchObject({ ok: true })
    if (result.ok) {
      expect(result.status).toBe(200)
      expect(result.size).toBe(bytes.length)
      expect(result.filePath).toBe(join(workspaceDir, 'movie.mp4'))
      expect(new Uint8Array(readFileSync(result.filePath))).toEqual(bytes)
    }
    // No leftover temp (.part.) files.
    expect(readdirSync(workspaceDir).some((f) => f.includes('.part.'))).toBe(false)
  })

  it('uses Content-Length when expectedSize is absent, and derives the file name from the path', async () => {
    const bytes = new Uint8Array(10)
    fetchMock.mockResolvedValueOnce(bytesResponse(bytes))
    const result = await makeDownloader().downloadArtifact({ serverPath: 'runs/x/demo (1).mp4', workspaceDir })
    expect(result, JSON.stringify(mockMainLoggerService.warn.mock.calls)).toMatchObject({ ok: true })
    if (result.ok) expect(result.filePath).toBe(join(workspaceDir, 'demo (1).mp4'))
  })

  it('prefers expectedSize and still verifies against the streamed bytes', async () => {
    const bytes = new Uint8Array(42)
    fetchMock.mockResolvedValueOnce(bytesResponse(bytes))
    const result = await makeDownloader().downloadArtifact({
      serverPath: 'final/movie.mp4',
      workspaceDir,
      expectedSize: 42
    })
    expect(result, JSON.stringify(mockMainLoggerService.warn.mock.calls)).toMatchObject({ ok: true })
    if (result.ok) expect(result.size).toBe(42)
  })
})

describe('size validation', () => {
  it('rejects when expectedSize and Content-Length disagree (before streaming)', async () => {
    fetchMock.mockResolvedValueOnce(bytesResponse(new Uint8Array(10), 999))
    const result = await makeDownloader().downloadArtifact({
      serverPath: 'final/movie.mp4',
      workspaceDir,
      expectedSize: 10
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('size_mismatch')
      expect(result.error.outcomeUnknown).toBe(false)
    }
    expect(readdirSync(workspaceDir).some((f) => f.includes('.part.'))).toBe(false)
    expect(existsSync(join(workspaceDir, 'movie.mp4'))).toBe(false)
  })

  it('rejects when streamed bytes disagree with the reliable size (after streaming)', async () => {
    // Content-Length claims 999 but only 10 bytes arrive.
    fetchMock.mockResolvedValueOnce(streamResponse(new Uint8Array(10), { 'content-length': '999' }))
    const result = await makeDownloader().downloadArtifact({ serverPath: 'final/movie.mp4', workspaceDir })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('size_mismatch')
    }
    expect(readdirSync(workspaceDir).some((f) => f.includes('.part.'))).toBe(false)
    expect(existsSync(join(workspaceDir, 'movie.mp4'))).toBe(false)
  })

  it('refuses to publish when there is no reliable total size', async () => {
    // Streaming 200 with no Content-Length and no expectedSize.
    fetchMock.mockResolvedValueOnce(streamResponse(new Uint8Array(16)))
    const result = await makeDownloader().downloadArtifact({ serverPath: 'final/movie.mp4', workspaceDir })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('no_reliable_size')
      expect(result.error.outcomeUnknown).toBe(false)
    }
    expect(existsSync(join(workspaceDir, 'movie.mp4'))).toBe(false)
  })

  it('rejects a malformed Content-Length instead of trusting a partial parse', async () => {
    // "100abc" must NOT be trusted as 100 — strict parsing rejects it, so without an
    // expectedSize there is no reliable size and the artifact is refused.
    fetchMock.mockResolvedValueOnce(streamResponse(new Uint8Array(10), { 'content-length': '100abc' }))
    const result = await makeDownloader().downloadArtifact({ serverPath: 'final/movie.mp4', workspaceDir })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('no_reliable_size')
  })
})

describe('publish semantics', () => {
  it('never overwrites an existing file; publishes to a unique new file and keeps the old', async () => {
    const finalPath = join(workspaceDir, 'movie.mp4')
    writeFileSync(finalPath, 'OLD-CONTENT')
    const bytes = new Uint8Array([1, 2, 3, 4])
    fetchMock.mockResolvedValueOnce(bytesResponse(bytes))

    const result = await makeDownloader().downloadArtifact({ serverPath: 'final/movie.mp4', workspaceDir })
    expect(result, JSON.stringify(mockMainLoggerService.warn.mock.calls)).toMatchObject({ ok: true })
    if (result.ok) {
      expect(result.filePath).not.toBe(finalPath)
      expect(result.filePath.startsWith(workspaceDir)).toBe(true)
      // old file preserved
      expect(readFileSync(finalPath, 'utf8')).toBe('OLD-CONTENT')
      // new file has correct content
      expect(new Uint8Array(readFileSync(result.filePath))).toEqual(bytes)
    }
  })

  it('publishes atomically via O_EXCL (open(path, wx)) — never the overwrite-prone stat+rename', async () => {
    const openSpy = vi.mocked(open)
    const bytes = new Uint8Array([9, 8, 7])
    fetchMock.mockResolvedValueOnce(bytesResponse(bytes))

    const result = await makeDownloader().downloadArtifact({ serverPath: 'final/movie.mp4', workspaceDir })
    expect(result, JSON.stringify(mockMainLoggerService.warn.mock.calls)).toMatchObject({ ok: true })
    // The publish opens the target with O_EXCL ('wx'): a single atomic create-or-fail
    // step with no stat-then-act window, so a concurrent target can never be overwritten.
    expect(openSpy).toHaveBeenCalledWith(expect.stringContaining('movie.mp4'), 'wx')
    if (result.ok) expect(new Uint8Array(readFileSync(result.filePath))).toEqual(bytes)
    // No temporary (.part) file is produced.
    expect(readdirSync(workspaceDir).some((f) => f.includes('.part.'))).toBe(false)
  })

  it('on a pre-existing target, streams to a unique name and keeps the old file (atomic, no overwrite)', async () => {
    const finalPath = join(workspaceDir, 'movie.mp4')
    writeFileSync(finalPath, 'OLD-CONTENT')
    const openSpy = vi.mocked(open)
    // First open (of the existing finalPath) reports EEXIST; the unique-name open then succeeds.
    openSpy.mockImplementationOnce(async () => {
      const e = new Error('EEXIST') as NodeJS.ErrnoException
      e.code = 'EEXIST'
      throw e
    })
    const bytes = new Uint8Array([1, 2, 3])
    fetchMock.mockResolvedValueOnce(bytesResponse(bytes))

    const result = await makeDownloader().downloadArtifact({ serverPath: 'final/movie.mp4', workspaceDir })
    expect(result, JSON.stringify(mockMainLoggerService.warn.mock.calls)).toMatchObject({ ok: true })
    if (result.ok) {
      expect(result.filePath).not.toBe(finalPath)
      expect(readFileSync(finalPath, 'utf8')).toBe('OLD-CONTENT')
      expect(new Uint8Array(readFileSync(result.filePath))).toEqual(bytes)
    }
  })
})

it('preserves the video extension when repeated downloads cannot overwrite the original', async () => {
  const original = join(workspaceDir, 'movie.mp4')
  writeFileSync(original, 'ORIGINAL')
  const bytes = new Uint8Array([1, 2, 3])
  fetchMock.mockResolvedValueOnce(bytesResponse(bytes))
  const result = await makeDownloader().downloadArtifact({ serverPath: 'final/movie.mp4', workspaceDir })
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.filePath).toMatch(/movie\.[\w-]+\.mp4$/)
    expect(readFileSync(original, 'utf8')).toBe('ORIGINAL')
    expect(new Uint8Array(readFileSync(result.filePath))).toEqual(bytes)
  }
})

describe('rejections', () => {
  it('rejects a 3xx redirect and does not follow (no token re-send)', async () => {
    fetchMock.mockResolvedValueOnce(statusResponse(302))
    const result = await makeDownloader().downloadArtifact({ serverPath: 'final/movie.mp4', workspaceDir })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('redirect')
      expect(result.error.status).toBe(302)
    }
  })

  it('rejects a 206 partial response (no resume in v1)', async () => {
    fetchMock.mockResolvedValueOnce(statusResponse(206))
    const result = await makeDownloader().downloadArtifact({ serverPath: 'final/movie.mp4', workspaceDir })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('partial')
      expect(result.error.status).toBe(206)
    }
  })

  it('maps 4xx to http error with outcomeUnknown false', async () => {
    fetchMock.mockResolvedValueOnce(statusResponse(404))
    const result = await makeDownloader().downloadArtifact({ serverPath: 'final/movie.mp4', workspaceDir })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('http')
      expect(result.error.status).toBe(404)
      expect(result.error.outcomeUnknown).toBe(false)
    }
  })

  it('maps 5xx to http error with outcomeUnknown true', async () => {
    fetchMock.mockResolvedValueOnce(statusResponse(503))
    const result = await makeDownloader().downloadArtifact({ serverPath: 'final/movie.mp4', workspaceDir })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('http')
      expect(result.error.status).toBe(503)
      expect(result.error.outcomeUnknown).toBe(true)
    }
  })

  it('rejects an unsafe file name before any network use', async () => {
    const result = await makeDownloader().downloadArtifact({
      serverPath: 'final',
      workspaceDir,
      fileName: 'C:evil.mp4'
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('filename_unsafe')
  })
})

describe('timeout / abort release', () => {
  it('returns a timeout error (outcome unknown) and removes the temp file when transfer is aborted by the internal timer', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValueOnce(stuckResponse())
    const promise = makeDownloader().downloadArtifact({ serverPath: 'final/movie.mp4', workspaceDir })
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1)
    const result = await promise
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('timeout')
      expect(result.error.outcomeUnknown).toBe(true)
    }
    expect(readdirSync(workspaceDir).some((f) => f.includes('.part.'))).toBe(false)
    expect(existsSync(join(workspaceDir, 'movie.mp4'))).toBe(false)
  })

  it('releases the stream and returns a timeout error when the external signal aborts mid-transfer', async () => {
    fetchMock.mockResolvedValueOnce(stuckResponse())
    const controller = new AbortController()
    const promise = makeDownloader().downloadArtifact({
      serverPath: 'final/movie.mp4',
      workspaceDir,
      signal: controller.signal
    })
    controller.abort()
    const result = await promise
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('timeout')
      expect(result.error.outcomeUnknown).toBe(true)
    }
    expect(readdirSync(workspaceDir).some((f) => f.includes('.part.'))).toBe(false)
  })

  it('treats a fetch failure as a network error (outcome unknown) and never retries', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    const result = await makeDownloader().downloadArtifact({ serverPath: 'final/movie.mp4', workspaceDir })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('network')
      expect(result.error.outcomeUnknown).toBe(true)
    }
  })
})

describe('security: no token leakage', () => {
  it('never logs the service token', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await makeDownloader().downloadArtifact({ serverPath: 'final/movie.mp4', workspaceDir })
    const logged = JSON.stringify([
      mockMainLoggerService.warn.mock.calls,
      mockMainLoggerService.error.mock.calls,
      mockMainLoggerService.info.mock.calls
    ])
    expect(logged).not.toContain(TOKEN)
  })
})
