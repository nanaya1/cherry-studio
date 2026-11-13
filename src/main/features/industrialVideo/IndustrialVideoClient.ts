import { randomUUID } from 'node:crypto'

import { net } from 'electron'
import type * as z from 'zod'

import { loggerService } from '@logger'
import {
  industrialVideoReviewDocumentsSchema,
  industrialVideoReviewReceiptSchema,
  industrialVideoReviewSourcesSchema
} from '@shared/ipc/schemas/industrialVideo'

const logger = loggerService.withContext('industrial-video-client')

export type IndustrialVideoOperation =
  | 'review_snapshot_get'
  | 'review_confirm'
  | 'run_create'
  | 'video_start'
  | 'planning_context_get'
  | 'storyboard_submit'
  | 'storyboard_get'
  | 'job_get'
  | 'job_list'
  | 'job_cancel'
  | 'scene_retry'
  | 'qa_get'
  | 'preview_create'
  | 'artifact_read'
  | 'media_upload'
  | 'logo_upload'
  | 'upload'
  | 'capabilities_get'
  | 'workbench_open'
  | 'workbench_get'

export interface IndustrialVideoClientConfig {
  /** Base service URL, e.g. http://127.0.0.1:8848. Never read from renderer config. */
  baseUrl: string
  /** Service Bearer token (MCP_AUTH_TOKEN). Never logged. */
  token: string
  /** Per-request timeout in ms; covers connection, headers, and the full response body read. */
  timeoutMs: number
}

export type IndustrialVideoErrorCategory = 'network' | 'timeout' | 'http' | 'validation' | 'unknown'

export interface IndustrialVideoError {
  category: IndustrialVideoErrorCategory
  operation: IndustrialVideoOperation
  /** Stable id for this request; correlate with host persistence before retrying. */
  requestId: string
  message: string
  status?: number
  /** Server error code when present (NativeError.error). */
  code?: string
  /**
   * True when the server may have received and acted on the request but we cannot tell:
   * network failure or timeout. Callers MUST NOT auto-retry; query job_list/run_list instead.
   */
  outcomeUnknown: boolean
}

export type IndustrialVideoResult<T> =
  | { ok: true; requestId: string; data: T }
  | { ok: false; requestId: string; error: IndustrialVideoError }

export type VideoApiRecord = Record<string, unknown>

export type IndustrialVideoReviewType = 'sources' | 'script_and_storyboard'
export interface ReviewSnapshotParams {
  run: string
  host_assertion: string
  review_type?: IndustrialVideoReviewType
}
export interface ReviewConfirmParams extends ReviewSnapshotParams {
  expected_review_version: string
}
export type ReviewReceipt = z.infer<typeof industrialVideoReviewReceiptSchema>
export type ReviewSnapshot =
  | z.infer<typeof industrialVideoReviewDocumentsSchema>
  | z.infer<typeof industrialVideoReviewSourcesSchema>

export interface RunCreateParams {
  base_name: string
  prefix?: string | null
}
export interface RunCreateResult {
  run: string
  raw: VideoApiRecord
}

