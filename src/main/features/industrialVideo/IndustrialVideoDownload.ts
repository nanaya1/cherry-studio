import { randomUUID } from 'node:crypto'
import { createWriteStream, type WriteStream } from 'node:fs'
import { link, mkdir, open, stat, unlink } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

import { net } from 'electron'

import { loggerService } from '@logger'

const logger = loggerService.withContext('industrial-video-download')

/**
 * Trusted main-process artifact downloader for the Cowork (industrial-video) service.
 *
 * Contract (see COWORK_HTTP_GUIDE 16.6 and the /download OpenAPI entry):
 *  - GET /download?path=<url-encoded artifact path> with a Bearer token. The
 *    base URL + token are constructed from a TRUSTED main-process config only --
 *    never a renderer-controlled value, never a default to a local service.
 *  - redirect: 'manual': a 3xx is rejected outright so the Bearer token is never
 *    re-sent cross-origin.
 *  - The workspace directory is supplied by the caller (already verified to belong
 *    to the session). The artifact file name is derived from the server artifact
 *    path and hardened against traversal and Windows separators.
 *  - Stream into an exclusively created temporary file. Only after size verification,
 *    publish via an atomic hard link that cannot overwrite an existing destination.
 *
 * The token is never logged and the credentials/URL are never persisted.
 */

export interface IndustrialVideoDownloadConfig {
  /** Trusted service base URL, e.g. http://127.0.0.1:8848. Never from renderer. */
  baseUrl: string
  /** Service Bearer token. Never logged, never persisted. */
  token: string
  /** Per-request timeout in ms covering connection, headers, and the full body. */
  timeoutMs: number
}

export type IndustrialVideoDownloadErrorCode =
  | 'network'
  | 'timeout'
  | 'http'
  | 'redirect'
  | 'validation'
  | 'size_mismatch'
  | 'no_reliable_size'
  | 'filename_unsafe'
  | 'partial'
  | 'io'

export interface IndustrialVideoDownloadError {
  category: 'download'
  code: IndustrialVideoDownloadErrorCode
  message: string
  /** HTTP status when available. */
  status?: number
  /**
   * True when the server may have acted but we cannot tell (network failure,
   * timeout, or a 5xx). Callers MUST NOT auto-retry; reconcile via job_get instead.
   */
  outcomeUnknown: boolean
  requestId: string
}

export interface IndustrialVideoDownloadSuccess {
  ok: true
  requestId: string
  /** Absolute path of the published file (a NEW file, never an overwritten one). */
  filePath: string
  /** Number of bytes written and verified. */
  size: number
  status: number
}

export type IndustrialVideoDownloadResult =
  | IndustrialVideoDownloadSuccess
  | { ok: false; requestId: string; error: IndustrialVideoDownloadError }

export interface DownloadArtifactInput {
  /** Server artifact path returned by job_get/run_list/artifact_read (e.g. final/xxx.mp4). */
  serverPath: string
  /** Caller-verified workspace directory; the file is published inside it. */
  workspaceDir: string
  /** Optional expected total size (from artifact_read) used to cross-check Content-Length. */
  expectedSize?: number
  /** Optional explicit file name override; still hardened for safety. */
  fileName?: string
  /** Optional external cancellation signal; aborting it cancels the download. */
  signal?: AbortSignal
}

/** Thrown internally when the download is aborted mid-transfer. */
class AbortDownloadError extends Error {
  constructor(message = 'download aborted') {
    super(message)
    this.name = 'AbortDownloadError'
  }
}

const SIZE_MISMATCH = 'size_mismatch'
const NO_RELIABLE_SIZE = 'no_reliable_size'

/**
 * Derive a safe base file name from the server artifact path (or an explicit
 * override). Returns null when the name cannot be trusted. Hardens against:
 *  - path separators (both '/' and the Windows '\\'),
 *  - traversal segments ('..', '.'),
 *  - absolute-ish names (drive letters, leading separators),
 *  - null bytes and control characters,
 *  - names that normalize outside the intended directory.
 */
