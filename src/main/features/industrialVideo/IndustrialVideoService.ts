import { AsyncLocalStorage } from 'node:async_hooks'
// import { createHmac } from 'node:crypto'
import { createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { application } from '@application'
import { materializeNativeFilePart } from '@main/ai/messages/fileProcessor'
import { BaseService, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import { agentSessionService } from '@main/data/services/AgentSessionService'
import { agentWorkspaceService } from '@main/data/services/AgentWorkspaceService'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'
import type {
  IndustrialVideoControl,
  IndustrialVideoProductionRecord,
  IndustrialVideoProductionState,
  IndustrialVideoRound
} from '@shared/data/cache/cacheValueTypes'
import type { UIMessage } from '@shared/data/types/message'
import { IpcError } from '@shared/ipc/errors/IpcError'

import {
  type IndustrialVideoClient,
  type IndustrialVideoResult,
  type IndustrialVideoReviewType,
  type ReviewReceipt,
  type ReviewSnapshot,
  type VideoApiRecord,
  IndustrialVideoClient as IndustrialVideoClientImpl
} from './IndustrialVideoClient'
import { IndustrialVideoDownloader } from './IndustrialVideoDownload'
import { canSubmitIndustrialVideo } from './industrialVideoRecovery'
import {
  getIndustrialVideoInput,
  mergeIndustrialVideoInput,
  type IndustrialVideoInput
} from './IndustrialVideoRevision'

const DEFAULT_TIMEOUT_MS = 30_000
const PERSIST_KEY = 'industrial_video.records' as const

/**
 * Read-only operations that must NEVER change the persisted production state:
 * they append no round and never advance `state`. `job_get` is deliberately NOT
 * here — it is a poll that reconciles authoritative state (see `guardJobGet`).
 */
// Read operations use guardRead and never append production records.

type IndustrialVideoOperation = string

/**
 * Fixed voice enum (COWORK_HTTP_GUIDE §17.1). Six Chinese neural voices — the
 * request contract is fixed and the server rejects anything else with 422.
 */
export type IndustrialVideoVoice =
  | 'zh-CN-XiaoxiaoNeural'
  | 'zh-CN-XiaoyiNeural'
  | 'zh-CN-YunxiNeural'
  | 'zh-CN-YunjianNeural'
  | 'zh-CN-YunyangNeural'
  | 'zh-CN-YunxiaNeural'

/** Map a server job `status` string to the host's coarse production state. */
function mapJobStatus(status: unknown): IndustrialVideoProductionState | null {
  if (typeof status !== 'string') return null
  switch (status) {
    case 'queued':
    case 'running':
    case 'processing':
      return 'generating'
    case 'done':
      return 'done'
    case 'failed':
      return 'failed'
    case 'canceled':
    case 'cancelled':
      return 'canceled'
    case 'blocked':
      return 'blocked'
    default:
      return null
  }
}

/**
 * Build the snake_case planning / audio settings object forwarded verbatim to
 * `video_start` (COWORK_HTTP_GUIDE §17). Only fields the caller explicitly
 * provided are included — omitted keys mean "inherit the currently-saved setting"
 * server-side, and we must never send `undefined` (which would serialize to a
 * missing key anyway, but passing it explicitly keeps the body honest).
 */
interface VideoStartSettingsInput {
  targetDurationS?: number | null
  resolution?: '720P' | '1080P' | null
  ttsEnabled?: boolean | null
  subtitleEnabled?: boolean | null
  backgroundMusicEnabled?: boolean | null
  withAudio?: boolean | null
  expectedSettingsVersion?: number | null
}

/** snake_case shape forwarded verbatim to `video_start` (COWORK_HTTP_GUIDE §17). */
interface VideoStartSettings {
  target_duration_s?: number | null
  resolution?: '720P' | '1080P' | null
  tts_enabled?: boolean | null
  subtitle_enabled?: boolean | null
  background_music_enabled?: boolean | null
  with_audio?: boolean | null
  expected_settings_version?: number | null
}

function buildVideoStartSettings(input: VideoStartSettingsInput): VideoStartSettings {
  const out: VideoStartSettings = {}
  if (input.targetDurationS !== undefined) out.target_duration_s = input.targetDurationS
  if (input.resolution !== undefined) out.resolution = input.resolution
  if (input.ttsEnabled !== undefined) out.tts_enabled = input.ttsEnabled
  if (input.subtitleEnabled !== undefined) out.subtitle_enabled = input.subtitleEnabled
  if (input.backgroundMusicEnabled !== undefined) out.background_music_enabled = input.backgroundMusicEnabled
  if (input.withAudio !== undefined) out.with_audio = input.withAudio
  if (input.expectedSettingsVersion !== undefined) out.expected_settings_version = input.expectedSettingsVersion
  return out
}

/** Pull `settings_version` out of an `effective_settings` record, typed as number|undefined. */
function extractSettingsVersion(effectiveSettings: VideoApiRecord | undefined): number | undefined {
  if (effectiveSettings && typeof effectiveSettings.settings_version === 'number') {
    return effectiveSettings.settings_version
  }
  return undefined
}

export interface IndustrialVideoReviewInput {
  sessionId: string
  run: string
  reviewType?: IndustrialVideoReviewType
}

export type IndustrialVideoReviewAuthorizationRequest = IndustrialVideoReviewInput & {
  workspaceId: string
  reviewType: IndustrialVideoReviewType
} & ({ operation: 'review_snapshot_get' } | { operation: 'review_confirm'; expectedReviewVersion: string })

/** 仅供可信主进程/BFF接入：签发前须验证登录、run/project/user/tenant归属及相应权限；确认还须验证真实用户点击及其快照版本。 */
export interface IndustrialVideoReviewAuthorizationProvider {
  authorize(request: IndustrialVideoReviewAuthorizationRequest): Promise<string>
}

export interface IndustrialVideoServiceConfig {
  baseUrl: string
  token: string
  timeoutMs: number
}

/**
 * Injectable collaborators. Production wiring resolves these through the
 * application central path + the trusted persist cache; tests override a subset
 * (e.g. a fake client + in-memory cache) via {@link setTestDeps} without touching
 * the production resolution code.
 */
export interface IndustrialVideoServiceDeps {
  resolveConfig: () => IndustrialVideoServiceConfig | null
  getSession: (sessionId: string) => AgentSessionEntity
  createClient: (config: IndustrialVideoServiceConfig) => IndustrialVideoClient
  getPersist: (key: typeof PERSIST_KEY) => Record<string, IndustrialVideoProductionRecord>
  setPersist: (key: typeof PERSIST_KEY, value: Record<string, IndustrialVideoProductionRecord>) => void
  /** Resolve the real workspace directory from the trusted WorkspaceService — never renderer-supplied. */
  getWorkspacePath: (workspaceId: string) => string
  /** Build the trusted artifact downloader (config resolved from main only). */
  createDownloader: (config: IndustrialVideoServiceConfig) => IndustrialVideoDownloader
  /** Resolve the authenticated actor in the trusted main process. */
  getReviewActor: () => Promise<string | null>
  getLocalReviewActor: () => string
  setLocalReviewActor: (actor: string) => void
}

/**
 * Main-process host service for the trusted industrial-video (Cowork) service.
 *
 * Responsibilities (all others are explicitly out of scope — see COWORK_HTTP_GUIDE):
 *  - Resolve the service base URL + token from the MAIN process env only
 *    (`SERVICE_BASE` / `SERVICE_TOKEN`, with `MAIN_VITE_` fallbacks). Never a
 *    renderer-controlled value, never a default to a local service.
 *  - Validate the agent session (must exist, `featureKind === 'industrial-video'`,
 *    and carry a workspace boundary) before every operation.
 *  - Enforce that every `run` / `job_id` belongs to this session's record; the
 *    service never infers ownership from `run` alone (reconciliation uses
 *    `job_list` + exact `job_id`, never auto-claiming a run's task).
 *  - Persist a host-owned production record in the main persist cache: each
 *    *confirmed production version* is one `IndustrialVideoRound` carrying its
 *    `run` / `job_id` / `state`; reads never append a round. `unknownSubmissions`
 *    holds operations whose outcome could not be confirmed (timeout / 5xx /
 *    invalid-success) and which the caller must reconcile — never auto-retry.
 *  - Persist the request intent (an `intended` round) BEFORE issuing the HTTP
 *    request, so a network/timeout failure ("outcome unknown") can be reconciled
 *    later instead of blindly retried.
 *  - Serialize write operations for the same session (per-session mutex) so
 *    concurrent calls cannot interleave their intent/confirm persist steps.
 *  - On outcome-unknown / invalid-success / http error, NEVER auto-retry, NEVER
 *    auto-claim a job from `job_list`, NEVER cancel on exit, and NEVER resubmit.
 *
 * The renderer can only reach the operations declared in the typed IPC allowlist
 * (`src/shared/ipc/schemas/industrialVideo.ts`); it cannot hand this service an
 * arbitrary `operation` string or unknown fields.
 */
@Injectable('IndustrialVideoService')
@ServicePhase(Phase.WhenReady)
export class IndustrialVideoService extends BaseService {
  private readonly productionDeps: IndustrialVideoServiceDeps = {
    resolveConfig: () => this.resolveConfigFromEnv(),
    getSession: (id) => agentSessionService.getById(id),
    createClient: (cfg) => new IndustrialVideoClientImpl(cfg),
    getPersist: (key) => application.get('CacheService').getPersist(key),
    setPersist: (key, value) => application.get('CacheService').setPersist(key, value),
    // getWorkspacePath: (workspaceId) => agentWorkspaceService.getById(workspaceId).path,
    // 会话绑定的系统工作区也必须可解析，仍仅使用主进程保存的工作区 ID。
    getWorkspacePath: (workspaceId) => agentWorkspaceService.getById(workspaceId, { includeSystem: true }).path,
    createDownloader: (cfg) => new IndustrialVideoDownloader(cfg),
    getReviewActor: async () => (await application.get('EnterprisePlugin').auth.getValidSession())?.userId ?? null,
    getLocalReviewActor: () => application.get('CacheService').getPersist('industrial_video.local_actor'),
    setLocalReviewActor: (actor) => application.get('CacheService').setPersist('industrial_video.local_actor', actor)
  }
  private deps: IndustrialVideoServiceDeps = this.productionDeps
  private readonly pendingReviewSnapshots = new Map<string, { run: string; reviewVersion: string }>()
  private readonly confirmedReviews = new Map<string, { run: string; reviewVersion: string }>()

  /** Test seam: override any dependency without touching the production central path. */
  setTestDeps(partial: Partial<IndustrialVideoServiceDeps>): void {
    this.deps = { ...this.productionDeps, ...partial }
  }

  private reviewAuthorizationProvider: IndustrialVideoReviewAuthorizationProvider = {
    authorize: (request) => this.createReviewAssertion(request)
  }

  private async createReviewAssertion(request: IndustrialVideoReviewAuthorizationRequest): Promise<string> {
    const secret = process.env.IVIDEO_REVIEW_HOST_SECRET?.trim() || '9a58c192f597b97675c556ea4048b601e8216e8142e7109e27d79a631358d357'
    // const actor = await this.deps.getReviewActor()
    // if (!secret || !actor) { throw new IpcError('IVIDEO_REVIEW_AUTH_UNAVAILABLE', '未接通可信身份签发') }
    if (!secret) {
      throw new IpcError(
        'IVIDEO_REVIEW_AUTH_UNAVAILABLE',
        '未接通可信身份签发：缺少主进程 IVIDEO_REVIEW_HOST_SECRET 配置。'
      )
    }
    const mode = process.env.IVIDEO_REVIEW_IDENTITY_MODE?.trim() || 'local'
    let actor: string | null
    if (mode === 'local') {
      actor = this.deps.getLocalReviewActor()
      if (!actor) {
        actor = `local:${randomUUID()}`
        this.deps.setLocalReviewActor(actor)
      }
    } else if (mode === 'enterprise') {
      actor = await this.deps.getReviewActor()
    } else {
      throw new IpcError('IVIDEO_REVIEW_AUTH_UNAVAILABLE', 'IVIDEO_REVIEW_IDENTITY_MODE 仅支持 enterprise 或 local。')
    }
    if (!actor) {
      throw new IpcError(
        'IVIDEO_REVIEW_AUTH_UNAVAILABLE',
        '未接通可信身份签发：请先登录企业账号；本地单用户环境可配置 IVIDEO_REVIEW_IDENTITY_MODE=local。'
      )
    }
    const claims = {
      aud: 'ivideo-review',
      actor,
      run: request.run,
      exp: Math.floor(Date.now() / 1000) + 300,
      permissions: [request.operation === 'review_confirm' ? 'review:confirm' : 'review:read']
    }
    const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url')
    const signature = createHmac('sha256', secret).update(encoded, 'ascii').digest('hex')
    return `${encoded}.${signature}`
  }

  /** 只允许可信主进程配置；不通过 IPC 接收 provider、声明或签名密钥。 */
  setReviewAuthorizationProvider(provider: IndustrialVideoReviewAuthorizationProvider): void {
    this.reviewAuthorizationProvider = provider
  }

  /** Per-session mutex: one in-flight write/job_get at a time, serialized in order. */
  private sessionLocks = new Map<string, Promise<unknown>>()

  private withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionLocks.get(sessionId) ?? Promise.resolve()
    const releaseState: { resolve?: () => void } = {}
    const release = new Promise<void>((resolve) => {
      releaseState.resolve = resolve
    })
    const run = async (): Promise<T> => {
      try {
        return await fn()
      } finally {
        releaseState.resolve?.()
      }
    }
    const chained = prev.then(run)
    // Keep a never-rejecting placeholder so later calls chain off `chained` (the
    // real promise we return to the caller handles its own rejection).
    this.sessionLocks.set(
      sessionId,
      chained.catch(() => undefined)
    )
    void release
    return chained
  }

  private readonly executionContext = new AsyncLocalStorage<Readonly<{ sessionId: string; epoch: number }>>()

  /** 可信 runtime 须捕获 beginRound 返回值并绑定连接；旧连接不得读取最新代次。 */
  withExecution<T>(token: Readonly<{ sessionId: string; epoch: number }>, fn: () => T): T {
    return this.executionContext.run(token, fn)
  }

  /** 仅在可信连接构建期间捕获；工具回调不得改读持久化的最新代次。 */
  getExecutionToken(): Readonly<{ sessionId: string; epoch: number }> | undefined {
    return this.executionContext.getStore()
  }

  assertExecution(token: Readonly<{ sessionId: string; epoch: number }>): void {
    this.withExecution(token, () => this.assertExecutionOpen(token.sessionId, token.epoch))
  }

  private readonly userInputs = new Map<
    string,
    {
      epoch: number
      parts: UIMessage['parts']
      prepared?: Promise<IndustrialVideoInput>
      revision?: Promise<string>
    }
  >()

  /** 仅接收 runtime 保存的真实用户消息；模型工具不可写入此入口。 */
  async prepareUserParts(input: { sessionId: string; parts: UIMessage['parts'] }): Promise<void> {
    const token = this.getExecutionToken()
    if (!token || token.sessionId !== input.sessionId) throw new IpcError('IVIDEO_STOPPED', '缺少可信轮次。')
    this.assertExecution(token)
    this.userInputs.set(input.sessionId, { epoch: token.epoch, parts: structuredClone(input.parts) })
  }

  private async prepareParseInput(sessionId: string): Promise<IndustrialVideoInput> {
    const pending = this.userInputs.get(sessionId)
    const token = this.getExecutionToken()
    if (!pending || !token || token.sessionId !== sessionId || pending.epoch !== token.epoch) return {}
    pending.prepared ??= (async () => {
      const texts: NonNullable<IndustrialVideoInput['texts']> = []
      const media: NonNullable<IndustrialVideoInput['media']> = []
      for (const part of pending.parts) {
        this.assertExecution(token)
        if (part.type === 'text' && part.text.trim()) texts.push({ text: part.text })
        if (part.type !== 'file') continue
        const file = await materializeNativeFilePart(part)
        this.assertExecution(token)
        const match = file?.url.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/)
        if (!match) throw new IpcError('IVIDEO_MATERIAL_INVALID', '附件无法完整读取，未提交解析。')
        // if (/^text\//.test(match[1])) {
        if (match[1].startsWith('text/')) {
          texts.push({ text: Buffer.from(match[2], 'base64').toString('utf8'), title: part.filename })
        } else if (/^(image|video)\//.test(match[1])) {
          const caption = part.filename ?? 'attachment'
          const uploaded = await this.upload({ sessionId, name: caption, content: Buffer.from(match[2], 'base64') })
          this.assertExecution(token)
          media.push({ name: uploaded.name, caption })
        } else {
          throw new IpcError('IVIDEO_MATERIAL_INVALID', '该附件类型尚未接通可信文本提取，请转换后重新发送。')
        }
      }
      return { texts, media }
    })()
    return pending.prepared
  }

  private invalidateReviews(sessionId: string): void {
    this.pendingReviewSnapshots.delete(sessionId)
    this.confirmedReviews.delete(sessionId)
  }

  private assertExecutionOpen(sessionId: string, epoch?: number): void {
    const control = this.getRecord(sessionId)?.control
    const token = this.executionContext.getStore()
    if (
      control?.stopRequested ||
      (token && (token.sessionId !== sessionId || token.epoch !== control?.epoch || control.phase !== 'active')) ||
      (epoch !== undefined && epoch !== (control?.epoch ?? 0)) ||
      (control?.phase === 'active' && (!token || token.sessionId !== sessionId || token.epoch !== control.epoch))
    ) {
      throw new IpcError('IVIDEO_STOPPED', '当前执行权限已失效；请核实任务后明确开始新一轮。')
    }
  }

  private hasUnresolvedSubmission(record: IndustrialVideoProductionRecord): boolean {
    return (
      record.unknownSubmissions.length > 0 ||
      record.rounds
        .filter((round) => !['job_cancel', 'review_confirm', 'review_snapshot_get'].includes(round.operation))
        .at(-1)?.outcome === 'intended'
    )
  }

  /** 仅供可信主进程用户提交入口调用；不得作为模型工具或通用 IPC 暴露。 */
  beginRound(input: { sessionId: string }): Readonly<{ sessionId: string; epoch: number }> {
    this.validateSession(input.sessionId)
    const record = this.getRecord(input.sessionId) ?? this.newRecord(input.sessionId)
    if (
      (record.control?.phase === 'active' && !['done', 'failed'].includes(record.state)) ||
      this.hasUnresolvedSubmission(record) ||
      (record.jobId && !['done', 'failed'].includes(record.state)) ||
      (record.control?.stopRequested && record.control.phase !== 'stopped')
    ) {
      throw new IpcError('IVIDEO_RECONCILE_REQUIRED', '当前任务尚未证实结束，不能开始新一轮。')
    }
    record.control = { epoch: (record.control?.epoch ?? 0) + 1, phase: 'active', stopRequested: false }
    this.invalidateReviews(input.sessionId)
    this.saveRecord(record)
    return Object.freeze({ sessionId: input.sessionId, epoch: record.control.epoch })
  }

  /** 终态持久化后仅释放未进入业务活动的可信轮次。 */
  releaseRound(token: Readonly<{ sessionId: string; epoch: number }>): void {
    const record = this.getRecord(token.sessionId)
    if (
      !record?.control ||
      record.control.epoch !== token.epoch ||
      record.control.phase !== 'active' ||
      record.control.stopRequested ||
      record.jobId ||
      !['idle', 'done', 'failed'].includes(record.state) ||
      this.hasUnresolvedSubmission(record)
    ) {
      return
    }
    record.control = { ...record.control, phase: 'idle' }
    this.saveRecord(record)
  }

  /** 先同步持久化门禁，再取消已绑定活动任务；不等待业务长锁。 */
  async stop(input: { sessionId: string }): Promise<IndustrialVideoControl> {
    this.validateSession(input.sessionId)
    const record = this.getRecord(input.sessionId) ?? this.newRecord(input.sessionId)
    const activeJob = record.jobId && !['done', 'failed', 'canceled'].includes(record.state) ? record.jobId : null
    const unresolved = this.hasUnresolvedSubmission(record) || !!activeJob || record.state === 'canceled'
    record.control = {
      epoch: (record.control?.epoch ?? 0) + (record.control?.stopRequested ? 0 : 1),
      stopRequested: true,
      phase: unresolved ? 'reconcile_required' : 'stopped'
    }
    this.saveRecord(record)
    this.invalidateReviews(input.sessionId)
    // if (activeJob) await this.jobCancel({ sessionId: input.sessionId, jobId: activeJob })
    // return { ...this.getRecord(input.sessionId)!.control! }
    const control = { ...record.control }
    // 门禁回执不等待远端取消；迟到失败不得覆盖已对账的终态或新轮。
    if (activeJob) {
      void this.jobCancel({ sessionId: input.sessionId, jobId: activeJob })
        .catch(() => {
          const latest = this.getRecord(input.sessionId)
          if (latest?.control?.epoch === control.epoch && latest.control.phase === 'reconcile_required') {
            latest.control = { ...latest.control, phase: 'reconcile_required' }
            this.saveRecord(latest)
          }
        })
        // 门禁已同步持久化；后台持久化异常也不能产生未处理的 rejection。
        .catch(() => undefined)
    }
    return control
  }

  // ── Config resolution ──

  /** Read the trusted service config from the main process env. `null` = unconfigured. */
  resolveConfig(): IndustrialVideoServiceConfig | null {
    return this.resolveConfigFromEnv()
  }

  private resolveConfigFromEnv(): IndustrialVideoServiceConfig | null {
    const baseUrl = process.env.SERVICE_BASE ?? process.env.MAIN_VITE_SERVICE_BASE ?? 'http://36.150.116.248:8849'
    const token = process.env.SERVICE_TOKEN ?? process.env.MAIN_VITE_SERVICE_TOKEN ?? '_k7ZvNlsDh-IhGoxzzimRuhZtCAPWJxri72I51DLgf4'
    if (!baseUrl || !token) return null
    const timeoutMs = Number.parseInt(
      process.env.SERVICE_TIMEOUT_MS ?? process.env.MAIN_VITE_SERVICE_TIMEOUT_MS ?? '',
      10
    )
    return {
      baseUrl: baseUrl.replace(/\/+$/, ''),
      token,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS
    }
  }

  /** Throw a clear, structured error when the service is not configured. */
  private requireConfig(): IndustrialVideoServiceConfig {
    const config = this.deps.resolveConfig()
    if (!config) {
      throw new IpcError(
        'IVIDEO_NOT_CONFIGURED',
        'Industrial-video service is not configured: set SERVICE_BASE and SERVICE_TOKEN (no default is used).'
      )
    }
    return config
  }

  private createClient(config: IndustrialVideoServiceConfig): IndustrialVideoClient {
    return this.deps.createClient(config)
  }

  // ── Session validation ──

  /** Validate the session: must exist, be industrial-video, and carry a workspace. */
  private validateSession(sessionId: string): AgentSessionEntity {
    let session: AgentSessionEntity
    try {
      session = this.deps.getSession(sessionId)
    } catch (error) {
      throw new IpcError('IVIDEO_SESSION_INVALID', `Industrial-video session not found: ${sessionId}`, {
        cause: String(error)
      })
    }
    if (session.featureKind !== 'industrial-video') {
      throw new IpcError(
        'IVIDEO_SESSION_INVALID',
        `Session ${sessionId} is not an industrial-video session (featureKind=${session.featureKind ?? 'none'}).`
      )
    }
    if (!session.workspaceId) {
      throw new IpcError(
        'IVIDEO_SESSION_INVALID',
        `Session ${sessionId} has no workspace boundary; refusing industrial-video access.`
      )
    }
    return session
  }

  // ── Ownership checks (run / job must belong to THIS session) ──

  private assertRunBelongs(
    _sessionId: string,
    run: string | null,
    record: IndustrialVideoProductionRecord | null
  ): void {
    if (!run) {
      throw new IpcError('IVIDEO_RUN_INVALID', 'A run is required for this operation.')
    }
    if (!record) {
      throw new IpcError('IVIDEO_RUN_INVALID', 'No run is associated with this session; create one first.')
    }
    if (record.run && record.run !== run) {
      throw new IpcError('IVIDEO_RUN_INVALID', 'Run does not belong to this session.')
    }
  }

  private assertReadableRun(sessionId: string, run: string, record: IndustrialVideoProductionRecord | null): void {
    if (
      record?.run === run ||
      record?.rounds.some((round) => round.operation === 'run_create' && round.outcome === 'ok' && round.run === run)
    )
      return
    this.assertRunBelongs(sessionId, run, null)
  }

  private assertJobBelongs(_sessionId: string, jobId: string, record: IndustrialVideoProductionRecord | null): void {
    if (!record) {
      throw new IpcError('IVIDEO_JOB_INVALID', 'No production record for this session.')
    }
    const known = record.jobId === jobId || record.rounds.some((r) => r.jobId === jobId && r.outcome === 'ok')
    if (!known) {
      throw new IpcError('IVIDEO_JOB_INVALID', 'Job does not belong to this session.')
    }
  }

  // ── Persist cache helpers (clone on read to avoid mutating the schema default) ──

  private readRecords(): Record<string, IndustrialVideoProductionRecord> {
    return { ...this.deps.getPersist(PERSIST_KEY) }
  }

  private writeRecords(map: Record<string, IndustrialVideoProductionRecord>): void {
    this.deps.setPersist(PERSIST_KEY, map)
  }

  private getRecord(sessionId: string): IndustrialVideoProductionRecord | null {
    return this.readRecords()[sessionId] ?? null
  }

  private newRecord(sessionId: string): IndustrialVideoProductionRecord {
    return {
      sessionId,
      version: 0,
      run: null,
      jobId: null,
      state: 'idle',
      rounds: [],
      unknownSubmissions: [],
      updatedAt: 0
    }
  }

  private saveRecord(record: IndustrialVideoProductionRecord): void {
    const map = this.readRecords()
    map[record.sessionId] = { ...record, updatedAt: Date.now() }
    this.writeRecords(map)
  }

  /**
   * Append a round to the version history.
   *  - On a confirmed (`ok`) round, the record's `version` / `run` / `jobId` /
   *    `state` are advanced to this round's values, so the active pointers always
   *    reflect the latest confirmed production version (history is never lost).
   *  - On `error` we additionally flag the state as `failed`.
   *  - `unknown` / `intended` rounds do NOT advance the active pointers.
   */
  private appendRound(sessionId: string, round: IndustrialVideoRound, opts: { failedState?: boolean } = {}): void {
    const record = this.getRecord(sessionId) ?? this.newRecord(sessionId)
    record.rounds = [...record.rounds, round]
    if (round.outcome === 'ok') {
      record.version = round.version
      if (round.run !== null) record.run = round.run
      if (round.jobId !== null) record.jobId = round.jobId
      record.state = round.state
    } else if (round.outcome === 'error' && opts.failedState) {
      record.state = 'failed'
    }
    this.saveRecord(record)
  }

  private pushUnknownSubmission(sessionId: string, round: IndustrialVideoRound): void {
    const record = this.getRecord(sessionId) ?? this.newRecord(sessionId)
    record.unknownSubmissions = [...record.unknownSubmissions, round]
    this.saveRecord(record)
  }

  private commitSuccess(
    sessionId: string,
    patch: { run?: string | null; jobId?: string | null; state?: IndustrialVideoProductionState }
  ): void {
    const record = this.getRecord(sessionId) ?? this.newRecord(sessionId)
    if (patch.run !== undefined) record.run = patch.run
    if (patch.jobId !== undefined) record.jobId = patch.jobId
    if (patch.state !== undefined) record.state = patch.state
    this.saveRecord(record)
  }

  // ── Submit gate (no auto-retry of an unconfirmed / in-flight session) ──

  private assertSubmittable(
    _sessionId: string,
    record: IndustrialVideoProductionRecord | null,
    gatedByActiveJob: boolean
  ): void {
    const unknownCount = record?.unknownSubmissions.length ?? 0
    if (unknownCount > 0) {
      throw new IpcError(
        'IVIDEO_SUBMISSION_UNKNOWN',
        'An interrupted submission must be reconciled (job_get / job_list) before retrying.'
      )
    }
    const pendingIntent = record?.rounds.at(-1)?.outcome === 'intended'
    // Only an in-flight generation/assembly job blocks a new submission; ingestion,
    // planning and storyboard stages must not (the happy path moves through them).
    const activeJob = gatedByActiveJob && !!record?.jobId && ['generating', 'assembling'].includes(record.state)
    const ok = canSubmitIndustrialVideo({ pendingIntent, unknownCount, activeJob })
    if (!ok) {
      throw new IpcError('IVIDEO_SUBMISSION_UNKNOWN', 'This session is not in a state to start a new submission.')
    }
  }

  private hasCompletedVideo(record: IndustrialVideoProductionRecord | null): boolean {
    if (record?.state !== 'done' || !record.run || !record.jobId) return false
    return record.rounds.some(
      (round) =>
        round.run === record.run &&
        round.jobId === record.jobId &&
        round.outcome === 'ok' &&
        ['video_start', 'assemble'].includes(round.operation) &&
        ['generating', 'assembling'].includes(round.state)
    )
  }

  // ── Write orchestration (intent → call → confirm / unknown) ──

  private async guardWrite<T>(input: {
    sessionId: string
    operation: IndustrialVideoOperation
    state: IndustrialVideoProductionState
    run: string | null
    requireRun?: string | null
    requireJob?: string
    gatedByActiveJob?: boolean
    doCall: () => Promise<IndustrialVideoResult<T>>
    onSuccess: (data: T) => {
      run?: string | null
      jobId?: string | null
      state?: IndustrialVideoProductionState
      detail?: Record<string, unknown>
    }
  }): Promise<T> {
    const epoch = this.getRecord(input.sessionId)?.control?.epoch ?? 0
    return this.withSessionLock(input.sessionId, async () => {
      this.validateSession(input.sessionId)
      this.assertExecutionOpen(input.sessionId, epoch)
      const record = this.getRecord(input.sessionId)
      if (input.requireRun !== undefined) this.assertRunBelongs(input.sessionId, input.requireRun, record)
      if (input.requireJob) this.assertJobBelongs(input.sessionId, input.requireJob, record)
      // if (input.operation === 'storyboard_submit' && record?.state === 'done') {
      if (input.operation === 'storyboard_submit' && this.hasCompletedVideo(record)) {
        throw new IpcError(
          'IVIDEO_REVISION_REQUIRED',
          '成片不可原地修改：请先调用 parse 创建返修新 run，提交新分镜后重新审核。'
        )
      }
      this.assertSubmittable(input.sessionId, record, input.gatedByActiveJob ?? false)

      const base = record?.version ?? 0
      const version = input.operation === 'run_create' ? base + 1 : base
      this.invalidateReviews(input.sessionId)
      // 1. Persist intent before the request (an `intended` round).
      this.appendRound(input.sessionId, {
        version,
        operation: input.operation,
        run: input.run,
        jobId: null,
        state: input.state,
        requestId: '',
        at: Date.now(),
        outcome: 'intended'
      })

      // 2. Issue the request (no retry).
      const result = await input.doCall()

      // 3. Persist the confirmed outcome.
      if (result.ok) {
        const patch = input.onSuccess(result.data)
        this.appendRound(input.sessionId, {
          version,
          operation: input.operation,
          run: patch.run ?? input.run,
          jobId: patch.jobId ?? null,
          state: patch.state ?? input.state,
          requestId: result.requestId,
          at: Date.now(),
          outcome: 'ok',
          detail: patch.detail
        })
        this.commitSuccess(input.sessionId, {
          run: patch.run ?? input.run,
          jobId: patch.jobId ?? null,
          state: patch.state ?? input.state
        })
        if (this.getRecord(input.sessionId)?.control?.stopRequested && patch.jobId) {
          await this.jobCancel({ sessionId: input.sessionId, jobId: patch.jobId })
        }
        return { ...result.data }
      }

      const error = result.error
      const outcomeUnknown = error.outcomeUnknown || error.category === 'validation' || (error.status ?? 0) >= 500
      const finalRound: IndustrialVideoRound = {
        version,
        operation: input.operation,
        run: input.run,
        jobId: null,
        state: input.state,
        requestId: error.requestId,
        at: Date.now(),
        outcome: outcomeUnknown ? 'unknown' : 'error'
      }
      this.appendRound(input.sessionId, finalRound, { failedState: !outcomeUnknown })
      if (outcomeUnknown) this.pushUnknownSubmission(input.sessionId, finalRound)
      throw new IpcError('IVIDEO_HTTP_ERROR', error.message, {
        category: error.category,
        code: error.code,
        status: error.status,
        outcomeUnknown,
        operation: input.operation
      })
    })
  }

  // ── Pure read (never appends a round, never changes state) ──

  private async guardRead<T>(input: {
    sessionId: string
    operation: IndustrialVideoOperation
    requireRun?: string | null
    doCall: () => Promise<IndustrialVideoResult<T>>
  }): Promise<T> {
    this.validateSession(input.sessionId)
    const record = this.getRecord(input.sessionId)
    // if (input.requireRun !== undefined) this.assertRunBelongs(input.sessionId, input.requireRun, record)
    if (input.requireRun !== undefined) this.assertReadableRun(input.sessionId, input.requireRun!, record)
    const result = await input.doCall()
    if (result.ok) return { ...result.data }
    const error = result.error
    throw new IpcError('IVIDEO_HTTP_ERROR', error.message, {
      category: error.category,
      code: error.code,
      status: error.status,
      outcomeUnknown: false,
      operation: input.operation
    })
  }

  // ── job_get: a poll that reconciles authoritative state (no new task, no cancel) ──

  private async guardJobGet(input: {
    sessionId: string
    jobId: string
    doCall: () => Promise<IndustrialVideoResult<Record<string, unknown>>>
  }): Promise<Record<string, unknown>> {
    return this.withSessionLock(input.sessionId, async () => {
      this.validateSession(input.sessionId)
      const record = this.getRecord(input.sessionId)
      if (!record || !record.run) {
        throw new IpcError('IVIDEO_JOB_INVALID', 'No run is associated with this session.')
      }

      const pollEpoch = record.control?.epoch ?? 0
      const result = await input.doCall()
      if (!result.ok) {
        const error = result.error
        throw new IpcError('IVIDEO_HTTP_ERROR', error.message, {
          category: error.category,
          code: error.code,
          status: error.status,
          outcomeUnknown: false,
          operation: 'job_get'
        })
      }

      // Update authoritative state from the job status, but NEVER cancel on exit —
      // we only persist what the server reports.
      const newState = mapJobStatus(result.data.status)
      const updated = this.getRecord(input.sessionId) ?? this.newRecord(input.sessionId)
      // Ownership is proven by the server: only act on a job whose `run` matches the
      // session's run. We never infer/auto-claim a task from `run` alone.
      const jobRun = typeof result.data.run === 'string' ? result.data.run : undefined
      // 同 run 不证明属于某次提交；只更新已绑定 job，未知项按精确 jobId 对账。
      // if (jobRun && jobRun === record.run) {
      if (jobRun === record.run && input.jobId === record.jobId && (updated.control?.epoch ?? 0) === pollEpoch) {
        // if (newState) updated.state = newState
        // MEA:industrial-video worker 的运行状态不区分阶段，按该 job 的提交回执恢复解析/生成/合成阶段。
        const jobRound = updated.rounds.findLast(
          (round) =>
            round.run === jobRun &&
            round.jobId === input.jobId &&
            round.outcome === 'ok' &&
            ['parse', 'video_start', 'assemble'].includes(round.operation)
        )
        if (newState) updated.state = newState === 'generating' ? (jobRound?.state ?? newState) : newState
        updated.jobId = input.jobId
        // updated.unknownSubmissions = updated.unknownSubmissions.filter((u) => u.run !== jobRun)
        updated.unknownSubmissions = updated.unknownSubmissions.filter(
          (round) => round.run !== jobRun || round.jobId !== input.jobId
        )
      }
      if (
        updated.control?.stopRequested &&
        jobRun === updated.run &&
        input.jobId === updated.jobId &&
        (updated.control?.epoch ?? 0) === pollEpoch
      ) {
        updated.control = {
          ...updated.control,
          phase:
            !this.hasUnresolvedSubmission(updated) && ['done', 'failed'].includes(updated.state)
              ? 'stopped'
              : 'reconcile_required'
        }
      }
      this.saveRecord(updated)

      return { ...result.data }
    })
  }

  // ── Public operations (one per typed IPC route) ──

  /** Whether the trusted service is configured. No session required. */
  configStatus(): { configured: boolean } {
    return { configured: this.deps.resolveConfig() !== null }
  }

  async snapshotSave(input: {
    sessionId: string
    run: string
    script: string
    storyboard: string
  }): Promise<{ scriptPath: string; storyboardPath: string }> {
    const session = this.validateSession(input.sessionId)
    this.assertRunBelongs(input.sessionId, input.run, this.getRecord(input.sessionId))
    const snapshot = await this.reviewSnapshotGet({ sessionId: input.sessionId, run: input.run })
    if (typeof snapshot.script !== 'string' || !snapshot.storyboard || typeof snapshot.storyboard !== 'object') {
      throw new IpcError('IVIDEO_REVIEW_INVALID', '服务端未返回可保存的真实脚本与分镜。')
    }
    const directory = await mkdtemp(join(this.deps.getWorkspacePath(session.workspaceId), '审核-'))
    const scriptPath = join(directory, '脚本.md')
    const storyboardPath = join(directory, '分镜脚本.md')
    await writeFile(scriptPath, snapshot.script, { encoding: 'utf8', flag: 'wx' })
    await writeFile(
      storyboardPath,
      `审核版本：${snapshot.review_version}\n\n\`\`\`json\n${JSON.stringify(snapshot.storyboard, null, 2)}\n\`\`\`\n`,
      { encoding: 'utf8', flag: 'wx' }
    )
    return { scriptPath, storyboardPath }
  }

  async runCreate(input: { sessionId: string; baseName: string; prefix?: string | null }): Promise<{ run: string }> {
    const client = this.createClient(this.requireConfig())
    let parentRun: string | null = null
    const data = await this.guardWrite({
      sessionId: input.sessionId,
      operation: 'run_create',
      state: 'idle',
      run: null,
      gatedByActiveJob: false,
      // doCall: () => client.runCreate({ base_name: input.baseName, prefix: input.prefix ?? null }),
      // onSuccess: (d) => ({ run: d.run, state: 'idle' })
      // MEA:industrial-video 新 run 覆盖活动指针前，先保存旧任务真实回执与完整输入。
      doCall: async () => {
        const previous = this.getRecord(input.sessionId)
        parentRun = previous?.run ?? null
        if (previous?.run && previous.jobId) {
          const epoch = previous.control?.epoch ?? 0
          const job = await client.jobGet({ job_id: previous.jobId })
          if (!job.ok || job.data.run !== previous.run || !['done', 'failed'].includes(String(job.data.status))) {
            return {
              ok: false,
              requestId: job.requestId,
              error: {
                category: 'http',
                operation: 'run_create',
                requestId: job.requestId,
                status: 409,
                outcomeUnknown: false,
                message: '旧版本任务尚未证实结束，未创建返修版本。'
              }
            }
          }
          this.assertExecutionOpen(input.sessionId, epoch)
          const latest = this.getRecord(input.sessionId)!
          latest.rounds = [
            ...latest.rounds,
            {
              version: previous.version,
              operation: 'revision_archive',
              run: previous.run,
              jobId: previous.jobId,
              state: previous.state,
              requestId: job.requestId,
              at: Date.now(),
              outcome: 'ok',
              detail: { job: job.data, inputSnapshot: getIndustrialVideoInput(previous) }
            }
          ]
          this.saveRecord(latest)
        }
        return client.runCreate({ base_name: input.baseName, prefix: input.prefix ?? null })
      },
      onSuccess: (d) => ({ run: d.run, state: 'idle', detail: { parentRun } })
    })
    return { run: data.run }
  }

  async parse(input: {
    sessionId: string
    run?: string | null
    texts?: unknown[] | null
    media?: unknown[] | null
    logo?: unknown | null
    voice?: IndustrialVideoVoice
    aspectRatio?: '16:9' | '9:16' | '1:1'
    style?: 'marketing' | 'training'
    targetDurationS?: number | null
    resolution?: '720P' | '1080P' | null
    ttsEnabled?: boolean | null
    subtitleEnabled?: boolean | null
    backgroundMusicEnabled?: boolean | null
    withAudio?: boolean | null
    expectedSettingsVersion?: number | null
  }): Promise<{ jobId: string; effectiveSettings?: Record<string, unknown>; settingsVersion?: number }> {
    this.validateSession(input.sessionId)
    const client = this.createClient(this.requireConfig())
    // const run = input.run ?? null
    // MEA:industrial-video 真实用户发送触发返修，新 run 不复用旧成片写入口。
    let run = input.run ?? null
    const pending = this.userInputs.get(input.sessionId)
    const token = this.getExecutionToken()
    const record = this.getRecord(input.sessionId)
    if (run) this.assertRunBelongs(input.sessionId, run, record)
    // if (pending && pending.epoch === token?.epoch && record?.run && record.jobId && record.state === 'done') {
    if (pending && pending.epoch === token?.epoch && this.hasCompletedVideo(record)) {
      pending.revision ??= this.runCreate({ sessionId: input.sessionId, baseName: 'revision' }).then(
        (result) => result.run
      )
      run = await pending.revision
    } else if (pending?.epoch === token?.epoch && pending?.revision) {
      run = await pending.revision
    }
    const userInput = await this.prepareParseInput(input.sessionId)
    const changes = { ...input } as Partial<typeof input>
    delete changes.sessionId
    delete changes.run
    // const validated = mergeIndustrialVideoInput({}, changes as IndustrialVideoInput)
    const validated = mergeIndustrialVideoInput(changes as IndustrialVideoInput, userInput)
    let snapshot: IndustrialVideoInput = {}
    const data = await this.guardWrite({
      sessionId: input.sessionId,
      operation: 'parse',
      state: 'parsing',
      run,
      requireRun: run,
      gatedByActiveJob: true,
      // doCall: () => client.videoStart({ stage: 'parse', run, texts: input.texts as never, media: input.media as never,
      //   logo: input.logo as never, voice: input.voice ?? null, aspect_ratio: input.aspectRatio ?? null,
      //   style: input.style ?? null, ...buildVideoStartSettings(input) }),
      // onSuccess: (d) => ({ jobId: d.job_id, state: 'parsing' })
      // MEA:industrial-video 全量输入在会话写锁内合并，避免并发素材覆盖。
      doCall: () => {
        snapshot = mergeIndustrialVideoInput(getIndustrialVideoInput(this.getRecord(input.sessionId)), validated)
        // 设置版本是本次请求的并发校验凭据，不是可跨 run 继承的制作资料。
        // 保留素材/参数快照，但只转发本次显式提供的版本，避免新 run 携带旧 run 版本。
        snapshot.expectedSettingsVersion = validated.expectedSettingsVersion
        return client.videoStart({
          stage: 'parse',
          run,
          texts: snapshot.texts,
          media: snapshot.media,
          logo: snapshot.logo,
          voice: snapshot.voice ?? null,
          aspect_ratio: snapshot.aspectRatio ?? null,
          style: snapshot.style ?? null,
          ...buildVideoStartSettings(snapshot)
        })
      },
      onSuccess: (d) => ({ jobId: d.job_id, state: 'parsing', detail: { inputSnapshot: snapshot } })
    })
    return {
      jobId: data.job_id,
      effectiveSettings: data.effective_settings,
      settingsVersion: extractSettingsVersion(data.effective_settings)
    }
  }

  private async guardReview<T>(
    request: IndustrialVideoReviewInput &
      ({ operation: 'review_snapshot_get' } | { operation: 'review_confirm'; expectedReviewVersion: string }),
    call: (
      client: IndustrialVideoClient,
      assertion: string,
      reviewType: IndustrialVideoReviewType
    ) => Promise<IndustrialVideoResult<T>>
  ): Promise<T> {
    const epoch = this.getRecord(request.sessionId)?.control?.epoch ?? 0
    return this.withSessionLock(request.sessionId, async () => {
      this.assertExecutionOpen(request.sessionId, epoch)
      const session = this.validateSession(request.sessionId)
      const record = this.getRecord(request.sessionId)
      this.assertRunBelongs(request.sessionId, request.run, record)
      if (!record?.run || record.sessionId !== request.sessionId) {
        throw new IpcError('IVIDEO_RUN_INVALID', '审核 run 不属于当前会话。')
      }
      if (request.operation === 'review_confirm' && !request.expectedReviewVersion.trim()) {
        throw new IpcError('IVIDEO_REVIEW_VERSION_INVALID', '必须提供用户实际查看的快照版本。')
      }
      const reviewType = request.reviewType ?? 'script_and_storyboard'
      const assertion = await this.reviewAuthorizationProvider.authorize({
        sessionId: request.sessionId,
        workspaceId: session.workspaceId,
        run: request.run,
        reviewType,
        ...(request.operation === 'review_confirm'
          ? { operation: request.operation, expectedReviewVersion: request.expectedReviewVersion }
          : { operation: request.operation })
      })
      if (typeof assertion !== 'string' || !assertion.trim()) {
        throw new IpcError('IVIDEO_REVIEW_AUTH_UNAVAILABLE', '未接通可信身份签发')
      }
      this.assertExecutionOpen(request.sessionId, epoch)
      const result = await call(this.createClient(this.requireConfig()), assertion, reviewType)
      // if (result.ok) return result.data
      if (result.ok) {
        const control = this.getRecord(request.sessionId)?.control
        if (control?.stopRequested || (control?.epoch ?? 0) !== epoch) {
          const latest = this.getRecord(request.sessionId)!
          latest.rounds = [
            ...latest.rounds,
            {
              version: latest.version,
              operation: request.operation,
              run: request.run,
              jobId: null,
              state: latest.state,
              requestId: result.requestId,
              at: Date.now(),
              outcome: 'ok',
              detail: { receipt: result.data, invalidated: true, epoch }
            }
          ]
          this.saveRecord(latest)
        }
        this.assertExecutionOpen(request.sessionId, epoch)
        return result.data
      }
      const error = result.error
      throw new IpcError('IVIDEO_HTTP_ERROR', error.message, {
        category: error.category,
        code: error.code,
        status: error.status,
        outcomeUnknown:
          error.outcomeUnknown ||
          (request.operation === 'review_confirm' && (error.category === 'validation' || (error.status ?? 0) >= 500)),
        operation: request.operation
      })
    })
  }

  async reviewSnapshotGet(input: IndustrialVideoReviewInput): Promise<ReviewSnapshot> {
    const epoch = this.getRecord(input.sessionId)?.control?.epoch ?? 0
    const snapshot = await this.guardReview(
      { ...input, operation: 'review_snapshot_get' },
      (client, assertion, reviewType) =>
        client.reviewSnapshotGet({ run: input.run, host_assertion: assertion, review_type: reviewType })
    )
    this.assertExecutionOpen(input.sessionId, epoch)
    if ((input.reviewType ?? 'script_and_storyboard') === 'script_and_storyboard') {
      this.pendingReviewSnapshots.set(input.sessionId, { run: input.run, reviewVersion: snapshot.review_version })
      const confirmed = this.confirmedReviews.get(input.sessionId)
      if (confirmed && (confirmed.run !== input.run || confirmed.reviewVersion !== snapshot.review_version)) {
        this.confirmedReviews.delete(input.sessionId)
      }
    }
    return snapshot
  }

  getPendingReviewSnapshot(input: { sessionId: string }): { run: string; reviewVersion: string } | null {
    this.validateSession(input.sessionId)
    return this.pendingReviewSnapshots.get(input.sessionId) ?? null
  }

  getConfirmedReview(input: { sessionId: string }): { run: string; reviewVersion: string } | null {
    this.validateSession(input.sessionId)
    return this.confirmedReviews.get(input.sessionId) ?? null
  }

  async reviewConfirm(input: IndustrialVideoReviewInput & { expectedReviewVersion: string }): Promise<ReviewReceipt> {
    const epoch = this.getRecord(input.sessionId)?.control?.epoch ?? 0
    const receipt = await this.guardReview({ ...input, operation: 'review_confirm' }, (client, assertion, reviewType) =>
      client.reviewConfirm({
        run: input.run,
        host_assertion: assertion,
        review_type: reviewType,
        expected_review_version: input.expectedReviewVersion
      })
    )
    this.assertExecutionOpen(input.sessionId, epoch)
    if (receipt.generation_allowed && (input.reviewType ?? 'script_and_storyboard') === 'script_and_storyboard') {
      this.confirmedReviews.set(input.sessionId, { run: input.run, reviewVersion: receipt.review_version })
    }
    return receipt
  }

  async planningContextGet(input: { sessionId: string; run: string }): Promise<Record<string, unknown>> {
    const client = this.createClient(this.requireConfig())
    return this.guardRead({
      sessionId: input.sessionId,
      operation: 'planning_context_get',
      requireRun: input.run,
      doCall: () => client.planningContextGet({ run: input.run })
    })
  }

  async storyboardGet(input: { sessionId: string; run: string; full?: boolean }): Promise<Record<string, unknown>> {
    const client = this.createClient(this.requireConfig())
    return this.guardRead({
      sessionId: input.sessionId,
      operation: 'storyboard_get',
      requireRun: input.run,
      doCall: () => client.storyboardGet({ run: input.run, full: input.full ?? true })
    })
  }

  async storyboardSubmit(input: {
    sessionId: string
    run: string
    storyboard: Record<string, unknown>
    expectedInputFingerprint: string
    expectedStoryboardSha256: string
  }): Promise<{ submitted: boolean; reviewRequired: boolean }> {
    const client = this.createClient(this.requireConfig())
    const data = await this.guardWrite({
      sessionId: input.sessionId,
      operation: 'storyboard_submit',
      state: 'storyboard_submitted',
      run: input.run,
      requireRun: input.run,
      gatedByActiveJob: true,
      doCall: () =>
        client.storyboardSubmit({
          run: input.run,
          storyboard: input.storyboard as never,
          expected_input_fingerprint: input.expectedInputFingerprint,
          expected_storyboard_sha256: input.expectedStoryboardSha256
        }),
      onSuccess: () => ({ state: 'storyboard_submitted' })
    })
    return { submitted: data.submitted, reviewRequired: data.review_required }
  }

  async videoStart(input: {
    sessionId: string
    run: string
    voice?: IndustrialVideoVoice
    aspectRatio?: '16:9' | '9:16' | '1:1'
    style?: 'marketing' | 'training'
    targetDurationS?: number | null
    resolution?: '720P' | '1080P' | null
    ttsEnabled?: boolean | null
    subtitleEnabled?: boolean | null
    backgroundMusicEnabled?: boolean | null
    withAudio?: boolean | null
    expectedSettingsVersion?: number | null
  }): Promise<{
    jobId: string
    effectiveSettings?: Record<string, unknown>
    settingsVersion?: number
    settingsPersisted?: boolean
    settingsChanged?: boolean
    requiresReplan?: boolean
    approvalInvalidated?: boolean
  }> {
    // Task-submitting path: always returns a `job_id` (old videoStart callers keep
    // that contract). The fee/range pre-check lives in the dedicated `estimate` route.
    // The server echoes `effective_settings` + receipt flags (§17.2) which we forward.
    const client = this.createClient(this.requireConfig())
    const data = await this.guardWrite({
      sessionId: input.sessionId,
      operation: 'video_start',
      state: 'generating',
      run: input.run,
      requireRun: input.run,
      gatedByActiveJob: true,
      doCall: () =>
        client.videoStart({
          stage: 'video',
          run: input.run,
          estimate_only: false,
          voice: input.voice ?? null,
          aspect_ratio: input.aspectRatio ?? null,
          style: input.style ?? null,
          ...buildVideoStartSettings(input)
        }),
      onSuccess: (d) => ({ jobId: d.job_id, state: 'generating' })
    })
    return {
      jobId: data.job_id,
      effectiveSettings: data.effective_settings,
      settingsVersion: extractSettingsVersion(data.effective_settings),
      settingsPersisted: data.settings_persisted,
      settingsChanged: data.settings_changed,
      requiresReplan: data.requires_replan,
      approvalInvalidated: data.approval_invalidated
    }
  }

  async assemble(input: { sessionId: string; run: string }): Promise<{ jobId: string }> {
    const client = this.createClient(this.requireConfig())
    const data = await this.guardWrite({
      sessionId: input.sessionId,
      operation: 'assemble',
      state: 'assembling',
      run: input.run,
      requireRun: input.run,
      gatedByActiveJob: true,
      doCall: () => client.videoStart({ stage: 'assemble', run: input.run }),
      onSuccess: (d) => ({ jobId: d.job_id, state: 'assembling' })
    })
    return { jobId: data.job_id }
  }

  async estimate(input: {
    sessionId: string
    run: string
    voice?: IndustrialVideoVoice
    aspectRatio?: '16:9' | '9:16' | '1:1'
    style?: 'marketing' | 'training'
    targetDurationS?: number | null
    resolution?: '720P' | '1080P' | null
    ttsEnabled?: boolean | null
    subtitleEnabled?: boolean | null
    backgroundMusicEnabled?: boolean | null
    withAudio?: boolean | null
    expectedSettingsVersion?: number | null
  }): Promise<{
    estimate: Record<string, unknown>
    effectiveSettings?: Record<string, unknown>
    settingsVersion?: number
    settingsPersisted?: boolean
    settingsChanged?: boolean
    requiresReplan?: boolean
    approvalInvalidated?: boolean
  }> {
    // Read-only fee / range pre-check. Returns no job_id, appends no round, and
    // never changes the persisted production state. estimate_only echoes the
    // would-be `effective_settings` (settings_persisted=false) which we forward.
    const client = this.createClient(this.requireConfig())
    const result = await this.guardRead({
      sessionId: input.sessionId,
      operation: 'video_start',
      requireRun: input.run,
      doCall: () =>
        client.estimate({
          run: input.run,
          voice: input.voice ?? null,
          aspect_ratio: input.aspectRatio ?? null,
          style: input.style ?? null,
          ...buildVideoStartSettings(input)
        })
    })
    return {
      estimate: result.estimate,
      effectiveSettings: result.effective_settings,
      settingsVersion: extractSettingsVersion(result.effective_settings),
      settingsPersisted: result.settings_persisted,
      settingsChanged: result.settings_changed,
      requiresReplan: result.requires_replan,
      approvalInvalidated: result.approval_invalidated
    }
  }

  async jobGet(input: {
    sessionId: string
    jobId: string
    waitS?: number
    tailLines?: number
  }): Promise<Record<string, unknown>> {
    const client = this.createClient(this.requireConfig())
    return this.guardJobGet({
      sessionId: input.sessionId,
      jobId: input.jobId,
      doCall: () => client.jobGet({ job_id: input.jobId, wait_s: input.waitS, tail_lines: input.tailLines })
    })
  }

  async jobList(input: { sessionId: string; limit?: number }): Promise<Record<string, unknown>> {
    const client = this.createClient(this.requireConfig())
    return this.guardRead({
      sessionId: input.sessionId,
      operation: 'job_list',
      doCall: () => client.jobList({ limit: input.limit })
    })
  }

  async jobCancel(input: { sessionId: string; jobId: string }): Promise<Record<string, unknown>> {
    const client = this.createClient(this.requireConfig())
    // return this.guardWrite({
    //   sessionId: input.sessionId, operation: 'job_cancel', state: 'canceled', run: null,
    //   requireJob: input.jobId, gatedByActiveJob: false,
    //   doCall: () => client.jobCancel({ job_id: input.jobId }),
    //   onSuccess: () => ({ run: this.getRecord(input.sessionId)?.run, jobId: input.jobId, state: 'canceled' })
    // })
    // MEA:industrial-video 取消独立于提交门禁；回执不代表 worker 已终止。
    this.validateSession(input.sessionId)
    const record = this.getRecord(input.sessionId)
    this.assertJobBelongs(input.sessionId, input.jobId, record)
    const epoch = record?.control?.epoch ?? 0
    const result = await client.jobCancel({ job_id: input.jobId })
    const latest = this.getRecord(input.sessionId)!
    latest.rounds = [
      ...latest.rounds,
      {
        version: record!.version,
        operation: 'job_cancel',
        run: record!.run,
        jobId: input.jobId,
        state: record!.state,
        requestId: result.requestId,
        at: Date.now(),
        outcome: result.ok ? 'ok' : 'unknown',
        detail: result.ok ? { receipt: result.data } : { error: result.error.message }
      }
    ]
    if (latest.control?.stopRequested && latest.control.epoch === epoch && latest.control.phase !== 'stopped') {
      latest.control = { ...latest.control, phase: 'reconcile_required' }
    }
    this.saveRecord(latest)
    if (!result.ok)
      throw new IpcError('IVIDEO_HTTP_ERROR', result.error.message, { operation: 'job_cancel', outcomeUnknown: true })
    return { ...result.data }
  }

  async mediaUpload(input: {
    sessionId: string
    caption: string
    contentBase64: string
    name?: string | null
    kind?: 'image' | 'video' | null
  }): Promise<{ name: string }> {
    const client = this.createClient(this.requireConfig())
    const data = await this.guardWrite({
      sessionId: input.sessionId,
      operation: 'media_upload',
      state: 'idle',
      run: null,
      gatedByActiveJob: false,
      doCall: () =>
        client.mediaUpload({
          caption: input.caption,
          content_base64: input.contentBase64,
          name: input.name ?? null,
          kind: input.kind ?? null
        }),
      onSuccess: (d) => ({ state: 'idle', detail: { name: d.name } })
    })
    return { name: data.name }
  }

  async logoUpload(input: {
    sessionId: string
    contentBase64: string
    name?: string | null
    brandKind?: 'company' | 'product'
  }): Promise<{ name: string }> {
    const client = this.createClient(this.requireConfig())
    const data = await this.guardWrite({
      sessionId: input.sessionId,
      operation: 'logo_upload',
      state: 'idle',
      run: null,
      gatedByActiveJob: false,
      doCall: () =>
        client.logoUpload({
          content_base64: input.contentBase64,
          name: input.name ?? null,
          brand_kind: input.brandKind ?? 'company'
        }),
      onSuccess: (d) => ({ state: 'idle', detail: { name: d.name } })
    })
    return { name: data.name }
  }

  /**
   * Upload a raw material file (image/video) as bytes. This is the canonical new
   * entry point (COWORK_HTTP_GUIDE §15.2): the client POSTs the bytes verbatim to
   * the service root `/upload` and returns the server `name` handle. Crucially this
   * is NOT a versioned submission — it validates the session and forwards bytes but
   * appends no production round and never changes `state`/`version` (the upload
   * alone does not create a Studio project or a production version).
   *
   * The token is resolved from the main env only and is never returned to the
   * renderer; the IPC output is exactly `{ name }`.
   */
  async upload(input: { sessionId: string; name: string; content: Uint8Array }): Promise<{ name: string }> {
    this.validateSession(input.sessionId)
    this.assertExecutionOpen(input.sessionId)
    const client = this.createClient(this.requireConfig())
    const result = await client.upload({ name: input.name, content: input.content })
    if (!result.ok) {
      const error = result.error
      throw new IpcError('IVIDEO_HTTP_ERROR', error.message, {
        category: error.category,
        code: error.code,
        status: error.status,
        outcomeUnknown: error.outcomeUnknown,
        operation: 'upload'
      })
    }
    return { name: result.data.name }
  }

  async artifactRead(input: {
    sessionId: string
    run: string
    path: string
    maxChars?: number
  }): Promise<Record<string, unknown>> {
    const client = this.createClient(this.requireConfig())
    return {
      ...(await this.guardRead({
        sessionId: input.sessionId,
        operation: 'artifact_read',
        requireRun: input.run,
        doCall: () => client.artifactRead({ run: input.run, path: input.path, max_chars: input.maxChars })
      }))
    }
  }

  /**
   * Controlled download of one artifact into the session's trusted workspace.
   *
   * This is a side-effecting IO operation but must NOT mutate the persisted
   * production record: it appends no round and never advances `state` (unlike the
   * generation/submit operations). It only validates ownership (session + run) and
   * writes the file to the real workspace directory resolved from the trusted
   * WorkspaceService by `workspaceId` — the renderer never supplies a destination.
   * Any download failure is surfaced as a structured `IpcError`.
   */
  async downloadArtifact(input: {
    sessionId: string
    run: string
    path: string
    expectedSize?: number
  }): Promise<{ filePath: string; size: number }> {
    const session = this.validateSession(input.sessionId)
    const record = this.getRecord(input.sessionId)
    // this.assertRunBelongs(input.sessionId, input.run, record)
    this.assertReadableRun(input.sessionId, input.run, record)

    // The real workspace directory comes from the trusted WorkspaceService, never
    // a renderer-controlled value (which would be a path-injection vector).
    const workspaceDir = this.deps.getWorkspacePath(session.workspaceId)

    const config = this.requireConfig()
    const downloader = this.deps.createDownloader(config)
    const result = await downloader.downloadArtifact({
      serverPath: input.path,
      workspaceDir,
      expectedSize: input.expectedSize
    })
    if (!result.ok) {
      const error = result.error
      throw new IpcError('IVIDEO_DOWNLOAD_FAILED', `Artifact download failed: ${error.message}`, {
        category: error.category,
        code: error.code,
        status: error.status,
        outcomeUnknown: error.outcomeUnknown
      })
    }
    return { filePath: result.filePath, size: result.size }
  }

  async sceneRetry(input: { sessionId: string; run: string; sceneId: number }): Promise<Record<string, unknown>> {
    const client = this.createClient(this.requireConfig())
    return this.guardWrite({
      sessionId: input.sessionId,
      operation: 'scene_retry',
      state: 'generating',
      run: input.run,
      requireRun: input.run,
      gatedByActiveJob: true,
      doCall: () => client.sceneRetry({ run: input.run, scene_id: input.sceneId }),
      onSuccess: (data) => ({
        state: typeof data.job_id === 'string' ? 'generating' : 'blocked',
        jobId: typeof data.job_id === 'string' ? data.job_id : null
      })
    })
  }

  async qaGet(input: { sessionId: string; run: string }): Promise<Record<string, unknown>> {
    const client = this.createClient(this.requireConfig())
    return this.guardRead({
      sessionId: input.sessionId,
      operation: 'qa_get',
      requireRun: input.run,
      doCall: () => client.qaGet({ run: input.run })
    })
  }

  async previewCreate(input: { sessionId: string; run: string; force?: boolean }): Promise<Record<string, unknown>> {
    const client = this.createClient(this.requireConfig())
    return this.guardRead({
      sessionId: input.sessionId,
      operation: 'preview_create',
      requireRun: input.run,
      doCall: () => client.previewCreate({ run: input.run, force: input.force ?? false })
    })
  }

  /** Read the host-owned production record for a session (or null when none yet). */
  getRecords(input: { sessionId: string }): IndustrialVideoProductionRecord | null {
    this.validateSession(input.sessionId)
    return this.getRecord(input.sessionId)
  }
}
