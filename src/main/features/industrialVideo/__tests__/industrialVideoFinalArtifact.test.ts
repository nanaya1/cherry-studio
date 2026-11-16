import type { IndustrialVideoProductionRecord } from '@shared/data/cache/cacheValueTypes'

import {
  assertFinalDownloadAllowed,
  finalDownloadKey,
  inspectFinalArtifact,
  makeFinalFileName,
  readFinalArtifact
} from '../industrialVideoFinalArtifact'

function doneJob(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run: 'r1',
    job_id: 'job-abcdef123456',
    status: 'done',
    progress: {
      final: 'r1/final/成片.mp4',
      final_artifact: {
        path: 'r1/final/成片.mp4',
        sha256: 'a'.repeat(64),
        size: 4096,
        generated_at: '2026-11-16T07:30:45Z',
        execution_id: 'job-abcdef123456',
        owned_by_this_job: true
      }
    },
    ...over
  }
}

function doneRecord(over: Partial<IndustrialVideoProductionRecord> = {}): IndustrialVideoProductionRecord {
  return {
    sessionId: 's1',
    version: 1,
    run: 'r1',
    jobId: 'job-abcdef123456',
    state: 'done',
    rounds: [],
    unknownSubmissions: [],
    control: { epoch: 1, phase: 'idle', stopRequested: false },
    updatedAt: 1,
    ...over
  }
}

describe('readFinalArtifact', () => {
  it('reads a complete final_artifact from job_get progress', () => {
    expect(readFinalArtifact(doneJob())).toEqual({
      path: 'r1/final/成片.mp4',
      sha256: 'a'.repeat(64),
      size: 4096,
      generatedAt: '2026-11-16T07:30:45Z',
      executionId: 'job-abcdef123456',
      ownedByThisJob: true
    })
  })

  it('returns null for legacy servers without final_artifact (no fabricated identity)', () => {
    expect(readFinalArtifact({ run: 'r1', status: 'done', progress: { final: 'r1/final/x.mp4' } })).toBeNull()
    expect(readFinalArtifact({ run: 'r1', status: 'done' })).toBeNull()
  })

  it('returns null when required fields are missing or malformed', () => {
    const base = doneJob().progress as { final_artifact: Record<string, unknown> }
    expect(
      readFinalArtifact(doneJob({ progress: { ...base, final_artifact: { ...base.final_artifact, sha256: 'xyz' } } }))
    ).toBeNull()
    expect(
      readFinalArtifact(doneJob({ progress: { ...base, final_artifact: { ...base.final_artifact, size: -1 } } }))
    ).toBeNull()
    expect(
      readFinalArtifact(doneJob({ progress: { ...base, final_artifact: { ...base.final_artifact, path: '' } } }))
    ).toBeNull()
  })
})

describe('assertFinalDownloadAllowed', () => {
  const final = readFinalArtifact(doneJob())!
  const args = () => ({ record: doneRecord(), jobData: doneJob(), final, requestedPath: 'r1/final/成片.mp4' })

  it('allows a finished artifact owned by the still-bound job', () => {
    expect(() => assertFinalDownloadAllowed(args())).not.toThrow()
  })

  it('stops when the server says the artifact is not owned by this job', () => {
    expect(() => assertFinalDownloadAllowed({ ...args(), final: { ...final, ownedByThisJob: false } })).toThrow(
      /不属于当前任务/
    )
  })

  it('stops when the job is not successful', () => {
    expect(() => assertFinalDownloadAllowed({ ...args(), jobData: doneJob({ status: 'running' }) })).toThrow(
      /success|成功|done/i
    )
  })

  it('stops when the server reports a different job id', () => {
    expect(() => assertFinalDownloadAllowed({ ...args(), jobData: doneJob({ job_id: 'job-other' }) })).toThrow(/job_id/)
  })

  it('stops when the requested path is not the recorded final path', () => {
    expect(() => assertFinalDownloadAllowed({ ...args(), requestedPath: 'r1/final/old.mp4' })).toThrow(/path|路径/i)
  })

  it('stops when a newer job is active in the bound record', () => {
    expect(() =>
      assertFinalDownloadAllowed({
        ...args(),
        record: doneRecord({ state: 'generating', jobId: 'job-new' })
      })
    ).toThrow(/job active/)
  })

  it('stops when the record is still in an active control phase', () => {
    expect(() =>
      assertFinalDownloadAllowed({
        ...args(),
        record: doneRecord({ control: { epoch: 2, phase: 'active', stopRequested: false } })
      })
    ).toThrow(/job active/)
  })

  it('stops when final execution id does not match the bound job execution', () => {
    expect(() => assertFinalDownloadAllowed({ ...args(), final: { ...final, executionId: 'job-stale' } })).toThrow(
      /execution|执行/i
    )
  })
})

describe('makeFinalFileName', () => {
  it('names as title_generatedAtUtc_shortJobId.mp4 and sanitizes the title', () => {
    const name = makeFinalFileName({
      title: '产品/介绍:演示',
      generatedAt: '2026-11-16T07:30:45Z',
      jobId: 'job-abcdef123456'
    })
    expect(name).toMatch(/^产品_介绍_演示_20261116T073045Z_[0-9a-zA-Z_-]{1,12}\.mp4$/)
  })

  it('falls back for empty title and unparsable time without fabricating a date', () => {
    const name = makeFinalFileName({ title: '', generatedAt: 'not-a-date', jobId: 'job-abcdef123456' })
    expect(name).toMatch(/^成片_[^_]+_[0-9a-zA-Z_-]{1,12}\.mp4$/)
    expect(name.endsWith('.mp4')).toBe(true)
  })

  it('keeps the trailing random segment of a real 20261116-143025-a1b2c3d4 style job id', () => {
    const name = makeFinalFileName({
      title: '演示',
      generatedAt: '2026-11-16T07:30:45Z',
      jobId: '20261116-143025-a1b2c3d4'
    })
    expect(name).toBe('演示_20261116T073045Z_a1b2c3d4.mp4')
  })
})

describe('finalDownloadKey', () => {
  const final = readFinalArtifact(doneJob())!
  const scope = { jobId: 'job-abcdef123456', final, workspaceDir: '/ws/a', run: 'r1', baseUrl: 'http://svc-a' }

  it('binds the dedup key to job, hash, run, workspace and service base URL', () => {
    const key = finalDownloadKey(scope)
    expect(key).toContain(final.sha256)
    expect(finalDownloadKey({ ...scope, workspaceDir: '/ws/b' })).not.toBe(key)
    expect(finalDownloadKey({ ...scope, run: 'r2' })).not.toBe(key)
    expect(finalDownloadKey({ ...scope, baseUrl: 'http://svc-b' })).not.toBe(key)
    expect(finalDownloadKey({ ...scope, jobId: 'job-other' })).not.toBe(key)
  })
})

describe('inspectFinalArtifact', () => {
  it('distinguishes absent (legacy) from malformed final_artifact', () => {
    expect(inspectFinalArtifact({ progress: { final: 'r1/final/x.mp4' } }).kind).toBe('absent')
    expect(inspectFinalArtifact({ progress: { final_artifact: null } }).kind).toBe('invalid')
    expect(inspectFinalArtifact({ progress: { final_artifact: { sha256: 'bad' } } }).kind).toBe('invalid')
    expect(inspectFinalArtifact({}).kind).toBe('invalid')
    expect(inspectFinalArtifact(doneJob()).kind).toBe('valid')
  })
})
