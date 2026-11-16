import type { IndustrialVideoProductionRecord } from '@shared/data/cache/cacheValueTypes'
import { IpcError } from '@shared/ipc/errors/IpcError'

/**
 * MEA:industrial-video 成片下载的身份绑定与命名。只消费 job_get 返回的权威
 * final_artifact，不猜测执行身份；旧服务无该字段时由调用方保留原下载（兼容范围）。
 */
export interface FinalArtifactInfo {
  path: string
  sha256: string
  size: number
  generatedAt: string
  executionId: string
  ownedByThisJob: boolean
}

export type FinalArtifactRead = { kind: 'valid'; final: FinalArtifactInfo } | { kind: 'absent' } | { kind: 'invalid' }

/**
 * Distinguish a legacy server (progress explicitly has no final_artifact) from a
 * broken/malformed response. Only 'absent' permits the legacy download; 'invalid'
 * must be surfaced as an error, never silently downgraded.
 */
export function inspectFinalArtifact(jobData: Record<string, unknown>): FinalArtifactRead {
  const progress = jobData.progress
  if (typeof progress !== 'object' || progress === null || Array.isArray(progress)) return { kind: 'invalid' }
  if (!Object.prototype.hasOwnProperty.call(progress, 'final_artifact')) return { kind: 'absent' }
  const final = readFinalArtifact(jobData)
  return final ? { kind: 'valid', final } : { kind: 'invalid' }
}

/** Read a complete final_artifact from job_get progress; null only when absent/malformed. */
export function readFinalArtifact(jobData: Record<string, unknown>): FinalArtifactInfo | null {
  const progress = jobData.progress
  if (typeof progress !== 'object' || progress === null || Array.isArray(progress)) return null
  const raw = (progress as Record<string, unknown>).final_artifact
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const f = raw as Record<string, unknown>
  if (typeof f.path !== 'string' || f.path.length === 0) return null
  if (typeof f.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(f.sha256)) return null
  if (typeof f.size !== 'number' || !Number.isInteger(f.size) || f.size <= 0) return null
  if (typeof f.generated_at !== 'string' || f.generated_at.length === 0) return null
  if (typeof f.execution_id !== 'string' || f.execution_id.length === 0) return null
  if (typeof f.owned_by_this_job !== 'boolean') return null
  return {
    path: f.path,
    sha256: f.sha256.toLowerCase(),
    size: f.size,
    generatedAt: f.generated_at,
    executionId: f.execution_id,
    ownedByThisJob: f.owned_by_this_job
  }
}

/**
 * Fail closed: never attribute a new artifact to an old/stale job. Returns void;
 * throws IpcError when the bound identity does not match the recorded final artifact.
 */
export function assertFinalDownloadAllowed(args: {
  record: IndustrialVideoProductionRecord | null
  jobData: Record<string, unknown>
  final: FinalArtifactInfo
  requestedPath: string
}): void {
  const { record, jobData, final, requestedPath } = args
  if (!record || !record.jobId || !record.run) {
    throw new IpcError('IVIDEO_JOB_INVALID', '当前会话没有已绑定的生成任务，不能下载成片。')
  }
  if (!final.ownedByThisJob) {
    throw new IpcError('IVIDEO_ARTIFACT_NOT_OWNED', '成片不属于当前任务，已停止下载以避免归错任务。')
  }
  if (jobData.status !== 'done') {
    throw new IpcError('IVIDEO_ARTIFACT_NOT_SUCCESS', '任务尚未成功完成，不能发布成片。')
  }
  // 先判活动 job，再判 job id：有新任务时旧成片一律停止，不归到当前任务。
  const activeJob = record.state !== 'done' || record.control?.phase === 'active'
  if (activeJob) {
    throw new IpcError('IVIDEO_ARTIFACT_STALE_JOB', '存在更新的活动任务（新 job active），旧成片不得归到当前任务。')
  }
  if (typeof jobData.job_id === 'string' && jobData.job_id !== record.jobId) {
    throw new IpcError('IVIDEO_ARTIFACT_JOB_MISMATCH', '服务端任务 job_id 与当前绑定任务不一致，已停止下载。')
  }
  if (requestedPath !== final.path) {
    throw new IpcError('IVIDEO_ARTIFACT_PATH_MISMATCH', '下载路径与服务端记录的成片路径不一致，已停止下载。')
  }
  const executions = [jobData.execution_id, record.jobId].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  )
  if (executions.length > 0 && !executions.includes(final.executionId)) {
    throw new IpcError('IVIDEO_ARTIFACT_EXECUTION_MISMATCH', '成片执行标识与当前任务不匹配，已停止下载。')
  }
}

/** UTC ISO → compact timestamp token used in the file name. */
function formatGeneratedAt(generatedAt: string): string {
  const ms = Date.parse(generatedAt)
  if (!Number.isFinite(ms)) return 'unknown'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  )
}

/** Short, filesystem-safe job token: take the trailing random segment, not the date/time prefix. */
export function shortJobToken(jobId: string): string {
  const safe = jobId.replace(/[^A-Za-z0-9_-]/g, '')
  const segments = safe.split(/[-_]/).filter(Boolean)
  return (segments.at(-1) ?? safe).slice(-12)
}

function sanitizeTitle(title: string): string {
  const cleaned = title
    .replace(/[<>:"/\\|?*]/g, '_')
    .split('')
    .map((char) => (char.charCodeAt(0) < 32 ? '_' : char))
    .join('')
    .replace(/[\s_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned.length > 0 ? cleaned : '成片'
}

/** 标题_生成时间_短任务标识.mp4 */
export function makeFinalFileName(args: { title: string; generatedAt: string; jobId: string }): string {
  const title = sanitizeTitle(args.title)
  const time = formatGeneratedAt(args.generatedAt)
  const job = shortJobToken(args.jobId) || 'job'
  return `${title}_${time}_${job}.mp4`
}

/** Scoped dedup identity: hash + job + run + workspace + service base URL. */
export function finalDownloadKey(args: {
  jobId: string
  final: FinalArtifactInfo
  workspaceDir: string
  run: string
  baseUrl: string
}): string {
  return JSON.stringify([args.baseUrl, args.workspaceDir, args.run, args.jobId, args.final.sha256.toLowerCase()])
}