export function deriveSafeFileName(serverPath: string, override?: string): string | null {
  const raw = typeof override === 'string' && override.length > 0 ? override : serverPath
  if (typeof raw !== 'string' || raw.length === 0) return null

  // Take only the last segment, defending both unix and Windows separators.
  const segment = raw.split(/[/\\]/).pop() ?? ''
  const base = segment.trim()
  if (base.length === 0) return null
  if (base === '.' || base === '..') return null
  if (base.includes('/') || base.includes('\\') || base.includes('\u0000')) return null
  if (base.includes('..')) return null
  if (/^[a-zA-Z]:/.test(base)) return null
  // Reject control characters (0x00-0x1F and 0x7F).

  if (/[\u0000-\u001F\u007F]/.test(base)) return null
  // Reject Windows reserved device names (case-insensitive, optional extension) —
  // these are illegal as file names on Windows at any path.
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.[^.]*)?$/i.test(base)) return null
  // Last line of defense: ensure the name does not escape its directory when joined.
  if (normalize(join('.', base)) !== base) return null
  return base
}

/** True when `target` is the same as or nested inside `dir` (after normalization). */
export function isWithinDir(dir: string, target: string): boolean {
  const base = normalize(dir)
  const candidate = normalize(target)
  return candidate === base || candidate.startsWith(base + '/') || candidate.startsWith(base + '\\')
}

export class IndustrialVideoDownloader {
  private readonly baseUrl: string
  private readonly token: string
  private readonly timeoutMs: number

  constructor(config: IndustrialVideoDownloadConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.token = config.token
    this.timeoutMs = config.timeoutMs
  }

