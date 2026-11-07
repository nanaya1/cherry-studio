import { createHmac } from 'node:crypto'

import { net } from 'electron'
import type { Mock, Mocked } from 'vitest'

import { BaseService } from '@main/core/lifecycle'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'
import type { IndustrialVideoProductionRecord } from '@shared/data/cache/cacheValueTypes'

import type { IndustrialVideoClient, IndustrialVideoError, IndustrialVideoResult } from './IndustrialVideoClient'
import type { IndustrialVideoDownloadErrorCode } from './IndustrialVideoDownload'
import type { IndustrialVideoDownloader } from './IndustrialVideoDownload'
import { type IndustrialVideoDownloadResult } from './IndustrialVideoDownload'
import { IndustrialVideoService } from './IndustrialVideoService'

// Spy used in place of the trusted WorkspaceService: asserts the real workspace path
// is resolved by the main process (never a renderer-supplied directory).
const getWorkspacePathSpy = vi.fn((id: string) => {
  void id
  return '/abs/workspace'
})

function makeFakeDownloader(result: IndustrialVideoDownloadResult): IndustrialVideoDownloader {
  return { downloadArtifact: vi.fn(async () => result) } as unknown as IndustrialVideoDownloader
}
function okDownload(filePath = '/abs/workspace/movie.mp4', size = 123): IndustrialVideoDownloadResult {
  return { ok: true, requestId: 'dl-1', filePath, size, status: 200 }
}
function failDownload(
  code: IndustrialVideoDownloadErrorCode = 'network',
  message = 'boom',
  outcomeUnknown = true
): IndustrialVideoDownloadResult {
  return {
    ok: false,
    requestId: 'dl-1',
    error: { category: 'download', requestId: 'dl-1', code, message, outcomeUnknown }
  }
}

// ── Test doubles ────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<AgentSessionEntity> = {}): AgentSessionEntity {
  return {
    id: 's1',
    featureKind: 'industrial-video',
    workspaceId: 'ws1',
    ...overrides
  } as AgentSessionEntity
}

function ok<T>(data: T, requestId = 'req-ok'): IndustrialVideoResult<T> {
  return { ok: true, requestId, data }
}

function fail(over: Partial<IndustrialVideoError> = {}): IndustrialVideoResult<never> {
  return {
    ok: false,
    requestId: 'req-err',
    error: {
      category: 'http',
      operation: 'video_start',
      requestId: 'req-err',
      message: 'boom',
      status: 500,
      outcomeUnknown: true,
      ...over
    }
  }
}

function makeClient(overrides: Partial<Record<keyof IndustrialVideoClient, unknown>> = {}) {
  const client = {
    runCreate: vi.fn(async () => ok({ run: 'r1' })),
    videoStart: vi.fn(async () => ok({ job_id: 'j1' })),
    planningContextGet: vi.fn(async () => ok({ input_fingerprint: 'fp', expected_storyboard_sha256: '' })),
    storyboardGet: vi.fn(async () => ok({ video_title: 't' })),
    storyboardSubmit: vi.fn(async () => ok({ submitted: true, review_required: false })),
    estimate: vi.fn(async () => ok({ estimate: { fee: 10 } })),
    jobGet: vi.fn(async () => ok({ run: 'r1', status: 'done' })),
    jobList: vi.fn(async () => ok({ jobs: [] })),
    jobCancel: vi.fn(async () => ok({ canceled: true })),
    sceneRetry: vi.fn(async () => ok({ retried: 1 })),
    qaGet: vi.fn(async () => ok({ delivery_status: 'passed' })),
    previewCreate: vi.fn(async () => ok({ preview_url: 'http://p' })),
    artifactRead: vi.fn(async () => ok({ type: 'text', content: 'hello' })),
    mediaUpload: vi.fn(async (p: { name?: string }) => ok({ name: p.name ?? 'm.png' })),
    logoUpload: vi.fn(async (p: { name?: string }) => ok({ name: p.name ?? 'l.png' })),
    capabilitiesGet: vi.fn(async () => ok({})),
    ...overrides
  } as unknown as Mocked<IndustrialVideoClient> & { [K: string]: Mock }
  return client
}

function makeService(
  client: IndustrialVideoClient,
  sessionOrFn: AgentSessionEntity | (() => AgentSessionEntity),
  opts: {
    downloadResult?: IndustrialVideoDownloadResult
    workspacePath?: string
    reviewActor?: string | null
    localActorStore?: { value: string }
    rejectEnterprise?: boolean
  } = {}
) {
  // Each service instance is guarded by BaseService's singleton; reset so a new
  // instance can be constructed for every test double (one per logical session).
  BaseService.resetInstances()
  const store: Record<string, unknown> = {}
  const service = new IndustrialVideoService()
  const getSession = typeof sessionOrFn === 'function' ? sessionOrFn : () => sessionOrFn
  service.setTestDeps({
    resolveConfig: () => ({ baseUrl: 'http://svc', token: 't', timeoutMs: 1000 }),
    getSession,
    createClient: () => client,
    getPersist: (key: string) => (store[key] ?? {}) as Record<string, IndustrialVideoProductionRecord>,
    setPersist: (key: string, value: unknown) => {
      store[key] = value
    },
    getWorkspacePath: (id: string) => opts.workspacePath ?? getWorkspacePathSpy(id),
    createDownloader: () => makeFakeDownloader(opts.downloadResult ?? okDownload()),
    getReviewActor: async () => {
      if (opts.rejectEnterprise) throw new Error('本地模式不得调用企业认证')
      return opts.reviewActor ?? null
    },
    getLocalReviewActor: () => opts.localActorStore?.value ?? (store['industrial_video.local_actor'] as string) ?? '',
    setLocalReviewActor: (actor) => {
      if (opts.localActorStore) opts.localActorStore.value = actor
      store['industrial_video.local_actor'] = actor
    }
  })
  return { service, store }
}

