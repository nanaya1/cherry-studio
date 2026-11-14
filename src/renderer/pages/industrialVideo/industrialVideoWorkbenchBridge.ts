import {
  type IndustrialVideoWorkbenchConfirmReceipt,
  type IndustrialVideoWorkbenchRequest,
  type IndustrialVideoWorkbenchSnapshot
} from '@shared/utils/industrialVideoWorkbench'

export type IndustrialVideoWorkbenchAction = 'regenerate_storyboard' | 'generate_video'

/** 宿主受限桥；只确认显式分镜请求，不触发视频生成。 */
export interface IndustrialVideoWorkbenchBridgeDeps {
  sessionId: string
  run: string
  coworkReviewGet: () => Promise<IndustrialVideoWorkbenchSnapshot>
  coworkReviewConfirm: (
    reviewVersion: string,
    action: IndustrialVideoWorkbenchAction
  ) => Promise<IndustrialVideoWorkbenchConfirmReceipt>
  resumeStages?: (run: string) => Promise<unknown>
  getResumeStages?: () => ((run: string) => Promise<unknown>) | undefined
}

export type BridgeResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string; code: string }

const reject = (code: string): BridgeResult => ({ ok: false, error: code, code })
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

export class IndustrialVideoWorkbenchBridge {
  private currentReviewVersion: string | null = null
  private busy = false
  private invalid = false
  private readonly processed = new Set<string>()

  constructor(private readonly deps: IndustrialVideoWorkbenchBridgeDeps) {}

  private validate(request: IndustrialVideoWorkbenchRequest, type: IndustrialVideoWorkbenchRequest['type']): BridgeResult | null {
    if (!request || typeof request !== 'object' || request.type !== type ||
      !nonempty(request.requestId) || !nonempty(request.sessionId) || !nonempty(request.run) ||
      (type === 'regenerate_storyboard' ? !nonempty(request.reviewVersion) : request.reviewVersion !== undefined) ||
      Object.keys(request).some((key) => !['requestId', 'type', 'sessionId', 'run', 'reviewVersion'].includes(key))) {
      return reject('invalid_request')
    }
    if (request.sessionId !== this.deps.sessionId || request.run !== this.deps.run) return reject('untrusted_source')
    if (this.invalid) return reject('stale')
    if (this.busy) return reject('busy')
    if (this.processed.has(request.requestId)) return reject('replay')
    return null
  }

  private resumeHandler() {
    return this.deps.getResumeStages ? this.deps.getResumeStages() : this.deps.resumeStages
  }

  /** 失败不污染已展示版本；失效后不可重新启用。 */
  async getSnapshot(request: IndustrialVideoWorkbenchRequest): Promise<BridgeResult> {
    const error = this.validate(request, 'get_review_snapshot')
    if (error) return error
    this.busy = true
    this.processed.add(request.requestId)
    try {
      const snapshot = await this.deps.coworkReviewGet()
      if (this.invalid) return reject('stale')
      if (!nonempty(snapshot?.review_version)) return reject('invalid_snapshot')
      this.currentReviewVersion = snapshot.review_version
      return { ok: true, data: snapshot }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), code: 'snapshot_failed' }
    } finally {
      this.busy = false
    }
  }

  async regenerateStoryboard(request: IndustrialVideoWorkbenchRequest): Promise<BridgeResult> {
    const error = this.validate(request, 'regenerate_storyboard')
    if (error) return error
    if (!this.resumeHandler()) return reject('unregistered')
    if (this.currentReviewVersion === null) return reject('stale')
    // 绑定点击时的展示版本，禁止以新取版本替代。
    const version = this.currentReviewVersion
    if (request.reviewVersion !== version) return reject('version_mismatch')
    this.busy = true
    this.processed.add(request.requestId)
    try {
      const latest = await this.deps.coworkReviewGet()
      if (this.invalid) return reject('stale')
      if (latest.review_version !== version) return reject('version_changed')
      if (!Array.isArray(latest.allowed_actions) || !latest.allowed_actions.includes('regenerate_storyboard')) return reject('not_allowed')
      if (!this.resumeHandler()) return reject('unregistered')
      const receipt = await this.deps.coworkReviewConfirm(version, 'regenerate_storyboard')
      if (this.invalid) return reject('stale')
      if (receipt?.task_operation !== 'storyboard_stage_task_get') return reject('unexpected_operation')
      const resume = this.resumeHandler()
      if (!resume) return reject('unregistered')
      await resume(this.deps.run)
      if (this.invalid) return reject('stale')
      return { ok: true, data: receipt }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), code: 'confirm_failed' }
    } finally {
      this.busy = false
    }
  }

  /** 离开页面 / run 变更时终止后续副作用。 */
  invalidate(): void {
    this.invalid = true
    this.currentReviewVersion = null
  }
}