  async downloadArtifact(input: DownloadArtifactInput): Promise<IndustrialVideoDownloadResult> {
    const requestId = randomUUID()

    // 1. Validate the target file name before any network use (fast, safe fail).
    const fileName = deriveSafeFileName(input.serverPath, input.fileName)
    if (!fileName) {
      return this.fail(requestId, 'filename_unsafe', 'Artifact path yields no safe file name', false)
    }

    const workspaceDir = input.workspaceDir
    const finalPath = join(workspaceDir, fileName)
    if (!isWithinDir(workspaceDir, finalPath)) {
      return this.fail(requestId, 'filename_unsafe', 'Resolved path escapes the workspace directory', false)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const external = input.signal
    const onExternalAbort = () => controller.abort()
    if (external) {
      if (external.aborted) controller.abort()
      else external.addEventListener('abort', onExternalAbort, { once: true })
    }

    let target: OpenTarget | null = null

    try {
      // Ensure the (caller-verified) workspace directory exists.
      await mkdir(workspaceDir, { recursive: true })

      const url = `${this.baseUrl}/download?path=${encodeURIComponent(input.serverPath)}`
      let response: Response
      try {
        response = await net.fetch(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.token}` },
          redirect: 'manual',
          signal: controller.signal
        })
      } catch {
        // Network failure or abort (timeout / external). The request may already
        // have been accepted server-side, so the outcome is unknown -- never retry.
        const timedOut = controller.signal.aborted
        if (timedOut) {
          logger.warn(`industrial video download ${requestId} timed out`)
          return this.fail(requestId, 'timeout', 'Download timed out before completion', true)
        }
        logger.warn(`industrial video download ${requestId} network failure`)
        return this.fail(requestId, 'network', 'Network request failed', true)
      }

      // Manual redirect: do not follow. Following would re-send the Bearer token
      // cross-origin. Surface as a distinct error without re-issuing the request.
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined)
        return this.fail(
          requestId,
          'redirect',
          `Refusing redirect (${response.status}); not re-sending token`,
          false,
          response.status
        )
      }

      // 206 partial content: range/resume is not supported in v1 -- reject.
      if (response.status === 206) {
        await response.body?.cancel().catch(() => undefined)
        return this.fail(requestId, 'partial', 'Server returned 206; range/resume is not supported in v1', false, 206)
      }

      if (!response.ok) {
        const unknown = response.status >= 500
        await response.body?.cancel().catch(() => undefined)
        return this.fail(requestId, 'http', `HTTP ${response.status}`, unknown, response.status)
      }

      // 200 path: establish a reliable total size before streaming.
      const sizeDecision = resolveReliableSize(input.expectedSize, response.headers.get('content-length'))
      if (sizeDecision.kind === SIZE_MISMATCH) {
        await response.body?.cancel().catch(() => undefined)
        return this.fail(
          requestId,
          'size_mismatch',
          `expectedSize ${input.expectedSize} disagrees with Content-Length ${response.headers.get('content-length')}`,
          false
        )
      }
      if (sizeDecision.kind === NO_RELIABLE_SIZE) {
        // No trusted total size: do not stream or publish the artifact at all.
        await response.body?.cancel().catch(() => undefined)
        return this.fail(requestId, 'no_reliable_size', 'No reliable total size available; refusing to publish', false)
      }
      const reliableSize = sizeDecision.size

      // Keep incomplete bytes invisible to consumers of the final artifact name.
      try {
        target = await openTarget(`${finalPath}.part.${randomUUID()}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'failed to open output file'
        logger.error(`industrial video download ${requestId} open error: ${message}`)
        return this.fail(requestId, 'io', message, false)
      }

      // 3. Stream the body into the target (no whole-video buffering).
      let written = 0
      try {
        written = await streamToStream(response, target.stream, controller.signal)
      } catch (error) {
        await safeClose(target.stream)
        await safeUnlink(target.targetPath)
        if (error instanceof AbortDownloadError || controller.signal.aborted) {
          logger.warn(`industrial video download ${requestId} aborted during transfer`)
          return this.fail(requestId, 'timeout', 'Download aborted during transfer', true)
        }
        const message = error instanceof Error ? error.message : 'failed to write artifact'
        logger.error(`industrial video download ${requestId} write error: ${message}`)
        return this.fail(requestId, 'io', message, false)
      }

      // 4. Verify the byte count matches the trusted size before declaring success.
      //    On mismatch the (newly created) target is removed; any pre-existing file
      //    is untouched.
      if (written !== reliableSize) {
        await safeClose(target.stream)
        await safeUnlink(target.targetPath)
        return this.fail(requestId, 'size_mismatch', `Wrote ${written} bytes, expected ${reliableSize}`, false)
      }

      await finishWrite(target.stream)
      await safeClose(target.stream)
      let publishPath = finalPath
      try {
        await stat(finalPath)
        // publishPath = `${finalPath}.${randomUUID()}`
        publishPath = `${finalPath.slice(0, finalPath.length - extname(finalPath).length)}.${randomUUID()}${extname(finalPath)}`
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      try {
        await link(target.targetPath, publishPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        // publishPath = `${finalPath}.${randomUUID()}`
        publishPath = `${finalPath.slice(0, finalPath.length - extname(finalPath).length)}.${randomUUID()}${extname(finalPath)}`
        await link(target.targetPath, publishPath)
      }
      await safeUnlink(target.targetPath)
      logger.info(`industrial video download ${requestId} published (${written} bytes)`)
      return { ok: true, requestId, filePath: publishPath, size: written, status: 200 }
    } catch (error) {
      logger.warn(`industrial video download publish failed: ${(error as NodeJS.ErrnoException).code ?? 'io'}`)
      if (target) {
        await safeClose(target.stream)
        await safeUnlink(target.targetPath)
      }
      return this.fail(requestId, 'io', 'Could not publish verified artifact', false)
    } finally {
      clearTimeout(timer)
      if (external) external.removeEventListener('abort', onExternalAbort)
    }
  }

  private fail(
    requestId: string,
    code: IndustrialVideoDownloadErrorCode,
    message: string,
    outcomeUnknown: boolean,
    status?: number
  ): IndustrialVideoDownloadResult {
    return {
      ok: false,
      requestId,
      error: { category: 'download', requestId, code, message, status, outcomeUnknown }
    }
  }
}

interface SizeDecision {
  kind: 'ok' | typeof SIZE_MISMATCH | typeof NO_RELIABLE_SIZE
  size?: number
}

function resolveReliableSize(expectedSize: number | undefined, contentLength: string | null): SizeDecision {
  const cl = parseSize(contentLength)
  if (typeof expectedSize === 'number' && Number.isFinite(expectedSize) && expectedSize >= 0) {
    if (cl !== null && cl !== expectedSize) return { kind: SIZE_MISMATCH }
    return { kind: 'ok', size: expectedSize }
  }
  if (cl !== null) return { kind: 'ok', size: cl }
  return { kind: NO_RELIABLE_SIZE }
}

function parseSize(header: string | null): number | null {
  if (header == null) return null
  const trimmed = header.trim()
  // Strict: exactly one non-negative decimal integer, no sign, no trailing junk
  // (parseInt('100abc') would otherwise accept 100). Empty/multi-value → null.
  if (!/^\d+$/.test(trimmed)) return null
  const n = Number(trimmed)
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

interface OpenTarget {
  targetPath: string
  stream: WriteStream
}

/**
 * Atomically reserve the publish target in the same directory as `finalPath`.
 *  - Primary: `open(finalPath, 'wx')` (O_CREAT | O_EXCL). The kernel either creates
 *    the file or fails with EEXIST in a single atomic step — there is no
 *    stat-then-act window, so a concurrently-created target can never be silently
 *    overwritten (the old stat + rename had a TOCTOU here).
 *  - On EEXIST: the existing `finalPath` is left untouched (never overwritten); we
 *    instead stream into a freshly-named unique file in the same directory.
 * Throws for any other IO error — the caller releases the (uncreated) target.
 */
async function openTarget(finalPath: string): Promise<OpenTarget> {
  try {
    const fd = await open(finalPath, 'wx')
    return { targetPath: finalPath, stream: createWriteStream('', { fd }) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const unique = `${finalPath}.${randomUUID()}`
      const fd = await open(unique, 'wx')
      return { targetPath: unique, stream: createWriteStream('', { fd }) }
    }
    throw error
  }
}

async function safeUnlink(path: string): Promise<void> {
  await unlink(path).catch(() => undefined)
}

/** Close a write stream, swallowing any error (the file is unlinked separately). */
function safeClose(stream: WriteStream): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      stream.close(() => resolve())
    } catch {
      resolve()
    }
  })
}

