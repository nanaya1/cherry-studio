import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BaseService } from '@main/core/lifecycle'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'
import type { IndustrialVideoProductionRecord } from '@shared/data/cache/cacheValueTypes'
import { IpcError } from '@shared/ipc/errors/IpcError'

import type { IndustrialVideoClient, IndustrialVideoResult } from '../IndustrialVideoClient'
import type { IndustrialVideoDownloader, IndustrialVideoDownloadResult } from '../IndustrialVideoDownload'
import { finalDownloadKey, readFinalArtifact } from '../industrialVideoFinalArtifact'
import { IndustrialVideoService } from '../IndustrialVideoService'

const CONTENT = Buffer.from('0123456789')
const SHA = createHash('sha256').update(CONTENT).digest('hex')
const JOB = 'job-abcdef123456'
const FINAL_PATH = 'r1/final/成片.mp4'

function ok<T>(data: T): IndustrialVideoResult<T> {
  return { ok: true, requestId: 'req', data }
}

function jobData(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run: 'r1',
    job_id: JOB,
    status: 'done',
    progress: {
      final: FINAL_PATH,
      final_artifact: {
        path: FINAL_PATH,
        sha256: SHA,
        size: 10,
        generated_at: '2026-11-16T07:30:45Z',
        execution_id: JOB,
        owned_by_this_job: true
      }
    },
    ...over
  }
}

function record(over: Partial<IndustrialVideoProductionRecord> = {}): IndustrialVideoProductionRecord {
  return {
    sessionId: 's1',
    version: 1,
    run: 'r1',
    jobId: JOB,
    state: 'done',
    rounds: [],
    unknownSubmissions: [],
    control: { epoch: 1, phase: 'idle', stopRequested: false },
    updatedAt: 1,
    ...over
  }
}

const okDownload = (filePath: string): IndustrialVideoDownloadResult => ({
  ok: true,
  requestId: 'dl',
  filePath,
  size: CONTENT.length,
  status: 200,
  sha256: SHA
})