// ── Suite ───────────────────────────────────────────────────────────────────────

describe('IndustrialVideoService', () => {
  let client: ReturnType<typeof makeClient>
  let session: AgentSessionEntity

  beforeEach(() => {
    BaseService.resetInstances()
    getWorkspacePathSpy.mockClear()
    client = makeClient()
    session = makeSession()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  describe('config & session validation', () => {
    it('reports configured/unconfigured via injected resolver', () => {
      const { service } = makeService(client, session)
      service.setTestDeps({ resolveConfig: () => null })
      expect(service.configStatus()).toEqual({ configured: false })
      service.setTestDeps({ resolveConfig: () => ({ baseUrl: 'x', token: 'y', timeoutMs: 1 }) })
      expect(service.configStatus()).toEqual({ configured: true })
    })

    it('rejects a missing / wrong-feature-kind / no-workspace session', async () => {
      const missing = makeService(client, () => {
        throw new Error('not found')
      })
      await expect(missing.service.parse({ sessionId: 's1', run: 'r1' })).rejects.toMatchObject({
        code: 'IVIDEO_SESSION_INVALID'
      })
      const bad = makeService(client, makeSession({ featureKind: 'chat' as never }))
      await expect(bad.service.runCreate({ sessionId: 's1', baseName: 'b' })).rejects.toMatchObject({
        code: 'IVIDEO_SESSION_INVALID'
      })
      const noWs = makeService(client, makeSession({ workspaceId: null as never }))
      await expect(noWs.service.runCreate({ sessionId: 's1', baseName: 'b' })).rejects.toMatchObject({
        code: 'IVIDEO_SESSION_INVALID'
      })
    })
  })

  describe('可信审核授权边界', () => {
    it('本地模式无需企业登录，并跨服务重建复用同一审核身份', async () => {
      vi.stubEnv('IVIDEO_REVIEW_IDENTITY_MODE', 'local')
      vi.stubEnv('IVIDEO_REVIEW_HOST_SECRET', 'review-secret')
      const localActorStore = { value: '' }
      const actors: string[] = []
      const reviewSnapshotGet = vi.fn(async ({ host_assertion }: { host_assertion: string }) => {
        actors.push(JSON.parse(Buffer.from(host_assertion.split('.')[0], 'base64url').toString()).actor)
        return ok({ review_version: 'v1', generation_allowed: false, remaining_blockers: [] })
      })
      const reviewConfirm = vi.fn(async (params: { host_assertion: string; expected_review_version: string }) => {
        const claims = JSON.parse(Buffer.from(params.host_assertion.split('.')[0], 'base64url').toString())
        expect(claims.actor).toBe(localActorStore.value)
        expect(claims.permissions).toEqual(['review:confirm'])
        expect(params.expected_review_version).toBe('v1')
        return ok({ review_version: 'v1', generation_allowed: true, remaining_blockers: [] })
      })
      for (let i = 0; i < 2; i++) {
        const { service } = makeService(makeClient({ reviewSnapshotGet, reviewConfirm }), session, {
          localActorStore,
          rejectEnterprise: true
        })
        await service.runCreate({ sessionId: 's1', baseName: 'demo' })
        await service.reviewSnapshotGet({ sessionId: 's1', run: 'r1' })
        expect(service.getPendingReviewSnapshot({ sessionId: 's1' })).toEqual({ run: 'r1', reviewVersion: 'v1' })
        expect(await service.reviewConfirm({ sessionId: 's1', run: 'r1', expectedReviewVersion: 'v1' })).toMatchObject({
          generation_allowed: true
        })
        expect(service.getConfirmedReview({ sessionId: 's1' })).toEqual({ run: 'r1', reviewVersion: 'v1' })
      }
      expect(actors[0]).toMatch(/^local:[0-9a-f-]{36}$/)
      expect(actors).toEqual([localActorStore.value, localActorStore.value])
    })

    it('企业模式没有登录时不会降级成本地身份', async () => {
      vi.stubEnv('IVIDEO_REVIEW_IDENTITY_MODE', 'enterprise')
      vi.stubEnv('IVIDEO_REVIEW_HOST_SECRET', 'review-secret')
      const { service, store } = makeService(client, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await expect(service.reviewSnapshotGet({ sessionId: 's1', run: 'r1' })).rejects.toMatchObject({
        code: 'IVIDEO_REVIEW_AUTH_UNAVAILABLE',
        message: expect.stringContaining('企业账号')
      })
      expect(store['industrial_video.local_actor']).toBeUndefined()
    })

    it('缺少密钥时提示具体配置项，且不生成本地身份', async () => {
      vi.stubEnv('IVIDEO_REVIEW_IDENTITY_MODE', 'local')
      vi.stubEnv('IVIDEO_REVIEW_HOST_SECRET', '')
      const { service, store } = makeService(client, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await expect(service.reviewSnapshotGet({ sessionId: 's1', run: 'r1' })).rejects.toMatchObject({
        code: 'IVIDEO_REVIEW_AUTH_UNAVAILABLE',
        message: expect.stringContaining('IVIDEO_REVIEW_HOST_SECRET')
      })
      expect(store['industrial_video.local_actor']).toBeUndefined()
    })

    const input = { sessionId: 's1', run: 'r1', reviewType: 'script_and_storyboard' as const }
    const receipt = { review_version: 'v1', generation_allowed: false, remaining_blockers: ['qa'] }

    it('使用主进程密钥签发短期最小权限声明，actor 取可信登录会话', async () => {
      vi.stubEnv('IVIDEO_REVIEW_HOST_SECRET', 'review-secret')
      vi.spyOn(Date, 'now').mockReturnValue(1_794_000_000_000)
      const reviewSnapshotGet = vi.fn(async (params: { host_assertion: string }) => {
        void params
        return ok({ ...receipt, script: '# 脚本', storyboard: {} })
      })
      const reviewConfirm = vi.fn(async (params: { host_assertion: string }) => {
        void params
        return ok(receipt)
      })
      client = makeClient({ reviewSnapshotGet, reviewConfirm })
      const { service } = makeService(client, session, { reviewActor: 'user-42' })
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })

      await service.reviewSnapshotGet(input)
      await service.reviewConfirm({ ...input, expectedReviewVersion: 'v1' })

      const assertions = [
        reviewSnapshotGet.mock.calls[0][0].host_assertion,
        reviewConfirm.mock.calls[0][0].host_assertion
      ]
      for (const [index, assertion] of assertions.entries()) {
        const [encoded, signature] = assertion.split('.')
        const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
        expect(claims).toEqual({
          aud: 'ivideo-review',
          actor: 'user-42',
          run: 'r1',
          exp: 1_794_000_300,
          permissions: [index === 0 ? 'review:read' : 'review:confirm']
        })
        expect(signature).toBe(createHmac('sha256', 'review-secret').update(encoded, 'ascii').digest('hex'))
      }
    })

    it.each(['reviewSnapshotGet', 'reviewConfirm'] as const)('默认授权未接通时 %s 不发 HTTP', async (method) => {
      const reviewSnapshotGet = vi.fn()
      const reviewConfirm = vi.fn()
      client = makeClient({ reviewSnapshotGet, reviewConfirm })
      const { service, store } = makeService(client, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      const before = structuredClone(store)
      vi.mocked(net.fetch).mockClear()
      await expect(service[method]({ ...input, expectedReviewVersion: 'v1' })).rejects.toMatchObject({
        code: 'IVIDEO_REVIEW_AUTH_UNAVAILABLE',
        message: expect.stringContaining('未接通可信身份签发')
      })
      expect(net.fetch).not.toHaveBeenCalled()
      expect(reviewSnapshotGet).not.toHaveBeenCalled()
      expect(reviewConfirm).not.toHaveBeenCalled()
      expect(store).toEqual(before)
    })

    it.each(['other-run', null])('拒绝其他 run 或空归属 %s，且不请求授权', async (run) => {
      const { service, store } = makeService(client, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      ;(store['industrial_video.records'] as Record<string, IndustrialVideoProductionRecord>).s1.run = run
      const authorize = vi.fn(async () => 'trusted-assertion')
      service.setReviewAuthorizationProvider({ authorize })
      for (const method of ['reviewSnapshotGet', 'reviewConfirm'] as const) {
        await expect(service[method]({ ...input, expectedReviewVersion: 'v1' })).rejects.toMatchObject({
          code: 'IVIDEO_RUN_INVALID'
        })
      }
      expect(authorize).not.toHaveBeenCalled()
    })

    it('可信provider按操作获取声明，版本原样转发，不启动生成也不改制作记录', async () => {
      const reviewSnapshotGet = vi.fn(async () => ok({ ...receipt, script: '# 脚本', storyboard: {} }))
      const reviewConfirm = vi.fn(async () => ok(receipt))
      client = makeClient({ reviewSnapshotGet, reviewConfirm })
      const { service, store } = makeService(client, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      const before = structuredClone(store)
      const authorize = vi.fn(async () => 'trusted-assertion')
      service.setReviewAuthorizationProvider({ authorize })
      await service.reviewSnapshotGet(input)
      expect(await service.reviewConfirm({ ...input, expectedReviewVersion: ' v1 ' })).toEqual(receipt)
      expect(authorize.mock.calls).toEqual([
        [{ ...input, workspaceId: 'ws1', operation: 'review_snapshot_get' }],
        [{ ...input, workspaceId: 'ws1', operation: 'review_confirm', expectedReviewVersion: ' v1 ' }]
      ])
      expect(reviewConfirm).toHaveBeenCalledWith({
        run: 'r1',
        host_assertion: 'trusted-assertion',
        review_type: 'script_and_storyboard',
        expected_review_version: ' v1 '
      })
      expect(client.videoStart).not.toHaveBeenCalled()
      expect(store).toEqual(before)
    })

    it('空声明拒绝，provider失败不降级为服务token', async () => {
      const { service } = makeService(client, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      service.setReviewAuthorizationProvider({ authorize: async () => ' ' })
      await expect(service.reviewSnapshotGet(input)).rejects.toMatchObject({ code: 'IVIDEO_REVIEW_AUTH_UNAVAILABLE' })
      service.setReviewAuthorizationProvider({
        authorize: async () => {
          throw new Error('identity unavailable')
        }
      })
      await expect(service.reviewConfirm({ ...input, expectedReviewVersion: 'v1' })).rejects.toThrow(
        'identity unavailable'
      )
    })

    it('确认冲突仅返回服务错误，不自动重读、重试或启动生成', async () => {
      const reviewConfirm = vi.fn(async () =>
        fail({ operation: 'review_confirm', status: 409, code: 'review_version_conflict', outcomeUnknown: false })
      )
      client = makeClient({ reviewConfirm })
      const { service, store } = makeService(client, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      const before = structuredClone(store)
      service.setReviewAuthorizationProvider({ authorize: async () => 'trusted-assertion' })
      await expect(service.reviewConfirm({ ...input, expectedReviewVersion: 'old' })).rejects.toMatchObject({
        code: 'IVIDEO_HTTP_ERROR',
        data: expect.objectContaining({ status: 409, code: 'review_version_conflict', outcomeUnknown: false })
      })
      expect(reviewConfirm).toHaveBeenCalledTimes(1)
      expect(client.videoStart).not.toHaveBeenCalled()
      expect(store).toEqual(before)
    })
  })

  describe('run ownership', () => {
    it('取消解析任务后仍保留当前run，允许查询分镜与产物', async () => {
      const { service } = makeService(client, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      const { jobId } = await service.parse({ sessionId: 's1', run: 'r1' })
      await service.jobCancel({ sessionId: 's1', jobId })
      expect(service.getRecords({ sessionId: 's1' })).toMatchObject({ run: 'r1', state: 'canceled' })
      await expect(service.storyboardGet({ sessionId: 's1', run: 'r1' })).resolves.toBeDefined()
    })
    it('run_create seeds the run and a v1 production-version round', async () => {
      const { service, store } = makeService(client, session)
      const { run } = await service.runCreate({ sessionId: 's1', baseName: 'demo', prefix: 'p' })
      expect(run).toBe('r1')
      const rec = (store['industrial_video.records'] as any).s1
      expect(rec.run).toBe('r1')
      expect(rec.version).toBe(1)
      expect(rec.rounds.at(-1)).toMatchObject({ version: 1, operation: 'run_create', run: 'r1', outcome: 'ok' })
    })

    it('parse before run_create is rejected (no run belongs to session)', async () => {
      const { service } = makeService(client, session)
      await expect(service.parse({ sessionId: 's1', run: 'rX' })).rejects.toMatchObject({
        code: 'IVIDEO_RUN_INVALID'
      })
    })

    it('parse with a run that does not belong to the session is rejected', async () => {
      const { service, store } = makeService(client, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      // tamper the record to a different run
      const rec = (store['industrial_video.records'] as any).s1
      rec.run = 'other-run'
      await expect(service.parse({ sessionId: 's1', run: 'r1' })).rejects.toMatchObject({
        code: 'IVIDEO_RUN_INVALID'
      })
    })
  })

  describe('reads must not mutate production state', () => {
    it('planning_context_get / storyboard_get / qa_get / artifact_read / job_list append no round and never change state', async () => {
      const { service, store } = makeService(client, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await service.parse({ sessionId: 's1', run: 'r1', texts: [{ text: 'x' }] })
      const before = JSON.parse(JSON.stringify((store['industrial_video.records'] as any).s1))

      await service.planningContextGet({ sessionId: 's1', run: 'r1' })
      await service.storyboardGet({ sessionId: 's1', run: 'r1' })
      await service.qaGet({ sessionId: 's1', run: 'r1' })
      await service.artifactRead({ sessionId: 's1', run: 'r1', path: 'status.json' })
      await service.jobList({ sessionId: 's1' })

      const after = (store['industrial_video.records'] as any).s1
      expect(after.rounds.length).toBe(before.rounds.length)
      expect(after.state).toBe(before.state)
      expect(after.version).toBe(before.version)
      expect(after.run).toBe(before.run)
      expect(after.jobId).toBe(before.jobId)
    })
  })

  describe('estimate (estimate_only) returns a non-job result and changes nothing', () => {
    it('returns the estimate, requires no job_id, and persists no round / state change', async () => {
      const { service, store } = makeService(client, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      // estimate must not need a job_id
      const { estimate } = await service.estimate({ sessionId: 's1', run: 'r1' })
      expect(estimate).toEqual({ fee: 10 })
      expect(client.estimate).toHaveBeenCalledWith(expect.objectContaining({ run: 'r1' }))
      expect(client.estimate).not.toHaveBeenCalledWith(expect.objectContaining({ job_id: expect.anything() }))
      const rec = (store['industrial_video.records'] as any).s1
      const before = rec.rounds.length
      expect(rec.rounds.length).toBe(before) // estimate appended no round
      expect(rec.jobId).toBeNull()
    })
  })

  describe('timeout / 5xx / invalid-success are not retried and persist unknown', () => {
    async function causeUnknown(category: Partial<IndustrialVideoError>) {
      const c = makeClient({ videoStart: vi.fn(async () => fail(category)) })
      const { service, store } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await expect(service.videoStart({ sessionId: 's1', run: 'r1' })).rejects.toMatchObject({
        code: 'IVIDEO_HTTP_ERROR'
      })
      return { c, store }
    }

    it('timeout outcome is persisted as unknown, never retried', async () => {
      const { c, store } = await causeUnknown({ category: 'timeout', status: undefined, outcomeUnknown: true })
      expect(c.videoStart).toHaveBeenCalledTimes(1)
      const rec = (store['industrial_video.records'] as any).s1
      expect(rec.rounds.at(-1).outcome).toBe('unknown')
      expect(rec.unknownSubmissions.length).toBe(1)
    })

    it('5xx outcome is persisted as unknown', async () => {
      const { store } = await causeUnknown({ category: 'http', status: 500, outcomeUnknown: true })
      const rec = (store['industrial_video.records'] as any).s1
      expect(rec.rounds.at(-1).outcome).toBe('unknown')
      expect(rec.unknownSubmissions.length).toBe(1)
    })

    it('invalid-success (200 but missing job_id → validation) is persisted as unknown', async () => {
      const c = makeClient({
        videoStart: vi.fn(async () => fail({ category: 'validation', status: undefined, outcomeUnknown: false }))
      })
      const { service, store } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await expect(service.videoStart({ sessionId: 's1', run: 'r1' })).rejects.toMatchObject({
        code: 'IVIDEO_HTTP_ERROR'
      })
      const rec = (store['industrial_video.records'] as any).s1
      expect(rec.rounds.at(-1).outcome).toBe('unknown')
    })

    it('a non-unknown http error (4xx) fails without persisting unknown and flags failed state', async () => {
      const c = makeClient({
        videoStart: vi.fn(async () => fail({ category: 'http', status: 400, outcomeUnknown: false }))
      })
      const { service, store } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await expect(service.videoStart({ sessionId: 's1', run: 'r1' })).rejects.toMatchObject({
        code: 'IVIDEO_HTTP_ERROR'
      })
      const rec = (store['industrial_video.records'] as any).s1
      expect(rec.rounds.at(-1).outcome).toBe('error')
      expect(rec.unknownSubmissions.length).toBe(0)
      expect(rec.state).toBe('failed')
    })

    it('a persisted unknown blocks the next submission until reconciled', async () => {
      const c = makeClient({ videoStart: vi.fn(async () => fail({ category: 'timeout', outcomeUnknown: true })) })
      const { service } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await expect(service.videoStart({ sessionId: 's1', run: 'r1' })).rejects.toMatchObject({
        code: 'IVIDEO_HTTP_ERROR'
      })
      await expect(service.videoStart({ sessionId: 's1', run: 'r1' })).rejects.toMatchObject({
        code: 'IVIDEO_SUBMISSION_UNKNOWN'
      })
    })
  })

  describe('reconciliation via job_list + job_get (never auto-claim by run)', () => {
    it('job_get reconciles an unknown submission when the server confirms the job belongs to our run', async () => {
      const c = makeClient({
        videoStart: vi
          .fn()
          .mockImplementationOnce(async () => fail({ category: 'timeout', outcomeUnknown: true }))
          .mockImplementationOnce(async () => ok({ job_id: 'j2' })),
        // discovered via job_list; its `run` matches our record.run
        jobGet: vi.fn(async () => ok({ run: 'r1', status: 'done', job_id: 'jX' }))
      })
      const { service, store } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await expect(service.videoStart({ sessionId: 's1', run: 'r1' })).rejects.toMatchObject({
        code: 'IVIDEO_HTTP_ERROR'
      })
      // before reconcile: blocked
      await expect(service.videoStart({ sessionId: 's1', run: 'r1' })).rejects.toMatchObject({
        code: 'IVIDEO_SUBMISSION_UNKNOWN'
      })

      const data = await service.jobGet({ sessionId: 's1', jobId: 'jX' })
      expect(data.status).toBe('done')
      const rec = (store['industrial_video.records'] as any).s1
      expect(rec.unknownSubmissions.length).toBe(0)
      expect(rec.jobId).toBe('jX')
      expect(rec.state).toBe('done')
      // now a new submit is allowed
      await expect(service.videoStart({ sessionId: 's1', run: 'r1' })).resolves.toMatchObject({ jobId: 'j2' })
    })

    it('job_get for a job whose run does NOT match ours does not mutate state or clear unknowns', async () => {
      const c = makeClient({
        videoStart: vi.fn(async () => fail({ category: 'timeout', outcomeUnknown: true })),
        jobGet: vi.fn(async () => ok({ run: 'someone-else', status: 'done', job_id: 'jX' }))
      })
      const { service, store } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await expect(service.videoStart({ sessionId: 's1', run: 'r1' })).rejects.toMatchObject({
        code: 'IVIDEO_HTTP_ERROR'
      })
      await service.jobGet({ sessionId: 's1', jobId: 'jX' })
      const rec = (store['industrial_video.records'] as any).s1
      expect(rec.unknownSubmissions.length).toBe(1)
      expect(rec.jobId).toBeNull()
    })
  })

  describe('job_get updates authoritative state but never cancels on exit', () => {
    it('maps job status to production state and does not send a cancel', async () => {
      const c = makeClient({ jobGet: vi.fn(async () => ok({ run: 'r1', status: 'queued' })) })
      const { service, store } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await service.parse({ sessionId: 's1', run: 'r1', texts: [{ text: 'x' }] }) // job j1, state parsing
      await service.jobGet({ sessionId: 's1', jobId: 'j1' })
      expect((store['industrial_video.records'] as any).s1.state).toBe('generating')
      expect(c.jobCancel).not.toHaveBeenCalled()
    })

    it('canceled job status is reflected as canceled without re-canceling', async () => {
      const c = makeClient({ jobGet: vi.fn(async () => ok({ run: 'r1', status: 'canceled', job_id: 'j1' })) })
      const { service, store } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await service.parse({ sessionId: 's1', run: 'r1', texts: [{ text: 'x' }] })
      await service.jobGet({ sessionId: 's1', jobId: 'j1' })
      expect((store['industrial_video.records'] as any).s1.state).toBe('canceled')
      expect(c.jobCancel).not.toHaveBeenCalled()
    })
  })

  describe('job listing does not auto-claim', () => {
    it('returns the list and changes no production state', async () => {
      const c = makeClient({ jobList: vi.fn(async () => ok({ jobs: [{ job_id: 'j9', run: 'r1' }] })) })
      const { service, store } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      const data = await service.jobList({ sessionId: 's1', limit: 5 })
      expect(data).toEqual({ jobs: [{ job_id: 'j9', run: 'r1' }] })
      const rec = (store['industrial_video.records'] as any).s1
      expect(rec.state).toBe('idle')
      expect(rec.unknownSubmissions.length).toBe(0)
    })
  })

  describe('user-initiated job_cancel', () => {
    it('requires the job to belong to the session', async () => {
      const { service } = makeService(client, session)
      await expect(service.jobCancel({ sessionId: 's1', jobId: 'foreign' })).rejects.toMatchObject({
        code: 'IVIDEO_JOB_INVALID'
      })
    })

    it('persists a cancellation round and moves to canceled without extra cancel calls', async () => {
      const { service, store } = makeService(client, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await service.parse({ sessionId: 's1', run: 'r1', texts: [{ text: 'x' }] }) // job j1
      await service.jobCancel({ sessionId: 's1', jobId: 'j1' })
      const rec = (store['industrial_video.records'] as any).s1
      expect(rec.state).toBe('canceled')
      expect(rec.rounds.at(-1)).toMatchObject({ operation: 'job_cancel', jobId: 'j1', outcome: 'ok' })
      // only the one explicit cancel was sent
      expect(client.jobCancel).toHaveBeenCalledTimes(1)
    })
  })

  describe('uploads only forward explicit base64 / handle (never an arbitrary url)', () => {
    it('media_upload forwards content_base64 + caption and no url', async () => {
      const { service } = makeService(client, session)
      const { name } = await service.mediaUpload({
        sessionId: 's1',
        caption: 'motor front',
        contentBase64: 'BASE64DATA',
        kind: 'image'
      })
      expect(name).toBe('m.png')
      expect(client.mediaUpload).toHaveBeenCalledWith(
        expect.objectContaining({ caption: 'motor front', content_base64: 'BASE64DATA', kind: 'image' })
      )
      expect(client.mediaUpload.mock.calls[0][0]).not.toHaveProperty('url')
    })

    it('logo_upload forwards content_base64 + brand_kind and no url', async () => {
      const { service } = makeService(client, session)
      await service.logoUpload({ sessionId: 's1', contentBase64: 'LOGODATA', brandKind: 'product' })
      expect(client.logoUpload).toHaveBeenCalledWith(
        expect.objectContaining({ content_base64: 'LOGODATA', brand_kind: 'product' })
      )
      expect(client.logoUpload.mock.calls[0][0]).not.toHaveProperty('url')
    })
  })

  describe('artifact_read returns the artifact payload', () => {
    it('returns type/content from the client', async () => {
      const { service } = makeService(client, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      const data = await service.artifactRead({ sessionId: 's1', run: 'r1', path: 'status.json', maxChars: 50 })
      expect(data).toEqual({ type: 'text', content: 'hello' })
      expect(client.artifactRead).toHaveBeenCalledWith(
        expect.objectContaining({ run: 'r1', path: 'status.json', max_chars: 50 })
      )
    })
  })

  describe('versioned rounds preserve run/job history', () => {
    it('each confirmed version is a round and the latest run/job stay recoverable', async () => {
      const { service, store } = makeService(client, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' }) // v1 run r1
      await service.parse({ sessionId: 's1', run: 'r1', texts: [{ text: 'x' }] }) // v2 job j1
      await service.videoStart({ sessionId: 's1', run: 'r1' }) // v3 job j1 (same client default)
      const rec = (store['industrial_video.records'] as any).s1
      // run_create + parse + video_start each append an intended+ok pair => 6 rounds
      expect(rec.rounds.length).toBe(6)
      expect(rec.version).toBe(1)
      expect(rec.run).toBe('r1')
      // history: a round still carries the parse job j1
      const parseRound = rec.rounds.find((r: any) => r.operation === 'parse' && r.outcome === 'ok')
      expect(parseRound.run).toBe('r1')
      expect(parseRound.jobId).toBe('j1')
      expect(parseRound.version).toBe(1)
    })
  })

  describe('concurrency: same-session writes are mutually exclusive', () => {
    it('serializes two concurrent media_upload calls (no interleaving)', async () => {
      const events: string[] = []
      let counter = 0
      const c = makeClient({
        mediaUpload: vi.fn(async (p: { name?: string }) => {
          const id = counter++
          events.push(`start:${id}`)
          await new Promise((r) => setTimeout(r, 20))
          events.push(`end:${id}`)
          return ok({ name: p.name ?? 'm.png' })
        })
      })
      const { service } = makeService(c, session)
      await Promise.all([
        service.mediaUpload({ sessionId: 's1', caption: 'a', contentBase64: 'A' }),
        service.mediaUpload({ sessionId: 's1', caption: 'b', contentBase64: 'B' })
      ])
      expect(events).toEqual(['start:0', 'end:0', 'start:1', 'end:1'])
    })
  })

  describe('no fabricated server fields', () => {
    it('videoStart sends only allowed params (no duration/resolution/tts/music)', async () => {
      const { service } = makeService(client, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await service.videoStart({
        sessionId: 's1',
        run: 'r1',
        voice: 'zh-CN-XiaoxiaoNeural',
        aspectRatio: '16:9',
        style: 'marketing'
      })
      const body = client.videoStart.mock.calls[0][0]
      expect(body).toMatchObject({
        stage: 'video',
        run: 'r1',
        estimate_only: false,
        voice: 'zh-CN-XiaoxiaoNeural',
        aspect_ratio: '16:9',
        style: 'marketing'
      })
      for (const forbidden of ['duration', 'resolution', 'tts', 'music']) {
        expect(body).not.toHaveProperty(forbidden)
      }
    })
  })

  describe('downloadArtifact (controlled download, main-resolved workspace)', () => {
    it('rejects a missing / non-industrial-video / no-workspace session', async () => {
      const { service } = makeService(client, () => {
        throw new Error('not found')
      })
      await expect(service.downloadArtifact({ sessionId: 's1', run: 'r1', path: 'final/m.mp4' })).rejects.toMatchObject(
        {
          code: 'IVIDEO_SESSION_INVALID'
        }
      )
    })

    it('resolves the workspace dir from the trusted WorkspaceService (never the renderer) and returns the published file', async () => {
      const { service } = makeService(client, makeSession({ workspaceId: 'ws-xyz' }))
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      const result = await service.downloadArtifact({
        sessionId: 's1',
        run: 'r1',
        path: 'final/m.mp4',
        expectedSize: 10
      })
      expect(result).toEqual({ filePath: '/abs/workspace/movie.mp4', size: 123 })
      expect(getWorkspacePathSpy).toHaveBeenCalledWith('ws-xyz')
    })

    it('rejects when the run does not belong to the session', async () => {
      const { service, store } = makeService(client, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      const rec = (store['industrial_video.records'] as any).s1
      rec.run = 'other' // tamper so r1 no longer belongs
      await expect(service.downloadArtifact({ sessionId: 's1', run: 'r1', path: 'f/m.mp4' })).rejects.toMatchObject({
        code: 'IVIDEO_RUN_INVALID'
      })
    })

    it('maps a download failure to an IpcError without mutating production state', async () => {
      const { service, store } = makeService(client, session, {
        downloadResult: failDownload('network', 'boom', true)
      })
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      const before = JSON.parse(JSON.stringify((store['industrial_video.records'] as any).s1))
      await expect(service.downloadArtifact({ sessionId: 's1', run: 'r1', path: 'f/m.mp4' })).rejects.toMatchObject({
        code: 'IVIDEO_DOWNLOAD_FAILED'
      })
      const after = (store['industrial_video.records'] as any).s1
      expect(after.rounds.length).toBe(before.rounds.length)
      expect(after.state).toBe(before.state)
    })

    it('does not append a production round on success (download is not a state change)', async () => {
      const { service, store } = makeService(client, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      const before = (store['industrial_video.records'] as any).s1.rounds.length
      const result = await service.downloadArtifact({ sessionId: 's1', run: 'r1', path: 'f/m.mp4' })
      expect(result).toEqual({ filePath: '/abs/workspace/movie.mp4', size: 123 })
      const after = (store['industrial_video.records'] as any).s1
      expect(after.rounds.length).toBe(before)
      expect(after.state).toBe('idle')
    })
  })

  describe('contract: settings submission + effective_settings receipt (§17)', () => {
    function effectiveVideoStartClient() {
      return makeClient({
        videoStart: vi.fn(async () =>
          ok({
            job_id: 'j1',
            effective_settings: {
              settings_version: 2,
              target_duration_s: 60,
              resolution: '1080P',
              aspect_ratio: '16:9',
              tts_enabled: true,
              subtitle_enabled: false,
              background_music_enabled: true,
              with_audio: false,
              voice: 'zh-CN-YunxiNeural',
              output: { width: 1920, height: 1080, composition: 'landscape' }
            },
            settings_persisted: true,
            settings_changed: true,
            requires_replan: false,
            approval_invalidated: true
          })
        )
      })
    }

    it('video_start forwards the camelCase settings as snake_case and returns effectiveSettings/settingsVersion + receipt flags', async () => {
      const c = effectiveVideoStartClient()
      const { service } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      const res = await service.videoStart({
        sessionId: 's1',
        run: 'r1',
        voice: 'zh-CN-YunxiNeural',
        targetDurationS: 60,
        resolution: '1080P',
        ttsEnabled: true,
        subtitleEnabled: false,
        backgroundMusicEnabled: true,
        withAudio: false,
        expectedSettingsVersion: 1
      })

      expect(c.videoStart).toHaveBeenCalledWith(
        expect.objectContaining({
          run: 'r1',
          stage: 'video',
          voice: 'zh-CN-YunxiNeural',
          target_duration_s: 60,
          resolution: '1080P',
          tts_enabled: true,
          subtitle_enabled: false,
          background_music_enabled: true,
          with_audio: false,
          expected_settings_version: 1
        })
      )
      expect(res).toMatchObject({
        jobId: 'j1',
        settingsVersion: 2,
        effectiveSettings: { settings_version: 2, target_duration_s: 60, resolution: '1080P' },
        settingsPersisted: true,
        settingsChanged: true,
        requiresReplan: false,
        approvalInvalidated: true
      })
    })

    it('estimate forwards settings and returns effectiveSettings/settingsVersion (no job_id required)', async () => {
      const c = makeClient({
        estimate: vi.fn(async () =>
          ok({
            estimate: { fee: 10 },
            effective_settings: { settings_version: 1, target_duration_s: 30, resolution: '1080P' },
            settings_persisted: false,
            settings_changed: false
          })
        )
      })
      const { service } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      const res = await service.estimate({
        sessionId: 's1',
        run: 'r1',
        ttsEnabled: true,
        expectedSettingsVersion: 0
      })
      expect(c.estimate).toHaveBeenCalledWith(
        expect.objectContaining({ run: 'r1', tts_enabled: true, expected_settings_version: 0 })
      )
      expect(res).toMatchObject({
        estimate: { fee: 10 },
        settingsVersion: 1,
        effectiveSettings: { settings_version: 1, target_duration_s: 30 }
      })
    })

    it('parse forwards planning settings so the planning context can derive duration ratios', async () => {
      const c = makeClient({
        videoStart: vi.fn(async () =>
          ok({ job_id: 'j1', effective_settings: { settings_version: 1, target_duration_s: 90, resolution: '720P' } })
        )
      })
      const { service } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      const res = await service.parse({
        sessionId: 's1',
        run: 'r1',
        texts: [{ text: 'x' }],
        voice: 'zh-CN-YunxiNeural',
        targetDurationS: 90,
        resolution: '720P',
        ttsEnabled: true,
        subtitleEnabled: true,
        backgroundMusicEnabled: false,
        expectedSettingsVersion: 0
      })
      expect(c.videoStart).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'parse',
          run: 'r1',
          voice: 'zh-CN-YunxiNeural',
          target_duration_s: 90,
          resolution: '720P',
          tts_enabled: true,
          subtitle_enabled: true,
          background_music_enabled: false,
          expected_settings_version: 0
        })
      )
      expect(res).toMatchObject({ jobId: 'j1', settingsVersion: 1 })
    })

    it('omits settings that are not provided (server inherits current settings)', async () => {
      const c = effectiveVideoStartClient()
      const { service } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await service.videoStart({ sessionId: 's1', run: 'r1' })
      expect(c.videoStart).toHaveBeenCalledWith(
        expect.not.objectContaining({
          target_duration_s: expect.anything(),
          resolution: expect.anything(),
          tts_enabled: expect.anything()
        })
      )
    })
  })

  describe('contract: industrial_video.upload (raw bytes, no production-record change)', () => {
    it('forwards raw bytes to /upload via the client and returns { name }', async () => {
      const c = makeClient({
        upload: vi.fn(async (p: { name?: string }) => ok({ name: p.name ?? 'returned.png' }))
      })
      const { service } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      const content = new Uint8Array([1, 2, 3, 4])
      const res = await service.upload({ sessionId: 's1', name: 'front.png', content })
      expect(res).toEqual({ name: 'front.png' })
      expect(c.upload).toHaveBeenCalledWith(expect.objectContaining({ name: 'front.png', content }))
    })

    it('does NOT append a production round or change state (upload is not a versioned submission)', async () => {
      const c = makeClient({
        upload: vi.fn(async (p: { name?: string }) => ok({ name: p.name ?? 'returned.png' }))
      })
      const { service, store } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      const before = JSON.parse(JSON.stringify((store['industrial_video.records'] as any).s1))
      await service.upload({ sessionId: 's1', name: 'front.png', content: new Uint8Array([1]) })
      const after = (store['industrial_video.records'] as any).s1
      expect(after.rounds.length).toBe(before.rounds.length)
      expect(after.state).toBe(before.state)
      expect(after.version).toBe(before.version)
    })

    it('upload failures surface a structured IpcError and do not create a record', async () => {
      const c = makeClient({
        upload: vi.fn(async () => fail({ category: 'http', status: 413, outcomeUnknown: false }))
      })
      const { service, store } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await expect(
        service.upload({ sessionId: 's1', name: 'big.bin', content: new Uint8Array([1]) })
      ).rejects.toMatchObject({ code: 'IVIDEO_HTTP_ERROR' })
      expect((store['industrial_video.records'] as any).s1.unknownSubmissions.length).toBe(0)
    })
  })
})