export interface VideoStartTextItem {
  text: string
  title?: string
  [key: string]: unknown
}
export interface VideoStartMediaItem {
  name: string
  caption: string
  [key: string]: unknown
}
export interface VideoStartLogoItem {
  name: string
  brand_kind?: 'company' | 'product'
  [key: string]: unknown
}
export interface VideoStartParams {
  run?: string | null
  texts?: string | VideoStartTextItem[] | null
  media?: string | VideoStartMediaItem[] | null
  logo?: string | VideoStartLogoItem | null
  stage?: 'parse' | 'plan' | 'video' | 'assemble' | 'all'
  scenes?: number | null
  max_scenes?: number | null
  direction?: string | null
  style?: 'training' | 'marketing' | null
  scene_duration?: number | null
  replan?: boolean
  estimate_only?: boolean
  language?: string | null
  /**
   * Voice mapping is supplied verbatim by the caller; this client performs no voice mapping.
   * with_audio is a generation/cache parameter, NOT a dubbing toggle — pass it through as given.
   */
  voice?: string | null
  aspect_ratio?: string | null
  with_audio?: boolean | null
  enable_upscaling?: boolean | null
  narrative_style?: string | null
  stale_regen?: boolean
  /** Planning / audio output settings (COWORK_HTTP_GUIDE §17). snake_case, verbatim. */
  target_duration_s?: number | null
  resolution?: '720P' | '1080P' | null
  tts_enabled?: boolean | null
  subtitle_enabled?: boolean | null
  background_music_enabled?: boolean | null
  /** 工业字幕（§17）：主字幕语言 / 第二字幕语言（服务端固定 8 种）。 */
  subtitle_language?: string | null
  second_subtitle_language?: string | null
  /** 是否生成双语字幕。 */
  bilingual_subtitles?: boolean | null
  /** 旁白跟随字幕语言（服务端约束固定 true）。 */
  narration_follows_subtitles?: boolean | null
  expected_settings_version?: number | null
}
export interface VideoStartResult {
  job_id: string
  /** Effective settings echoed by the server (§17.2). Present on settings-changing submits. */
  effective_settings?: VideoApiRecord
  /** Server receipt flags (§17.2): whether the settings were persisted / changed, etc. */
  settings_persisted?: boolean
  settings_changed?: boolean
  requires_replan?: boolean
  approval_invalidated?: boolean
  raw: VideoApiRecord
}
export interface EstimateParams {
  run: string
  stage?: 'parse' | 'plan' | 'video' | 'assemble' | 'all'
  voice?: string | null
  aspect_ratio?: string | null
  style?: 'training' | 'marketing' | null
  /** Planning / audio output settings (COWORK_HTTP_GUIDE §17). snake_case, verbatim. */
  target_duration_s?: number | null
  resolution?: '720P' | '1080P' | null
  tts_enabled?: boolean | null
  subtitle_enabled?: boolean | null
  background_music_enabled?: boolean | null
  with_audio?: boolean | null
  /** 工业字幕（§17）。 */
  subtitle_language?: string | null
  second_subtitle_language?: string | null
  bilingual_subtitles?: boolean | null
  narration_follows_subtitles?: boolean | null
  expected_settings_version?: number | null
}
/**
 * Pre-check response. Deliberately does NOT include a `job_id`: an estimate is a
 * fee/range check that submits no task and consumes no generation quota, so callers
 * must not require or persist a job from it. (Keep `videoStart` untouched — its old
 * callers still expect a `job_id`.)
 */
export interface EstimateResult {
  estimate: VideoApiRecord
  /** Effective settings echoed by the server for estimate_only (§17.2). */
  effective_settings?: VideoApiRecord
  /** Server receipt flags (§17.2) for estimate_only (settings_persisted is false). */
  settings_persisted?: boolean
  settings_changed?: boolean
  requires_replan?: boolean
  approval_invalidated?: boolean
  raw: VideoApiRecord
}

export interface StoryboardScene {
  id: number
  title: string
  duration?: number
  prompt?: string
  narration?: Array<{ start: number; end: number; text: string }>
  media_refs?: unknown[]
  continuity_reset?: boolean
  [key: string]: unknown
}
export interface StoryboardInput {
  video_title: string
  scenes: StoryboardScene[]
  [key: string]: unknown
}
export interface StoryboardSubmitParams {
  run: string
  storyboard: StoryboardInput
  expected_input_fingerprint: string
  expected_storyboard_sha256: string
  [key: string]: unknown
}
export interface StoryboardSubmitResult {
  submitted: boolean
  review_required: boolean
  raw: VideoApiRecord
}

export interface StoryboardGetParams {
  run: string
  full?: boolean
}

export interface JobGetParams {
  job_id: string
  tail_lines?: number
  wait_s?: number
}
export interface JobListParams {
  limit?: number
}
export interface JobCancelParams {
  job_id: string
}
export interface SceneRetryParams {
  run: string
  scene_id: number
}
export interface QaGetParams {
  run: string
}
export interface PreviewCreateParams {
  run: string
  force?: boolean
}
export interface ArtifactReadParams {
  run: string
  path: string
  max_chars?: number
}
export interface ArtifactReadResult {
  type: string
  content?: string
  download_path?: string
  raw: VideoApiRecord
}
export interface MediaUploadParams {
  caption: string
  url?: string | null
  name?: string | null
  content_base64?: string | null
  kind?: 'image' | 'video' | null
}
export interface MediaUploadResult {
  name: string
  raw: VideoApiRecord
}
export interface LogoUploadParams {
  url?: string | null
  name?: string | null
  content_base64?: string | null
  brand_kind?: 'company' | 'product'
}
export interface LogoUploadResult {
  name: string
  raw: VideoApiRecord
}