describe('downloadArtifact final-artifact binding (industrial module only)', () => {
  let workspaceDir: string
  let store: Record<string, unknown>
  let downloadCalls: Array<Record<string, unknown>>
  let client: IndustrialVideoClient
  let service: IndustrialVideoService
  let currentRecord: () => IndustrialVideoProductionRecord

  const session: AgentSessionEntity = {
    id: 's1',
    featureKind: 'industrial-video',
    workspaceId: 'ws1'
  } as AgentSessionEntity

  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), 'iv-final-'))
    store = {}
    downloadCalls = []
    currentRecord = () => record()
    BaseService.resetInstances()
    const downloader = {
      downloadArtifact: vi.fn(async (input: Record<string, unknown>) => {
        downloadCalls.push(input)
        const filePath = join(workspaceDir, String(input.fileName ?? 'movie.mp4'))
        await writeFile(filePath, CONTENT)
        return okDownload(filePath)
      })
    } as unknown as IndustrialVideoDownloader
    client = {
      jobGet: vi.fn(async () => ok(jobData())),
      storyboardGet: vi.fn(async () => ok({ video_title: '产品介绍' }))
    } as unknown as IndustrialVideoClient
    service = new IndustrialVideoService()
    service.setTestDeps({
      resolveConfig: () => ({ baseUrl: 'http://svc', token: 't', timeoutMs: 1000 }),
      getSession: () => session,
      createClient: () => client,
      getPersist: (key: string) => (store[key] ?? {}) as Record<string, IndustrialVideoProductionRecord>,
      setPersist: (key: string, value: unknown) => {
        store[key] = value
      },
      getWorkspacePath: () => workspaceDir,
      createDownloader: () => downloader,
      getModelExecutionId: () => undefined,
      getReviewActor: async () => null,
      getLocalReviewActor: () => 'local:test',
      setLocalReviewActor: () => undefined,
      extractDocumentText: async () => null,
      ocrPdfText: async () => ''
    })
    // Seed the bound record.
    store['industrial_video.records'] = { s1: currentRecord() }
  })

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true })
  })

  it('passes sha256/jobId binding and derived fileName to the downloader, naming with title/time/short job id', async () => {
    const result = await service.downloadArtifact({ sessionId: 's1', run: 'r1', path: FINAL_PATH })
    expect(result.filePath).toBeDefined()
    expect(downloadCalls).toHaveLength(1)
    const call = downloadCalls[0]
    expect(call.expectedSha256).toBe(SHA)
    expect(call.expectedJobId).toBe(JOB)
    expect(String(call.fileName)).toMatch(/^产品介绍_20261116T073045Z_abcdef123456\.mp4$/)
  })

  it('stops without downloading when owned_by_this_job is false', async () => {
    vi.mocked(client.jobGet).mockResolvedValueOnce(
      ok(
        jobData({
          progress: {
            final: FINAL_PATH,
            final_artifact: {
              path: FINAL_PATH,
              sha256: SHA,
              size: 10,
              generated_at: '2026-11-16T07:30:45Z',
              execution_id: JOB,
              owned_by_this_job: false
            }
          }
        })
      )
    )
    await expect(service.downloadArtifact({ sessionId: 's1', run: 'r1', path: FINAL_PATH })).rejects.toBeInstanceOf(
      IpcError
    )
    expect(downloadCalls).toHaveLength(0)
  })

  it('stops when the job is not successful', async () => {
    vi.mocked(client.jobGet).mockResolvedValueOnce(ok(jobData({ status: 'running' })))
    await expect(service.downloadArtifact({ sessionId: 's1', run: 'r1', path: FINAL_PATH })).rejects.toBeInstanceOf(
      IpcError
    )
    expect(downloadCalls).toHaveLength(0)
  })

  it('stops when a newer job is active in the bound record', async () => {
    ;(store['industrial_video.records'] as Record<string, unknown>).s1 = record({
      state: 'generating',
      jobId: 'job-new'
    })
    await expect(service.downloadArtifact({ sessionId: 's1', run: 'r1', path: FINAL_PATH })).rejects.toBeInstanceOf(
      IpcError
    )
    expect(downloadCalls).toHaveLength(0)
  })

  it('throws and never downloads when job_get fails (no silent legacy fallback)', async () => {
    vi.mocked(client.jobGet).mockResolvedValueOnce({
      ok: false,
      requestId: 'req',
      error: {
        category: 'http',
        operation: 'job_get',
        requestId: 'req',
        message: 'boom',
        status: 500,
        outcomeUnknown: false
      }
    })
    await expect(service.downloadArtifact({ sessionId: 's1', run: 'r1', path: FINAL_PATH })).rejects.toMatchObject({
      code: 'IVIDEO_HTTP_ERROR'
    })
    expect(downloadCalls).toHaveLength(0)
  })

  it('throws and never downloads when final_artifact exists but is malformed', async () => {
    vi.mocked(client.jobGet).mockResolvedValueOnce(
      ok({ run: 'r1', job_id: JOB, status: 'done', progress: { final: FINAL_PATH, final_artifact: { sha256: 'bad' } } })
    )
    await expect(service.downloadArtifact({ sessionId: 's1', run: 'r1', path: FINAL_PATH })).rejects.toMatchObject({
      code: 'IVIDEO_ARTIFACT_INVALID'
    })
    expect(downloadCalls).toHaveLength(0)
  })

  it('uses authoritative final.size instead of a conflicting caller expectedSize', async () => {
    await service.downloadArtifact({ sessionId: 's1', run: 'r1', path: FINAL_PATH, expectedSize: 999 })
    expect(downloadCalls[0].expectedSize).toBe(10)
  })

  it('falls back to a legacy download with no identity binding when final_artifact is absent', async () => {
    vi.mocked(client.jobGet).mockResolvedValueOnce(ok({ run: 'r1', status: 'done', progress: { final: FINAL_PATH } }))
    await service.downloadArtifact({ sessionId: 's1', run: 'r1', path: FINAL_PATH, expectedSize: 10 })
    expect(downloadCalls).toHaveLength(1)
    expect(downloadCalls[0].expectedSha256).toBeUndefined()
    expect(downloadCalls[0].expectedJobId).toBeUndefined()
    expect(downloadCalls[0].serverPath).toBe(FINAL_PATH)
  })

  it('reuses the same film across calls for the same identity without re-downloading', async () => {
    await service.downloadArtifact({ sessionId: 's1', run: 'r1', path: FINAL_PATH })
    const first = downloadCalls[0].fileName
    await service.downloadArtifact({ sessionId: 's1', run: 'r1', path: FINAL_PATH })
    expect(downloadCalls).toHaveLength(1)
    expect(first).toBeDefined()
  })

  it('will not reuse an index entry whose sha differs from the current final artifact', async () => {
    const final = readFinalArtifact(jobData())!
    const key = finalDownloadKey({ jobId: JOB, final, workspaceDir, run: 'r1', baseUrl: 'http://svc' })
    const other = Buffer.from('abcdefghij')
    const staleFile = join(workspaceDir, 'stale.mp4')
    await writeFile(staleFile, other)
    await writeFile(
      join(workspaceDir, '.ivideo-final-index.json'),
      JSON.stringify({
        [key]: {
          path: staleFile,
          sha256: createHash('sha256').update(other).digest('hex'),
          size: other.length
        }
      })
    )
    await service.downloadArtifact({ sessionId: 's1', run: 'r1', path: FINAL_PATH })
    expect(downloadCalls).toHaveLength(1)
  })

  it('merges concurrent calls for the same scope into a single download', async () => {
    const [a, b] = await Promise.all([
      service.downloadArtifact({ sessionId: 's1', run: 'r1', path: FINAL_PATH }),
      service.downloadArtifact({ sessionId: 's1', run: 'r1', path: FINAL_PATH })
    ])
    expect(downloadCalls).toHaveLength(1)
    expect(a.filePath).toBe(b.filePath)
  })
})
