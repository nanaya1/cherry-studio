import { net } from 'electron'
import type * as z from 'zod'

import { loggerService } from '@logger'
import type {
  RemoteReadRequestSchema,
  RemoteSearchRequestSchema,
  RemoteWireChunk
} from '@shared/data/types/remoteKnowledge'
import { RemoteWireChunkSchema, RemoteWireErrorSchema } from '@shared/data/types/remoteKnowledge'

const logger = loggerService.withContext('RemoteKnowledgeClient')

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Config handed to the client. The shape mirrors the fields produced by
 * `RemoteKnowledgeService.resolveClientConfig` (task 5); `id` is the service id
 * used only for logging, the rest drive the HTTP calls.
 */
export interface RemoteKnowledgeClientConfig {
  id: string
  name?: string
  baseUrl: string
  authType: 'bearer' | 'api_key' | 'oauth2'
  apiKey?: string
  hasApiKey?: boolean
  headers?: Record<string, string>
  timeoutMs?: number
  enabled?: boolean
}

/** Fields returned by {@link RemoteKnowledgeClient.read}. */
export interface RemoteReadResult {
  document_id: string
  title: string
  content: string
  total_chars?: number
  truncated?: boolean
}

/** HTTP client for one configured external knowledge service (Electron main). */
export class RemoteKnowledgeClient {
  private readonly serviceId: string
  private readonly baseUrl: string
  private readonly authType: RemoteKnowledgeClientConfig['authType']
  private readonly apiKey?: string
  private readonly headers?: Record<string, string>
  private readonly timeoutMs: number

  constructor(config: RemoteKnowledgeClientConfig) {
    this.serviceId = config.id
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.authType = config.authType
    this.apiKey = config.apiKey
    this.headers = config.headers
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** GET /v1/health — resolves on 200, rejects on any failure. */
  async health(): Promise<void> {
    await this.request('/v1/health', { method: 'GET' })
  }

  /** GET /v1/knowledge/bases — returns the service's retrievable bases. */
  async listBases(): Promise<Array<{ id: string; name: string; description?: string; documentCount?: number }>> {
    const body = (await this.request('/v1/knowledge/bases', { method: 'GET' })) as { bases?: unknown } | undefined
    const bases = Array.isArray(body?.bases) ? body.bases : []
    return bases
      .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object' && !Array.isArray(b))
      .map((b) => ({
        id: String(b.id),
        name: String(b.name),
        ...(typeof b.description === 'string' ? { description: b.description } : {}),
        ...(Number.isSafeInteger(b.document_count) && Number(b.document_count) >= 0
          ? { documentCount: Number(b.document_count) }
          : {})
      }))
  }

  /**
   * POST /v1/knowledge/search — returns the parsed chunk array, already
   * truncated to `top_k` (default 8) and score-clamped to [0, 1]. Individual
   * malformed chunks are skipped (logged), not fatal to the batch.
   */
  async search(req: z.infer<typeof RemoteSearchRequestSchema>): Promise<RemoteWireChunk[]> {
    const body = (await this.request('/v1/knowledge/search', {
      method: 'POST',
      body: JSON.stringify(req),
      headers: { 'Content-Type': 'application/json' }
    })) as { chunks?: unknown } | undefined

    const raw = Array.isArray(body?.chunks) ? body.chunks : []
    const prepared = raw
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && !Array.isArray(c))
      .map((c) => ({ ...c, score: clampScore(c.score) }))

    const topK = req.top_k ?? 8
    const result: RemoteWireChunk[] = []
    for (const item of prepared.slice(0, topK)) {
      const parsed = RemoteWireChunkSchema.safeParse(item)
      if (parsed.success) {
        result.push(parsed.data)
      } else {
        logger.warn(`[${this.serviceId}] dropping invalid remote chunk: ${parsed.error.message}`)
      }
    }
    return result
  }

  /** POST /v1/knowledge/read — returns the document/expanded context. */
  async read(req: z.infer<typeof RemoteReadRequestSchema>): Promise<RemoteReadResult> {
    const body = (await this.request('/v1/knowledge/read', {
      method: 'POST',
      body: JSON.stringify(req),
      headers: { 'Content-Type': 'application/json' }
    })) as Record<string, unknown>
    return {
      document_id: String(body.document_id),
      title: String(body.title),
      content: String(body.content),
      ...(typeof body.total_chars === 'number' ? { total_chars: body.total_chars } : {}),
      ...(typeof body.truncated === 'boolean' ? { truncated: body.truncated } : {})
    }
  }

  /** Core request: builds the URL + auth headers, enforces a timeout, and
   *  turns HTTP/network failures into readable errors. Returns the parsed JSON
   *  body on a 2xx response. */
  private async request(
    path: string,
    init: { method?: string; body?: string; headers?: Record<string, string> }
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`
    const headers: Record<string, string> = { ...this.headers, ...init.headers }
    if (this.authType === 'bearer' && this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`
    } else if (this.authType === 'api_key' && this.apiKey) {
      headers['X-API-Key'] = this.apiKey
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('request_timeout')), this.timeoutMs)

    let response: Response
    try {
      response = await net.fetch(url, {
        method: init.method ?? 'GET',
        headers,
        body: init.body,
        signal: controller.signal
      })
    } catch (err) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason instanceof Error ? controller.signal.reason.message : 'timed out'
        throw new Error(`request_timeout: ${reason}`)
      }
      throw new Error(`network_error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      const data = await response.json().catch(() => undefined)
      const parsed = RemoteWireErrorSchema.safeParse(data)
      if (parsed.success) {
        throw new Error(`${parsed.data.error.code}: ${parsed.data.error.message}`)
      }
      throw new Error(`upstream_error: HTTP ${response.status}`)
    }

    return response.json().catch(() => {
      throw new Error('upstream_error: invalid JSON response')
    })
  }
}

function clampScore(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0
  return Math.min(1, Math.max(0, value))
}