function writeChunk(stream: WriteStream, chunk: Uint8Array): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()))
  })
}

function finishWrite(stream: WriteStream): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    stream.end((error) => (error ? reject(error) : resolve()))
  })
}

/**
 * Stream a response body into `stream` chunk-by-chunk, counting bytes, without
 * buffering the whole payload. Aborts cleanly (releasing the stream and the file)
 * when `signal` fires.
 */
async function streamToStream(response: Response, fileStream: WriteStream, signal: AbortSignal): Promise<number> {
  let aborted = false
  let streamError: Error | null = null

  // Always observe stream errors so a late open/write failure (e.g. after an abort
  // has already torn the stream down) never surfaces as an unhandled rejection.
  const onStreamError = (error: Error) => {
    if (!aborted) streamError = error
  }
  fileStream.on('error', onStreamError)

  const reader = response.body?.getReader()
  const onAbort = () => {
    aborted = true
    fileStream.destroy()
    void reader?.cancel().catch(() => undefined)
  }
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })

  try {
    if (!reader) {
      if (streamError) throw streamError
      return 0
    }
    let total = 0
    while (true) {
      if (aborted) throw new AbortDownloadError()
      const { done, value } = await reader.read()
      if (aborted) throw new AbortDownloadError()
      if (done) break
      if (value && value.byteLength > 0) {
        total += value.byteLength
        await writeChunk(fileStream, value)
      }
    }
    if (streamError) throw streamError
    return total
  } finally {
    signal.removeEventListener('abort', onAbort)
    await reader?.cancel().catch(() => undefined)
    reader?.releaseLock()
    // Keep the stream error listener attached for the stream's lifetime: a pending
    // async open can fail only after this function has returned (e.g. the workspace
    // was removed), and an unobserved 'error' event would otherwise crash the process.
  }
}