/**
 * Raw-bytes material upload to the service root `/upload` (COWORK_HTTP_GUIDE §15.2).
 * The bytes are sent verbatim (NOT base64, NOT under `/api/video/`), so large files
 * avoid the 16 MiB JSON ceiling. The service returns `{ ok, name, size, sha256 }`;
 * we surface only `name` to callers (no token, no server path).
 */
export interface UploadParams {
  name: string
  content: Uint8Array
}
export interface UploadResult {
  name: string
}

function isRecord(value: unknown): value is VideoApiRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class IndustrialVideoClient {
  /** 500 MiB — the hard cap the `/upload` route enforces (COWORK_HTTP_GUIDE §15.2). */
  private static readonly MAX_UPLOAD_BYTES = 524_288_000

  private readonly baseUrl: string
  private readonly token: string
  private readonly timeoutMs: number

  constructor(config: IndustrialVideoClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.token = config.token
    this.timeoutMs = config.timeoutMs
  }

  async reviewSnapshotGet(params: ReviewSnapshotParams): Promise<IndustrialVideoResult<ReviewSnapshot>> {
    const result = await this.call('review_snapshot_get', { ...params })
    return this.refine(result, (data) => {
      const schema =
        params.review_type === 'sources' ? industrialVideoReviewSourcesSchema : industrialVideoReviewDocumentsSchema
      const parsed = schema.safeParse(data)
      return parsed.success
        ? parsed.data
        : this.validationError('review_snapshot_get', result.requestId, '审核快照缺失必要字段或字段类型无效')
    })
  }

  async reviewConfirm(params: ReviewConfirmParams): Promise<IndustrialVideoResult<ReviewReceipt>> {
    const result = await this.call('review_confirm', { ...params })
    return this.refine(result, (data) => {
      const parsed = industrialVideoReviewReceiptSchema.safeParse(data)
      return parsed.success
        ? parsed.data
        : this.validationError('review_confirm', result.requestId, '审核确认回执缺失必要字段或字段类型无效')
    })
  }

  async runCreate(params: RunCreateParams): Promise<IndustrialVideoResult<RunCreateResult>> {
    const result = await this.call('run_create', { ...params })
    return this.refine(result, (data) => {
      const run = typeof data.run === 'string' ? data.run : ''
      if (run.length === 0) {
        return this.validationError('run_create', result.requestId, 'run_create response missing run')
      }
      return { run, raw: data }
    })
  }

  async videoStart(params: VideoStartParams): Promise<IndustrialVideoResult<VideoStartResult>> {
    const result = await this.call('video_start', { ...params })
    return this.refine(result, (data) => {
      const jobId = typeof data.job_id === 'string' ? data.job_id : ''
      if (jobId.length === 0) {
        return this.validationError('video_start', result.requestId, 'video_start response missing job_id')
      }
      return {
        job_id: jobId,
        effective_settings: isRecord(data.effective_settings) ? data.effective_settings : undefined,
        settings_persisted: typeof data.settings_persisted === 'boolean' ? data.settings_persisted : undefined,
        settings_changed: typeof data.settings_changed === 'boolean' ? data.settings_changed : undefined,
        requires_replan: typeof data.requires_replan === 'boolean' ? data.requires_replan : undefined,
        approval_invalidated: typeof data.approval_invalidated === 'boolean' ? data.approval_invalidated : undefined,
        raw: data
      }
    })
  }

  /**
   * Independent pre-check entry point for `estimate_only`. Calls `video_start` with
   * `estimate_only: true` and returns the server's `estimate` object without ever
   * requiring a `job_id`. This is a read-only fee/range probe — it must not be mixed
   * with the task-submitting `videoStart` path so old callers keep expecting a job.
   */
  async estimate(params: EstimateParams): Promise<IndustrialVideoResult<EstimateResult>> {
    const result = await this.call('video_start', { ...params, estimate_only: true })
    return this.refine(result, (data) => ({
      estimate: data,
      effective_settings: isRecord(data.effective_settings) ? data.effective_settings : undefined,
      settings_persisted: typeof data.settings_persisted === 'boolean' ? data.settings_persisted : undefined,
      settings_changed: typeof data.settings_changed === 'boolean' ? data.settings_changed : undefined,
      requires_replan: typeof data.requires_replan === 'boolean' ? data.requires_replan : undefined,
      approval_invalidated: typeof data.approval_invalidated === 'boolean' ? data.approval_invalidated : undefined,
      raw: data
    }))
  }

  async planningContextGet(params: { run: string }): Promise<IndustrialVideoResult<VideoApiRecord>> {
    const result = await this.call('planning_context_get', { ...params })
    return this.refine(result, (data) => data)
  }

  async storyboardSubmit(params: StoryboardSubmitParams): Promise<IndustrialVideoResult<StoryboardSubmitResult>> {
    const result = await this.call('storyboard_submit', { ...params })
    return this.refine(result, (data) => {
      if (typeof data.submitted !== 'boolean' || typeof data.review_required !== 'boolean') {
        return this.validationError('storyboard_submit', result.requestId, 'storyboard_submit response missing flags')
      }
      return { submitted: data.submitted, review_required: data.review_required, raw: data }
    })
  }

  async storyboardGet(params: StoryboardGetParams): Promise<IndustrialVideoResult<VideoApiRecord>> {
    const result = await this.call('storyboard_get', { ...params })
    return this.refine(result, (data) => data)
  }

  async jobGet(params: JobGetParams): Promise<IndustrialVideoResult<VideoApiRecord>> {
    const result = await this.call('job_get', { ...params })
    return this.refine(result, (data) => data)
  }

  async jobList(params: JobListParams = {}): Promise<IndustrialVideoResult<VideoApiRecord>> {
    const result = await this.call('job_list', { ...params })
    return this.refine(result, (data) => data)
  }

  async jobCancel(params: JobCancelParams): Promise<IndustrialVideoResult<VideoApiRecord>> {
    const result = await this.call('job_cancel', { ...params })
    return this.refine(result, (data) => data)
  }

  async sceneRetry(params: SceneRetryParams): Promise<IndustrialVideoResult<VideoApiRecord>> {
    const result = await this.call('scene_retry', { ...params })
    return this.refine(result, (data) => data)
  }

  async qaGet(params: QaGetParams): Promise<IndustrialVideoResult<VideoApiRecord>> {
    const result = await this.call('qa_get', { ...params })
    return this.refine(result, (data) => data)
  }

  async previewCreate(params: PreviewCreateParams): Promise<IndustrialVideoResult<VideoApiRecord>> {
    const result = await this.call('preview_create', { ...params })
    return this.refine(result, (data) => data)
  }

  async artifactRead(params: ArtifactReadParams): Promise<IndustrialVideoResult<ArtifactReadResult>> {
    const result = await this.call('artifact_read', { ...params })
    return this.refine(result, (data) => {
      const type = typeof data.type === 'string' ? data.type : ''
      if (type.length === 0) {
        return this.validationError('artifact_read', result.requestId, 'artifact_read response missing type')
      }
      return {
        type,
        content: typeof data.content === 'string' ? data.content : undefined,
        download_path: typeof data.download_path === 'string' ? data.download_path : undefined,
        raw: data
      }
    })
  }

  async mediaUpload(params: MediaUploadParams): Promise<IndustrialVideoResult<MediaUploadResult>> {
    const result = await this.call('media_upload', { ...params })
    return this.refine(result, (data) => {
      const name = typeof data.name === 'string' ? data.name : ''
      if (name.length === 0) {
        return this.validationError('media_upload', result.requestId, 'media_upload response missing name')
      }
      return { name, raw: data }
    })
  }

  async logoUpload(params: LogoUploadParams): Promise<IndustrialVideoResult<LogoUploadResult>> {
    const result = await this.call('logo_upload', { ...params })
    return this.refine(result, (data) => {
      const name = typeof data.name === 'string' ? data.name : ''
      if (name.length === 0) {
        return this.validationError('logo_upload', result.requestId, 'logo_upload response missing name')
      }
      return { name, raw: data }
    })
  }

  /**
   * Upload raw material bytes to the service root `/upload` (COWORK_HTTP_GUIDE §15.2).
   * Unlike the JSON `media_upload`/`logo_upload` routes, this streams the bytes
   * verbatim with `Content-Type: application/octet-stream` and a `?name=` query
   * param — no base64, no `/api/video/` prefix, no renderer-supplied URL. The token
   * stays in the main process; only `{ name }` is returned. A 500 MiB (524288000
   * byte) cap is enforced locally so we never ship an oversized body that the
   * server would reject with 413.
   */
  async upload(params: UploadParams): Promise<IndustrialVideoResult<UploadResult>> {
    const requestId = randomUUID()
    if (!params.name || params.name.trim().length === 0) {
      return {
        ok: false,
        requestId,
        error: this.validationError('upload', requestId, 'upload requires a non-empty name')
      }
    }
    if (!params.content || !(params.content instanceof Uint8Array)) {
      return {
        ok: false,
        requestId,
        error: this.validationError('upload', requestId, 'upload requires Uint8Array content')
      }
    }
    if (params.content.byteLength > IndustrialVideoClient.MAX_UPLOAD_BYTES) {
      return {
        ok: false,
        requestId,
        error: this.validationError('upload', requestId, 'upload exceeds the 500MiB (524288000 byte) limit')
      }
    }

    // const url = `${this.baseUrl}/upload?name=${encodeURIComponent(params.name)}`
    // MEA:industrial-video 在统一出口保护素材句柄，原文件名仍由调用方用于展示。
    const extension = params.name.match(/\.[A-Za-z0-9]{1,16}$/)?.[0] ?? ''
    const uploadName = /^[A-Za-z0-9._-]{1,120}$/.test(params.name) ? params.name : `media-${randomUUID()}${extension}`
    const url = `${this.baseUrl}/upload?name=${encodeURIComponent(uploadName)}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      let response: Response
      try {
        response = await net.fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/octet-stream'
          },
          body: new Uint8Array(params.content).buffer,
          redirect: 'manual',
          signal: controller.signal
        })
      } catch {
        const timedOut = controller.signal.aborted
        logger.warn(`industrial video upload ${requestId} ${timedOut ? 'timeout' : 'network failure'}`)
        return timedOut ? this.timeoutResult('upload', requestId) : this.networkResult('upload', requestId)
      }

      // Manual redirect: do not follow — following would re-send the Bearer token
      // cross-origin. Surface as an http error without re-issuing the request.
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined)
        return this.httpError('upload', requestId, response.status, {})
      }

      if (!response.ok) {
        const parsed = await this.readBody(response, controller, 'upload', requestId)
        if (this.isErrorResult(parsed)) return parsed
        return this.httpError('upload', requestId, response.status, parsed ?? {})
      }

      const parsed = await this.readBody(response, controller, 'upload', requestId)
      if (this.isErrorResult(parsed)) return parsed
      if (!parsed) {
        return {
          ok: false,
          requestId,
          error: this.validationError('upload', requestId, 'upload response body was not a JSON object')
        }
      }
      const name = typeof parsed.name === 'string' ? parsed.name : ''
      if (name.length === 0) {
        return {
          ok: false,
          requestId,
          error: this.validationError('upload', requestId, 'upload response missing name')
        }
      }
      return { ok: true, requestId, data: { name } }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Empty-args operation used for connectivity checks. */
  async capabilitiesGet(): Promise<IndustrialVideoResult<VideoApiRecord>> {
    const result = await this.call('capabilities_get', {})
    return this.refine(result, (data) => data)
  }

  /**
   * 打开服务端工作台（只读）。返回可信工作台链接；真实响应字段名可能与契约不同，
   * 这里统一把 workbench_url / url / workbenchUrl 任一归一为 workbenchUrl。
   */
  async workbenchOpen(params: { run: string; embed?: boolean }): Promise<IndustrialVideoResult<{ workbenchUrl: string; raw: VideoApiRecord }>> {
    const body: Record<string, unknown> = { run: params.run }
    if (params.embed !== undefined) body.embed = params.embed
    const result = await this.call('workbench_open', body)
    return this.refine(result, (data) => {
      const url =
        typeof data.workbench_url === 'string'
          ? data.workbench_url
          : typeof data.url === 'string'
            ? data.url
            : typeof data.workbenchUrl === 'string'
              ? data.workbenchUrl
              : ''
      if (url.length === 0) {
        return this.validationError('workbench_open', result.requestId, 'workbench_open response missing workbench url')
      }
      return { workbenchUrl: url, raw: data }
    })
  }

  /** 读取服务端工作台最新状态（只读），返回松散的 BusinessObject；归一与判定交由 service 层处理。 */
  async workbenchGet(params: { run: string }): Promise<IndustrialVideoResult<VideoApiRecord>> {
    const result = await this.call('workbench_get', { run: params.run })
    return this.refine(result, (data) => data)
  }

  private async call(
    operation: IndustrialVideoOperation,
    body: Record<string, unknown>
  ): Promise<IndustrialVideoResult<VideoApiRecord>> {
    const requestId = randomUUID()
    const url = `${this.baseUrl}/api/video/${operation}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      let response: Response
      try {
        response = await net.fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body),
          redirect: 'manual',
          signal: controller.signal
        })
      } catch {
        // Network failure or abort (timeout). The request may already have been
        // accepted server-side, so the outcome is unknown — never auto-retry.
        const timedOut = controller.signal.aborted
        logger.warn(`industrial video ${operation} ${requestId} ${timedOut ? 'timeout' : 'network failure'}`)
        return timedOut ? this.timeoutResult(operation, requestId) : this.networkResult(operation, requestId)
      }

      // Manual redirect: do not follow. Following would re-send the Bearer token
      // cross-origin. Surface as an http error without re-issuing the request.
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined)
        return this.httpError(operation, requestId, response.status, {})
      }

      if (!response.ok) {
        const parsed = await this.readBody(response, controller, operation, requestId)
        if (this.isErrorResult(parsed)) return parsed
        return this.httpError(operation, requestId, response.status, parsed ?? {})
      }

      const parsed = await this.readBody(response, controller, operation, requestId)
      if (this.isErrorResult(parsed)) return parsed
      if (!parsed) {
        return {
          ok: false,
          requestId,
          error: this.validationError(operation, requestId, `${operation} response body was not a JSON object`)
        }
      }
      return { ok: true, requestId, data: parsed }
    } finally {
      clearTimeout(timer)
    }
  }

  private isErrorResult(value: unknown): value is { ok: false; requestId: string; error: IndustrialVideoError } {
    return typeof value === 'object' && value !== null && 'ok' in value && (value as { ok?: unknown }).ok === false
  }

  /**
   * Reads and validates the JSON body. If the transfer is cut short by our abort
   * (timeout), returns a timeout result (outcomeUnknown) instead of a clean error —
   * the server may already have acted, so the caller must not treat it as failed.
   */
  private async readBody(
    response: Response,
    controller: AbortController,
    operation: IndustrialVideoOperation,
    requestId: string
  ): Promise<VideoApiRecord | undefined | Extract<IndustrialVideoResult<never>, { ok: false }>> {
    try {
      const value = await response.json()
      return isRecord(value) ? value : undefined
    } catch {
      if (controller.signal.aborted) return this.timeoutResult(operation, requestId)
      return undefined
    }
  }

  private timeoutResult(
    operation: IndustrialVideoOperation,
    requestId: string
  ): Extract<IndustrialVideoResult<never>, { ok: false }> {
    return {
      ok: false,
      requestId,
      error: {
        category: 'timeout',
        operation,
        requestId,
        message: 'Request timed out before completion',
        outcomeUnknown: true
      }
    }
  }

  private networkResult(
    operation: IndustrialVideoOperation,
    requestId: string
  ): Extract<IndustrialVideoResult<never>, { ok: false }> {
    return {
      ok: false,
      requestId,
      error: { category: 'network', operation, requestId, message: 'Network request failed', outcomeUnknown: true }
    }
  }

  private httpError(
    operation: IndustrialVideoOperation,
    requestId: string,
    status: number,
    body: VideoApiRecord
  ): Extract<IndustrialVideoResult<never>, { ok: false }> {
    const code = typeof body.error === 'string' ? body.error : undefined
    const message =
      typeof body.message === 'string'
        ? body.message
        : typeof body.hint === 'string'
          ? body.hint
          : typeof body.error === 'string'
            ? body.error
            : `HTTP ${status}`
    return {
      ok: false,
      requestId,
      error: { category: 'http', operation, requestId, message, status, code, outcomeUnknown: false }
    }
  }

  private validationError(
    operation: IndustrialVideoOperation,
    requestId: string,
    message: string
  ): IndustrialVideoError {
    return { category: 'validation', operation, requestId, message, outcomeUnknown: false }
  }

  private refine<T>(
    result: IndustrialVideoResult<VideoApiRecord>,
    build: (data: VideoApiRecord) => T | IndustrialVideoError
  ): IndustrialVideoResult<T> {
    if (!result.ok) return result
    const out = build(result.data)
    if (out && typeof out === 'object' && 'category' in out) {
      return { ok: false, requestId: result.requestId, error: out }
    }
    return { ok: true, requestId: result.requestId, data: out }
  }
}
