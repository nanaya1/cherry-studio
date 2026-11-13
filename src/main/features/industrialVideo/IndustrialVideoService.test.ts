import { createHmac } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { net } from 'electron'
import iconv from 'iconv-lite'
import type { Mock, Mocked } from 'vitest'

import { BaseService } from '@main/core/lifecycle'
import { decodeTextWithAutoEncoding } from '@main/utils/legacyFile'
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
  } = {},
  extraDeps: Record<string, unknown> = {}
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
    },
    ...extraDeps
  })
  return { service, store }
}

describe('工业视频可信轮次释放', () => {
  it('仅澄清未制作的轮次结束后可再次发送，旧轮回调不能释放新轮', () => {
    const { service } = makeService(makeClient(), makeSession())
    const token = service.beginRound({ sessionId: 's1' })
    service.releaseRound(token)
    expect(service.getRecords({ sessionId: 's1' })?.control).toEqual({
      epoch: token.epoch,
      phase: 'idle',
      stopRequested: false
    })
    expect(() => service.assertExecution(token)).toThrow('当前执行权限已失效')
    const next = service.beginRound({ sessionId: 's1' })
    expect(() => service.assertExecution(token)).toThrow('当前执行权限已失效')
    service.releaseRound(token)
    expect(service.getRecords({ sessionId: 's1' })?.control?.epoch).toBe(next.epoch)
    expect(service.getRecords({ sessionId: 's1' })?.control?.phase).toBe('active')
  })

  it('释放后旧工具回调不能在空闲期或新轮复活', async () => {
    const client = makeClient()
    const { service } = makeService(client, makeSession())
    const token = service.beginRound({ sessionId: 's1' })
    service.releaseRound(token)
    await expect(
      service.withExecution(token, () => service.runCreate({ sessionId: 's1', baseName: '澄清' }))
    ).rejects.toThrow('当前执行权限已失效')
    service.beginRound({ sessionId: 's1' })
    await expect(
      service.withExecution(token, () => service.runCreate({ sessionId: 's1', baseName: '澄清' }))
    ).rejects.toThrow('当前执行权限已失效')
    expect(client.runCreate).not.toHaveBeenCalled()
  })

  it('请求仍在途时保留门禁，确认结束后才可释放', async () => {
    let resolve!: (value: IndustrialVideoResult<{ run: string }>) => void
    const client = makeClient({
      runCreate: vi.fn(
        () =>
          new Promise((done) => {
            resolve = done
          })
      )
    })
    const { service } = makeService(client, makeSession())
    const token = service.beginRound({ sessionId: 's1' })
    const pending = service.withExecution(token, () => service.runCreate({ sessionId: 's1', baseName: '澄清' }))
    await vi.waitFor(() => expect(client.runCreate).toHaveBeenCalled())
    service.releaseRound(token)
    expect(service.getRecords({ sessionId: 's1' })?.control?.phase).toBe('active')
    expect(() => service.beginRound({ sessionId: 's1' })).toThrow('尚未证实结束')
    resolve(ok({ run: 'r1' }))
    await pending
    service.releaseRound(token)
    expect(() => service.beginRound({ sessionId: 's1' })).not.toThrow()
  })

  it('仅创建 run 未提交业务任务的轮次可以释放，不改变制作记录', async () => {
    const { service } = makeService(makeClient(), makeSession())
    const token = service.beginRound({ sessionId: 's1' })
    await service.withExecution(token, () => service.runCreate({ sessionId: 's1', baseName: '澄清' }))
    const before = structuredClone(service.getRecords({ sessionId: 's1' }))!
    service.releaseRound(token)
    expect(service.getRecords({ sessionId: 's1' })).toMatchObject({
      ...before,
      updatedAt: expect.any(Number),
      control: { ...before.control!, phase: 'idle' }
    })
    expect(() => service.beginRound({ sessionId: 's1' })).not.toThrow()
  })

  it.each(['ready', 'job', 'unknown', 'intended', 'old_epoch', 'stop', 'wrong_run', 'missing_receipt'])(
    '审核返回修改后的轮次释放：%s',
    async (condition) => {
      const { service } = makeService(makeClient(), makeSession())
      const token = service.beginRound({ sessionId: 's1' })
      await service.withExecution(token, async () => {
        await service.runCreate({ sessionId: 's1', baseName: '审核修改' })
        await service.parse({ sessionId: 's1', run: 'r1', texts: [{ text: '螺母' }] })
        await service.jobGet({ sessionId: 's1', jobId: 'j1' })
        await service.storyboardSubmit({
          sessionId: 's1',
          run: 'r1',
          storyboard: { video_title: '待修改' },
          expectedInputFingerprint: 'fp',
          expectedStoryboardSha256: ''
        })
      })
      const record = service.getRecords({ sessionId: 's1' })!
      expect(record).toMatchObject({ state: 'storyboard_submitted', jobId: null })
      const receipt = record.rounds.findLast((round) => round.operation === 'storyboard_submit')!
      if (condition === 'job') record.jobId = 'active-job'
      else if (condition === 'old_epoch') record.control!.epoch += 1
      else if (condition === 'stop') record.control!.stopRequested = true
      else if (condition === 'wrong_run') receipt.run = 'other-run'
      else if (condition === 'missing_receipt') record.rounds = []
      else if (condition === 'unknown' || condition === 'intended') {
        const unresolved: typeof receipt = {
          ...receipt,
          operation: 'parse',
          outcome: condition as 'unknown' | 'intended'
        }
        record.rounds.push(unresolved)
        if (condition === 'unknown') record.unknownSubmissions.push(unresolved)
      }
      const before = structuredClone(record)
      service.releaseRound(token)
      if (condition === 'ready') {
        expect(service.getRecords({ sessionId: 's1' })).toEqual({
          ...before,
          updatedAt: expect.any(Number),
          control: { ...before.control!, phase: 'idle' }
        })
        expect(() => service.assertExecution(token)).toThrow('当前执行权限已失效')
        expect(() => service.beginRound({ sessionId: 's1' })).not.toThrow()
      } else {
        expect(service.getRecords({ sessionId: 's1' })).toEqual(before)
        expect(() => service.beginRound({ sessionId: 's1' })).toThrow('尚未证实结束')
      }
    }
  )

  it.each([
    'job',
    'unknown',
    'intended',
    'parsing',
    'planning',
    'storyboard_submitted',
    'confirming',
    'generating',
    'assembling',
    // 'blocked', 'canceled' 已按最新终态契约放开新轮。
    'stop'
  ])('不释放业务活动或停止门禁：%s', (activity) => {
    const { service } = makeService(makeClient(), makeSession())
    const token = service.beginRound({ sessionId: 's1' })
    const record = service.getRecords({ sessionId: 's1' })!
    if (activity === 'job') record.jobId = 'j1'
    else if (activity === 'stop') record.control = { ...record.control!, stopRequested: true, phase: 'stopping' }
    else if (activity === 'unknown' || activity === 'intended') {
      const round: IndustrialVideoProductionRecord['rounds'][number] = {
        version: 1,
        operation: 'parse',
        run: null,
        jobId: null,
        state: 'parsing' as const,
        requestId: '',
        at: 0,
        // outcome: activity as 'unknown' | 'intended'
        outcome: activity
      }
      record.rounds.push(round)
      if (activity === 'unknown') record.unknownSubmissions.push(round)
    } else record.state = activity as IndustrialVideoProductionRecord['state']
    const before = structuredClone(record)
    service.releaseRound(token)
    expect(service.getRecords({ sessionId: 's1' })).toEqual(before)
    expect(() => service.beginRound({ sessionId: 's1' })).toThrow('尚未证实结束')
  })
})

describe('工业视频成片分镜提交保护', () => {
  const input = {
    sessionId: 's1',
    run: 'r1',
    storyboard: { video_title: '返修分镜' },
    expectedInputFingerprint: 'fp',
    expectedStoryboardSha256: 'sha'
  }

  it.each([false, true])('成片直接提交拒绝且不发出任何网络请求（可信轮次：%s）', async (trusted) => {
    const client = makeClient()
    const { service } = makeService(client, makeSession())
    await service.runCreate({ sessionId: 's1', baseName: '初版' })
    await service.videoStart({ sessionId: 's1', run: 'r1' })
    await service.jobGet({ sessionId: 's1', jobId: 'j1' })
    const token = trusted ? service.beginRound({ sessionId: 's1' }) : null
    const before = structuredClone(service.getRecords({ sessionId: 's1' }))
    vi.clearAllMocks()

    await expect(
      token ? service.withExecution(token, () => service.storyboardSubmit(input)) : service.storyboardSubmit(input)
    ).rejects.toMatchObject({
      code: 'IVIDEO_REVISION_REQUIRED',
      message: expect.stringMatching(/parse.*新\s*run.*重新审核/)
    })
    for (const method of Object.values(client)) expect(method).not.toHaveBeenCalled()
    expect(service.getRecords({ sessionId: 's1' })).toEqual(before)
  })

  it('parse 创建返修新 run 后可提交新分镜，旧 run 仍拒绝写入', async () => {
    const client = makeClient({ storyboardSubmit: vi.fn(async () => ok({ submitted: true, review_required: true })) })
    const { service } = makeService(client, makeSession())
    await service.runCreate({ sessionId: 's1', baseName: '初版' })
    await service.parse({ sessionId: 's1', run: 'r1', texts: [{ text: '原资料' }] })
    await service.jobGet({ sessionId: 's1', jobId: 'j1' })
    await service.videoStart({ sessionId: 's1', run: 'r1' })
    await service.jobGet({ sessionId: 's1', jobId: 'j1' })
    client.runCreate.mockResolvedValue(ok({ run: 'r2', raw: { run: 'r2' } }))
    const token = service.beginRound({ sessionId: 's1' })
    await service.withExecution(token, async () => {
      await service.prepareUserParts({ sessionId: 's1', parts: [{ type: 'text', text: '修改分镜' }] })
      await service.parse({ sessionId: 's1', run: 'r1' })
      expect(service.getRecords({ sessionId: 's1' })?.run).toBe('r2')
      vi.clearAllMocks()
      const before = structuredClone(service.getRecords({ sessionId: 's1' }))
      await expect(service.storyboardSubmit(input)).rejects.toMatchObject({ code: 'IVIDEO_RUN_INVALID' })
      for (const method of Object.values(client)) expect(method).not.toHaveBeenCalled()
      expect(service.getRecords({ sessionId: 's1' })).toEqual(before)
      // 下一次写入会再次查询，必须持续返回当前 run 的真实终态。
      client.jobGet.mockResolvedValue(ok({ run: 'r2', status: 'done' }))
      await service.jobGet({ sessionId: 's1', jobId: 'j1' })
      await expect(service.storyboardSubmit({ ...input, run: 'r2' })).resolves.toEqual({
        submitted: true,
        reviewRequired: true
      })
      expect(client.storyboardSubmit).toHaveBeenCalledExactlyOnceWith({
        run: 'r2',
        storyboard: input.storyboard,
        expected_input_fingerprint: 'fp',
        expected_storyboard_sha256: 'sha'
      })
    })
  })

  // 旧契约允许解析期间写入，现按任务终态串行。
  // it.each(['queued', 'running', 'processing'])('解析任务 %s 不应被误判为视频生成而拦截首次分镜', async (status) => {
  it.each(['queued', 'running', 'processing'])('解析任务 %s 期间禁止写入但允许读取且不自动取消', async (status) => {
    const client = makeClient({ jobGet: vi.fn(async () => ok({ run: 'r1', status })) })
    const { service } = makeService(client, makeSession())
    await service.runCreate({ sessionId: 's1', baseName: '新任务' })
    await service.parse({ sessionId: 's1', run: 'r1', texts: [{ text: '资料' }] })
    await service.jobGet({ sessionId: 's1', jobId: 'j1' })
    expect(service.getRecords({ sessionId: 's1' })?.state).toBe('parsing')
    // await expect(service.storyboardSubmit(input)).resolves.toEqual({ submitted: true, reviewRequired: false })
    await expect(service.storyboardGet({ sessionId: 's1', run: 'r1' })).resolves.toEqual({ video_title: 't' })
    await expect(service.parse({ sessionId: 's1', run: 'r1' })).rejects.toMatchObject({
      code: 'IVIDEO_SUBMISSION_UNKNOWN'
    })
    await expect(service.videoStart({ sessionId: 's1', run: 'r1' })).rejects.toMatchObject({
      code: 'IVIDEO_SUBMISSION_UNKNOWN'
    })
    await expect(service.storyboardSubmit(input)).rejects.toMatchObject({ code: 'IVIDEO_SUBMISSION_UNKNOWN' })
    expect(client.videoStart).toHaveBeenCalledTimes(1)
    expect(client.storyboardSubmit).not.toHaveBeenCalled()
    expect(client.jobCancel).not.toHaveBeenCalled()
  })

  it.each(['videoStart', 'assemble'] as const)('真实 %s 任务运行中仍禁止重复提交分镜', async (operation) => {
    const client = makeClient({ jobGet: vi.fn(async () => ok({ run: 'r1', status: 'running' })) })
    const { service } = makeService(client, makeSession())
    await service.runCreate({ sessionId: 's1', baseName: '新任务' })
    await service[operation]({ sessionId: 's1', run: 'r1' })
    await service.jobGet({ sessionId: 's1', jobId: 'j1' })
    expect(service.getRecords({ sessionId: 's1' })?.state).toBe(operation === 'assemble' ? 'assembling' : 'generating')
    await expect(service.storyboardSubmit(input)).rejects.toMatchObject({ code: 'IVIDEO_SUBMISSION_UNKNOWN' })
    expect(client.storyboardSubmit).not.toHaveBeenCalled()
  })

  it.each(['done', 'failed', 'canceled', 'cancelled', 'blocked'])(
    '解析任务确认终态 %s 后允许继续写入',
    async (status) => {
      const client = makeClient({ jobGet: vi.fn(async () => ok({ run: 'r1', status })) })
      const { service } = makeService(client, makeSession())
      await service.runCreate({ sessionId: 's1', baseName: '新任务' })
      await service.parse({ sessionId: 's1', run: 'r1' })
      await service.jobGet({ sessionId: 's1', jobId: 'j1' })
      await expect(service.parse({ sessionId: 's1', run: 'r1' })).resolves.toMatchObject({ jobId: 'j1' })
      expect(client.videoStart).toHaveBeenCalledTimes(2)
      expect(client.jobCancel).not.toHaveBeenCalled()
    }
  )

  it('解析状态查询失败不能放行写入，终态确认后才允许继续', async () => {
    const client = makeClient()
    const { service } = makeService(client, makeSession())
    await service.runCreate({ sessionId: 's1', baseName: '新任务' })
    await service.parse({ sessionId: 's1', run: 'r1' })
    client.jobGet.mockResolvedValueOnce(fail({ outcomeUnknown: false }))
    await expect(service.jobGet({ sessionId: 's1', jobId: 'j1' })).rejects.toMatchObject({ code: 'IVIDEO_HTTP_ERROR' })
    client.jobGet.mockResolvedValueOnce(fail({ outcomeUnknown: false }))
    await expect(service.assemble({ sessionId: 's1', run: 'r1' })).rejects.toMatchObject({
      code: 'IVIDEO_HTTP_ERROR'
    })
    expect(client.videoStart).toHaveBeenCalledTimes(1)
    await service.jobGet({ sessionId: 's1', jobId: 'j1' })
    await expect(service.videoStart({ sessionId: 's1', run: 'r1' })).resolves.toMatchObject({ jobId: 'j1' })
    expect(client.videoStart).toHaveBeenCalledTimes(2)
    expect(client.jobCancel).not.toHaveBeenCalled()
  })

  it('素材解析 done 后首次提交分镜不应被当作成片返修', async () => {
    const client = makeClient()
    const { service } = makeService(client, makeSession())
    await service.runCreate({ sessionId: 's1', baseName: '新任务' })
    await service.parse({ sessionId: 's1', run: 'r1', texts: [{ text: '资料' }] })
    await service.jobGet({ sessionId: 's1', jobId: 'j1' })
    expect(service.getRecords({ sessionId: 's1' })?.state).toBe('done')
    await expect(service.storyboardSubmit(input)).resolves.toEqual({ submitted: true, reviewRequired: false })
    expect(client.storyboardSubmit).toHaveBeenCalledTimes(1)
  })

  it('未成片的旧 dedicated 调用仍可提交分镜', async () => {
    const client = makeClient()
    const { service } = makeService(client, makeSession())
    await service.runCreate({ sessionId: 's1', baseName: '初版' })
    await expect(service.storyboardSubmit(input)).resolves.toEqual({ submitted: true, reviewRequired: false })
    expect(client.storyboardSubmit).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      '不存在',
      () => {
        throw new Error('not found')
      }
    ],
    ['功能错误', () => makeSession({ featureKind: 'chat' as never })],
    ['无工作区', () => makeSession({ workspaceId: null as never })]
  ] as const)('parse 优先返回 session 校验错误：%s', async (_label, getSession) => {
    const client = makeClient()
    const { service } = makeService(client, getSession)
    await expect(service.parse({ sessionId: 's1', run: 'r1' })).rejects.toMatchObject({
      code: 'IVIDEO_SESSION_INVALID'
    })
    for (const method of Object.values(client)) expect(method).not.toHaveBeenCalled()
  })
})

describe('工业视频可信发送资料', () => {
  it.each([undefined, 0, 2])('新 run 不继承旧设置版本，保留本次显式版本 %s', async (expectedSettingsVersion) => {
    const client = makeClient()
    const { service } = makeService(client, makeSession())
    await service.runCreate({ sessionId: 's1', baseName: '初版' })
    await service.parse({ sessionId: 's1', run: 'r1', texts: [{ text: '原资料' }], expectedSettingsVersion: 7 })
    await service.jobGet({ sessionId: 's1', jobId: 'j1' })
    client.runCreate.mockResolvedValue(ok({ run: 'r2', raw: { run: 'r2' } }))
    await service.runCreate({ sessionId: 's1', baseName: '返修' })
    await service.parse({ sessionId: 's1', run: 'r2', texts: [{ text: '补充资料' }], expectedSettingsVersion })
    const request = client.videoStart.mock.calls.at(-1)?.[0]
    expect(request?.expected_settings_version).toBe(expectedSettingsVersion)
    expect(request?.texts).toEqual([{ text: '原资料' }, { text: '补充资料' }])
  })

  it('发送附件全部上传后进入 parse，成片返修自动使用新 run', async () => {
    const upload = vi.fn(async ({ name }) => ok({ name: `uploaded-${name}` }))
    const client = makeClient({ upload })
    const { service } = makeService(client, makeSession())
    await service.runCreate({ sessionId: 's1', baseName: '初版' })
    await service.parse({ sessionId: 's1', run: 'r1', texts: [{ text: '原资料' }] })
    await service.jobGet({ sessionId: 's1', jobId: 'j1' })
    await service.videoStart({ sessionId: 's1', run: 'r1' })
    await service.jobGet({ sessionId: 's1', jobId: 'j1' })
    client.runCreate.mockResolvedValue(ok({ run: 'r2', raw: { run: 'r2' } }))
    const execution = service.beginRound({ sessionId: 's1' })
    await service.withExecution(execution, async () => {
      await service.prepareUserParts({
        sessionId: 's1',
        parts: [
          { type: 'text', text: '压缩到20秒' },
          { type: 'file', filename: '甲.png', mediaType: 'image/png', url: 'data:image/png;base64,YQ==' },
          { type: 'file', filename: '乙.mp4', mediaType: 'video/mp4', url: 'data:video/mp4;base64,Yg==' }
        ]
      })
      const parsed = await service.parse({ sessionId: 's1', run: 'r1', targetDurationS: 20 })
      expect(parsed.jobId).toBe('j1')
    })
    expect(upload).toHaveBeenCalledTimes(2)
    expect(client.videoStart).toHaveBeenLastCalledWith(
      expect.objectContaining({
        run: 'r2',
        target_duration_s: 20,
        texts: [{ text: '原资料' }, { text: '压缩到20秒' }],
        media: [
          { name: 'uploaded-甲.png', caption: '甲.png' },
          { name: 'uploaded-乙.mp4', caption: '乙.mp4' }
        ]
      })
    )
  })
})

describe('工业视频文档附件可信提取', () => {
  const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

  function makeDocService(extract: (filename: string, base64: string) => Promise<string> = async () => '装配步骤全文') {
    const upload = vi.fn(async ({ name }: { name?: string }) => ok({ name: `uploaded-${name}` }))
    const client = makeClient({ upload })
    const extractDocumentText = vi.fn(extract)
    // setTestDeps 每次从 productionDeps 重新合并，会话与提取依赖必须一次注入。
    const { service } = makeService(client, makeSession(), {}, { extractDocumentText })
    return { client, service, upload, extractDocumentText }
  }

  async function prepareAndParse(
    service: IndustrialVideoService,
    part: { type: 'file'; filename: string; mediaType: string; url: string },
    modelArgs: { texts?: unknown[]; media?: unknown[] } = {}
  ) {
    await service.runCreate({ sessionId: 's1', baseName: '初版' })
    const execution = service.beginRound({ sessionId: 's1' })
    await service.withExecution(execution, async () => {
      await service.prepareUserParts({ sessionId: 's1', parts: [part] })
      await service.parse({ sessionId: 's1', run: 'r1', ...modelArgs })
    })
  }

  it('docx 附件经可信提取进入 texts，字节不上传', async () => {
    const { service, client, upload, extractDocumentText } = makeDocService()
    await prepareAndParse(service, {
      type: 'file',
      filename: '装配手册.docx',
      mediaType: docxMime,
      url: `data:${docxMime};base64,29vb29vb`
    })
    expect(extractDocumentText).toHaveBeenCalledTimes(1)
    expect(upload).not.toHaveBeenCalled()
    expect(client.videoStart).toHaveBeenLastCalledWith(
      expect.objectContaining({
        run: 'r1',
        texts: [{ text: '装配步骤全文', title: '装配手册.docx' }]
      })
    )
  })

  it('PDF 按 octet-stream MIME 仍按扩展名提取', async () => {
    const { service, client, upload, extractDocumentText } = makeDocService()
    await prepareAndParse(service, {
      type: 'file',
      filename: '参数表.pdf',
      mediaType: 'application/octet-stream',
      url: 'data:application/octet-stream;base64,29vb29vb'
    })
    expect(extractDocumentText).toHaveBeenCalledTimes(1)
    expect(upload).not.toHaveBeenCalled()
    expect(client.videoStart).toHaveBeenLastCalledWith(
      expect.objectContaining({
        texts: [{ text: '装配步骤全文', title: '参数表.pdf' }]
      })
    )
  })

  it.each(['.exe', '.zip'])('不支持的扩展名 %s 仍拒绝且不提取、不上传', async (ext) => {
    const { service, client, upload, extractDocumentText } = makeDocService()
    const filename = `安装包${ext}`
    await expect(
      prepareAndParse(service, {
        type: 'file',
        filename,
        mediaType: 'application/octet-stream',
        url: 'data:application/octet-stream;base64,29vb29vb'
      })
    ).rejects.toMatchObject({ code: 'IVIDEO_MATERIAL_INVALID' })
    expect(extractDocumentText).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    // runCreate 已在拒绝前发生；解析（videoStart 携带 parse 输入）不得发生。
    expect(client.videoStart).not.toHaveBeenCalled()
  })

  it('提取为空时拒绝提交', async () => {
    const { service, upload } = makeDocService(async () => '')
    await expect(
      prepareAndParse(service, {
        type: 'file',
        filename: '扫描件.pdf',
        mediaType: 'application/pdf',
        url: 'data:application/pdf;base64,29vb29vb'
      })
    ).rejects.toMatchObject({ code: 'IVIDEO_MATERIAL_INVALID' })
    expect(upload).not.toHaveBeenCalled()
  })

  it('提取失败时拒绝提交', async () => {
    const { service, upload } = makeDocService(async () => {
      throw new Error('officeparser failed')
    })
    await expect(
      prepareAndParse(service, {
        type: 'file',
        filename: '损坏.docx',
        mediaType: docxMime,
        url: `data:${docxMime};base64,29vb29vb`
      })
    ).rejects.toMatchObject({ code: 'IVIDEO_MATERIAL_INVALID' })
    expect(upload).not.toHaveBeenCalled()
  })

  // 服务端契约（ivideo sources/materials.py）：单条 texts ≤20000 字，title 单行 ≤40 字符。
  function longText(paragraphChars: number[]): string {
    return paragraphChars.map((n) => '甲'.repeat(n)).join('\n')
  }

  it('超长提取文本按段落拆成多条 texts，title 带序号且不超限', async () => {
    const source = longText([6000, 6000, 6000, 6000])
    const longName = `${'设'.repeat(30)}备维护手册完整修订版.pdf` // 40 字符，加 " 1/2" 后必破 40 上限
    const { service, client, upload } = makeDocService(async () => source)
    await prepareAndParse(service, {
      type: 'file',
      filename: longName,
      mediaType: 'application/pdf',
      url: 'data:application/pdf;base64,29vb29vb'
    })
    const call = client.videoStart.mock.calls.at(-1)?.[0] as { texts: { text: string; title: string }[] }
    expect(call.texts).toHaveLength(2)
    for (const entry of call.texts) expect(entry.text.length).toBeLessThanOrEqual(20000)
    expect(call.texts.map((t) => t.text).join('\n')).toBe(source)
    // 基础名已被截到 40，加序号后整体再截：序号必须保留（辨识拆分次序），基础名尾部让位。
    for (const t of call.texts) expect(t.title.length).toBeLessThanOrEqual(40)
    expect(call.texts[0].title.endsWith('1/2')).toBe(true)
    expect(call.texts[1].title.endsWith('2/2')).toBe(true)
    expect(call.texts[0].title.startsWith('设'.repeat(30))).toBe(true)
    expect(upload).not.toHaveBeenCalled()
  })

  it('单段超限且无段落结构时拒绝并给指引', async () => {
    const { service, client, upload } = makeDocService(async () => '甲'.repeat(25000))
    await expect(
      prepareAndParse(service, {
        type: 'file',
        filename: '无结构.docx',
        mediaType: docxMime,
        url: `data:${docxMime};base64,29vb29vb`
      })
    ).rejects.toMatchObject({ code: 'IVIDEO_MATERIAL_INVALID' })
    expect(client.videoStart).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
  })

  it('长文件名 title 截断至 40 字符', async () => {
    const filename = `${'长'.repeat(50)}.docx`
    const { service, client } = makeDocService()
    await prepareAndParse(service, {
      type: 'file',
      filename,
      mediaType: docxMime,
      url: `data:${docxMime};base64,29vb29vb`
    })
    const call = client.videoStart.mock.calls.at(-1)?.[0] as { texts: { text: string; title: string }[] }
    expect(call.texts).toHaveLength(1)
    expect(call.texts[0].title).toBe(filename.slice(0, 40))
    expect(call.texts[0].title.length).toBeLessThanOrEqual(40)
  })

  it('text/plain 内联超长同样按段落拆分', async () => {
    const source = longText([9000, 9000, 9000])
    // 统一共享分类后 TEXT 分支也走提取依赖，须显式提供提取结果（此前依赖 MIME 直读路径）。
    const { service, client, extractDocumentText } = makeDocService(async () => source)
    await prepareAndParse(service, {
      type: 'file',
      filename: '工艺说明.txt',
      mediaType: 'text/plain',
      url: `data:text/plain;base64,${Buffer.from(source).toString('base64')}`
    })
    expect(extractDocumentText).toHaveBeenCalledTimes(1)
    const call = client.videoStart.mock.calls.at(-1)?.[0] as { texts: { text: string; title: string }[] }
    expect(call.texts).toHaveLength(2)
    expect(call.texts.map((t) => t.text).join('\n')).toBe(source)
    expect(call.texts.map((t) => t.title)).toEqual(['工艺说明.txt 1/2', '工艺说明.txt 2/2'])
  })

  // 共享分类统一（getFileTypeByExt）：TEXT 类按扩展名分类而非 MIME，编码走自动检测。
  it('GBK 编码 txt 自动检测解码，不再按 UTF-8 硬解乱码', async () => {
    const source = '扭矩标准值：120N·m，螺栓预紧力矩见下表。'
    const gbkBytes = iconv.encode(source, 'gbk')
    const { service, client, extractDocumentText } = makeDocService(async (_filename, base64) => {
      // 模拟共享管线行为：base64 → 自动编码解码。
      return decodeTextWithAutoEncoding(Buffer.from(base64, 'base64')).trim()
    })
    await prepareAndParse(service, {
      type: 'file',
      filename: '参数表.txt',
      mediaType: 'text/plain',
      url: `data:text/plain;base64,${gbkBytes.toString('base64')}`
    })
    expect(extractDocumentText).toHaveBeenCalledTimes(1)
    const call = client.videoStart.mock.calls.at(-1)?.[0] as { texts: { text: string }[] }
    expect(call.texts[0].text).toBe(source)
  })

  it.each(['.md', '.csv'])('扩展名 %s 按共享 textExts 分类提取，MIME 不可靠也走提取', async (ext) => {
    const { service, client, upload, extractDocumentText } = makeDocService(async () => '工序要点')
    await prepareAndParse(service, {
      type: 'file',
      filename: `工艺要点${ext}`,
      mediaType: 'application/octet-stream',
      url: 'data:application/octet-stream;base64,29vb29vb'
    })
    expect(extractDocumentText).toHaveBeenCalledTimes(1)
    expect(upload).not.toHaveBeenCalled()
    const call = client.videoStart.mock.calls.at(-1)?.[0] as { texts: { text: string }[] }
    expect(call.texts[0].text).toBe('工序要点')
  })

  it('AUDIO 类（.mp3）按共享分类拒绝，不上传不提取', async () => {
    const { service, client, upload, extractDocumentText } = makeDocService()
    await expect(
      prepareAndParse(service, {
        type: 'file',
        filename: '背景音乐.mp3',
        mediaType: 'audio/mpeg',
        url: 'data:audio/mpeg;base64,29vb29vb'
      })
    ).rejects.toMatchObject({ code: 'IVIDEO_MATERIAL_INVALID' })
    expect(extractDocumentText).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    expect(client.videoStart).not.toHaveBeenCalled()
  })

  it('二进制伪装 .json 提取出乱码时被防线拒绝，不提交', async () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xd8, 0xb4, 0xff, 0xfe, 0x9c, 0x0b])
    // const { service, client, upload, extractDocumentText } = makeDocService(() => binary.toString('latin1'))
    const { service, client, upload, extractDocumentText } = makeDocService(async () => binary.toString('latin1'))
    await expect(
      prepareAndParse(service, {
        type: 'file',
        filename: '伪装参数.json',
        mediaType: 'application/octet-stream',
        url: `data:application/octet-stream;base64,${binary.toString('base64')}`
      })
    ).rejects.toMatchObject({ code: 'IVIDEO_MATERIAL_INVALID' })
    expect(extractDocumentText).toHaveBeenCalledTimes(1)
    expect(upload).not.toHaveBeenCalled()
    expect(client.videoStart).not.toHaveBeenCalled()
  })

  // 模型 texts 只允许内联 {text, title?}（客户端附件自动提取，模型拿不到字节）；
  // 服务端 {name}/{url} 引用需 uploads/ 句柄且限 txt/md/csv/srt/json——模型必然传不出合法句柄。
  it('模型传入的 {name} 引用条目在合并前被过滤，不发给服务端', async () => {
    const { service, client } = makeDocService()
    await prepareAndParse(
      service,
      {
        type: 'file',
        filename: '装配手册.docx',
        mediaType: docxMime,
        url: `data:${docxMime};base64,29vb29vb`
      },
      { texts: [{ name: '参数表.txt', title: '参数表' }] as never }
    )
    const call = client.videoStart.mock.calls.at(-1)?.[0] as { texts: { text?: string; name?: string }[] }
    expect(call.texts.every((item) => typeof item.text === 'string' && item.text.trim())).toBe(true)
    expect(call.texts.some((item) => 'name' in item && !('text' in item))).toBe(false)
  })

  it('模型传入的内联 texts 正常保留，与提取结果并存', async () => {
    const { service, client } = makeDocService()
    await prepareAndParse(
      service,
      {
        type: 'file',
        filename: '装配手册.docx',
        mediaType: docxMime,
        url: `data:${docxMime};base64,29vb29vb`
      },
      { texts: [{ text: '品牌口号：工业之美' }] }
    )
    const call = client.videoStart.mock.calls.at(-1)?.[0] as { texts: { text: string }[] }
    expect(call.texts.some((item) => item.text === '品牌口号：工业之美')).toBe(true)
    expect(call.texts.some((item) => item.text === '装配步骤全文')).toBe(true)
  })

  it('media 缺 caption 的条目在合并前被过滤（服务端 caption 必填）', async () => {
    const { service, client, upload } = makeDocService()
    await prepareAndParse(
      service,
      {
        type: 'file',
        filename: '甲.png',
        mediaType: 'image/png',
        url: 'data:image/png;base64,YQ=='
      },
      {
        media: [{ name: 'uploaded-参考图.jpg' }] as never // 模型引用了句柄但没给 caption
      }
    )
    const call = client.videoStart.mock.calls.at(-1)?.[0] as { media: { name: string; caption: string }[] }
    // 客户端上传的甲.png 带 caption（文件名兜底），模型的无 caption 条目被过滤
    expect(call.media.length).toBe(1)
    expect(call.media[0].caption.trim()).not.toBe('')
    expect(upload).toHaveBeenCalledTimes(1)
  })
})

describe('工业视频返修快照', () => {
  it('保存的是服务端真实审核文件而非渲染进程伪造内容，重复保存不覆盖用户稿', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ivideo-review-'))
    try {
      const client = makeClient({
        reviewSnapshotGet: vi.fn(async () =>
          ok({
            review_version: 'v1',
            generation_allowed: false,
            remaining_blockers: [],
            script: '真实脚本',
            storyboard: { video_title: '产品', scenes: [] }
          })
        )
      })
      const { service } = makeService(client, makeSession(), { workspacePath: workspace })
      service.setReviewAuthorizationProvider({ authorize: async () => 'trusted' })
      await service.runCreate({ sessionId: 's1', baseName: '产品' })
      const input = { sessionId: 's1', run: 'r1', script: '伪造脚本', storyboard: '伪造分镜' }
      const files = await service.snapshotSave(input)
      expect(await readFile(files.scriptPath, 'utf8')).toBe('真实脚本')
      expect(await readFile(files.storyboardPath, 'utf8')).toContain('产品')
      const next = await service.snapshotSave(input)
      expect(next.scriptPath).not.toBe(files.scriptPath)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
  it('parse 持久化全量输入，新增素材不会覆盖旧素材', async () => {
    const client = makeClient()
    const { service } = makeService(client, makeSession())
    await service.runCreate({ sessionId: 's1', baseName: '初版' })
    await service.parse({
      sessionId: 's1',
      run: 'r1',
      texts: [{ text: '原文' }],
      media: [{ name: 'old.png', caption: '旧图' }],
      targetDurationS: 30
    })
    await service.jobGet({ sessionId: 's1', jobId: 'j1' })
    await service.parse({ sessionId: 's1', run: 'r1', media: [{ name: 'new.png', caption: '新图' }] })
    expect(client.videoStart.mock.calls.at(-1)?.[0]).toMatchObject({
      texts: [{ text: '原文' }],
      media: [
        { name: 'old.png', caption: '旧图' },
        { name: 'new.png', caption: '新图' }
      ],
      target_duration_s: 30
    })
    expect(service.getRecords({ sessionId: 's1' })?.rounds.at(-1)?.detail?.inputSnapshot).toMatchObject({
      targetDurationS: 30,
      media: [
        { name: 'old.png', caption: '旧图' },
        { name: 'new.png', caption: '新图' }
      ]
    })
  })

  it('新 run 请求前先保存已完成版本的精确任务产物，返修记录关联 parentRun', async () => {
    const client = makeClient({
      jobGet: vi.fn(async () => ok({ run: 'r1', status: 'done', artifacts: [{ path: 'r1/final.mp4', size: 123 }] }))
    })
    const { service } = makeService(client, makeSession())
    await service.runCreate({ sessionId: 's1', baseName: '初版' })
    await service.parse({ sessionId: 's1', run: 'r1', texts: [{ text: '原始资料' }] })
    await service.jobGet({ sessionId: 's1', jobId: 'j1' })
    client.runCreate.mockImplementationOnce(async () => {
      expect(
        service
          .getRecords({ sessionId: 's1' })
          ?.rounds.some((round) => round.operation === 'revision_archive' && round.detail?.job)
      ).toBe(true)
      return ok({ run: 'r2' }) as never
    })
    await service.runCreate({ sessionId: 's1', baseName: '返修' })
    const record = service.getRecords({ sessionId: 's1' })!
    expect(record.rounds.at(-1)?.detail).toMatchObject({ parentRun: 'r1' })
    expect(record.rounds.find((round) => round.operation === 'revision_archive')?.detail).toMatchObject({
      job: { artifacts: [{ path: 'r1/final.mp4', size: 123 }] }
    })
    await service.parse({ sessionId: 's1', run: 'r2', texts: [{ text: '改为20秒' }], targetDurationS: 20 })
    expect(client.videoStart.mock.calls.at(-1)?.[0]).toMatchObject({
      run: 'r2',
      texts: [{ text: '原始资料' }, { text: '改为20秒' }],
      target_duration_s: 20
    })
  })

  it('返修保留旧 run 只读权限，但不得写旧 run 或读取外部 run', async () => {
    const client = makeClient()
    const { service } = makeService(client, makeSession())
    await service.runCreate({ sessionId: 's1', baseName: '初版' })
    client.runCreate.mockResolvedValueOnce(ok({ run: 'r2', raw: {} }))
    await service.runCreate({ sessionId: 's1', baseName: '返修' })
    await expect(service.artifactRead({ sessionId: 's1', run: 'r1', path: 'final.mp4' })).resolves.toMatchObject({
      content: 'hello'
    })
    await expect(service.videoStart({ sessionId: 's1', run: 'r1' })).rejects.toMatchObject({
      code: 'IVIDEO_RUN_INVALID'
    })
    await expect(service.artifactRead({ sessionId: 's1', run: 'foreign', path: 'final.mp4' })).rejects.toMatchObject({
      code: 'IVIDEO_RUN_INVALID'
    })
  })
})

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

  describe('停止闭环', () => {
    it('可信新轮仅接受绑定凭据；旧轮与直接调用不能借用最新代次', async () => {
      const { service } = makeService(client, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      const first = service.beginRound({ sessionId: 's1' })
      await service.stop({ sessionId: 's1' })
      const second = service.beginRound({ sessionId: 's1' })
      await expect(
        service.withExecution(first, () => service.parse({ sessionId: 's1', run: 'r1' }))
      ).rejects.toMatchObject({ code: 'IVIDEO_STOPPED' })
      await expect(service.parse({ sessionId: 's1', run: 'r1' })).rejects.toMatchObject({ code: 'IVIDEO_STOPPED' })
      await service.withExecution(second, () => service.parse({ sessionId: 's1', run: 'r1' }))
      expect(client.videoStart).toHaveBeenCalledTimes(1)
    })

    it.each(['成功', '拒绝'] as const)('取消迟到%s不能覆盖先完成的任务；停止门禁跨服务重建保留', async (outcome) => {
      const canceled = Promise.withResolvers<IndustrialVideoResult<Record<string, unknown>>>()
      client.jobCancel.mockReturnValue(canceled.promise)
      const { service, store } = makeService(client, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await service.parse({ sessionId: 's1', run: 'r1' })
      const stop = service.stop({ sessionId: 's1' })
      await service.jobGet({ sessionId: 's1', jobId: 'j1' })
      expect(service.getRecords({ sessionId: 's1' })).toMatchObject({ state: 'done', control: { phase: 'stopped' } })
      await expect(stop).resolves.toMatchObject({ stopRequested: true, phase: 'reconcile_required' })
      if (outcome === '成功') canceled.resolve(ok({ canceled: true }))
      else canceled.reject(new Error('迟到的取消失败'))
      await canceled.promise.catch(() => undefined)
      await Promise.resolve()
      await vi.waitFor(() => {
        if (outcome === '成功') {
          expect(service.getRecords({ sessionId: 's1' })?.rounds.at(-1)).toMatchObject({
            operation: 'job_cancel',
            outcome: 'ok',
            detail: { receipt: { canceled: true } }
          })
        }
        expect(service.getRecords({ sessionId: 's1' })?.control?.phase).toBe('stopped')
      })
      expect(service.getRecords({ sessionId: 's1' })).toMatchObject({
        state: 'done',
        control: { stopRequested: true, phase: 'stopped' }
      })
      const rebuilt = makeService(client, session).service
      rebuilt.setTestDeps({
        resolveConfig: () => ({ baseUrl: 'http://svc', token: 't', timeoutMs: 1000 }),
        getSession: () => session,
        createClient: () => client,
        getPersist: () => store['industrial_video.records'] as Record<string, IndustrialVideoProductionRecord>,
        setPersist: (key, value) => {
          store[key] = value
        }
      })
      await expect(rebuilt.videoStart({ sessionId: 's1', run: 'r1' })).rejects.toMatchObject({ code: 'IVIDEO_STOPPED' })
      expect(rebuilt.beginRound({ sessionId: 's1' }).epoch).toBeGreaterThan(1)
    })

    it.each(['失败回执', '请求拒绝'] as const)('取消%s仍返回停止回执，保留门禁归属并允许重试', async (failure) => {
      const { service, store } = makeService(client, session)
      const persist = vi.fn((key: string, value: unknown) => {
        store[key] = value
      })
      service.setTestDeps({
        resolveConfig: () => ({ baseUrl: 'http://svc', token: 't', timeoutMs: 1000 }),
        getSession: () => session,
        createClient: () => client,
        getPersist: () => store['industrial_video.records'] as Record<string, IndustrialVideoProductionRecord>,
        setPersist: persist
      })
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await service.parse({ sessionId: 's1', run: 'r1' })
      const canceled = Promise.withResolvers<IndustrialVideoResult<Record<string, unknown>>>()
      client.jobCancel.mockReturnValueOnce(canceled.promise)
      const stop = service.stop({ sessionId: 's1' })
      const received = vi.fn()
      void stop.then(received, received)
      await vi.waitFor(() => expect(received).toHaveBeenCalled())
      await expect(stop).resolves.toMatchObject({ stopRequested: true, phase: 'reconcile_required' })
      persist.mockClear()
      if (failure === '失败回执') canceled.resolve(fail())
      else canceled.reject(new Error('取消请求失败'))
      await vi.waitFor(() => {
        expect(persist).toHaveBeenCalled()
        if (failure === '失败回执') {
          expect(service.getRecords({ sessionId: 's1' })?.rounds.at(-1)).toMatchObject({
            operation: 'job_cancel',
            outcome: 'unknown'
          })
        }
        expect(service.getRecords({ sessionId: 's1' })?.control?.phase).toBe('reconcile_required')
      })
      expect(service.getRecords({ sessionId: 's1' })).toMatchObject({
        run: 'r1',
        jobId: 'j1',
        control: { stopRequested: true, phase: 'reconcile_required' }
      })
      await service.jobCancel({ sessionId: 's1', jobId: 'j1' })
      await expect(service.assemble({ sessionId: 's1', run: 'r1' })).rejects.toMatchObject({ code: 'IVIDEO_STOPPED' })
    })

    it('取消一直挂起也立即返回已持久化门禁，封锁后续写入和新轮', async () => {
      const { service, store } = makeService(client, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await service.parse({ sessionId: 's1', run: 'r1' })
      client.jobCancel.mockReturnValueOnce(new Promise(() => {}))
      const stop = service.stop({ sessionId: 's1' })
      expect((store['industrial_video.records'] as Record<string, IndustrialVideoProductionRecord>).s1).toMatchObject({
        run: 'r1',
        jobId: 'j1',
        state: 'parsing',
        control: { stopRequested: true, phase: 'reconcile_required' }
      })
      const received = vi.fn()
      void stop.then(received, received)
      await vi.waitFor(() => expect(received).toHaveBeenCalled())
      await expect(stop).resolves.toMatchObject({ stopRequested: true, phase: 'reconcile_required' })
      await expect(service.assemble({ sessionId: 's1', run: 'r1' })).rejects.toMatchObject({ code: 'IVIDEO_STOPPED' })
      expect(() => service.beginRound({ sessionId: 's1' })).toThrow()
      expect(client.jobCancel).toHaveBeenCalledTimes(1)
      expect(client.videoStart).toHaveBeenCalledTimes(1)
    })

    it('start 未返回时立即落停止门禁，迟到 job 记账并取消，排队写入不发出', async () => {
      const started = Promise.withResolvers<void>()
      const response = Promise.withResolvers<Awaited<ReturnType<IndustrialVideoClient['videoStart']>>>()
      client.videoStart.mockImplementationOnce(() => {
        started.resolve()
        return response.promise
      })
      const { service } = makeService(client, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      const start = service.videoStart({ sessionId: 's1', run: 'r1' })
      await started.promise
      const queued = service.assemble({ sessionId: 's1', run: 'r1' })
      const rejected = expect(queued).rejects.toMatchObject({ code: 'IVIDEO_STOPPED' })
      await service.stop({ sessionId: 's1' })
      expect(service.getRecords({ sessionId: 's1' })?.control).toMatchObject({
        stopRequested: true,
        phase: 'reconcile_required'
      })
      response.resolve(ok({ job_id: 'late-job', raw: {} }))
      await start
      await rejected
      expect(client.jobCancel).toHaveBeenCalledWith({ job_id: 'late-job' })
      expect(service.getRecords({ sessionId: 's1' })).toMatchObject({ jobId: 'late-job', state: 'generating' })
      expect(client.videoStart).toHaveBeenCalledTimes(1)
    })

    it('未知提交不阻止取消已知 job，cancel 回执和 canceled 状态都不证明 worker 已退出', async () => {
      const { service, store } = makeService(client, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await service.parse({ sessionId: 's1', run: 'r1' })
      const records = store['industrial_video.records'] as Record<string, IndustrialVideoProductionRecord>
      records.s1.unknownSubmissions = [{ ...records.s1.rounds.at(-1)!, outcome: 'unknown', jobId: null }]
      await service.stop({ sessionId: 's1' })
      expect(client.jobCancel).toHaveBeenCalledWith({ job_id: 'j1' })
      client.jobGet.mockResolvedValue(ok({ run: 'r1', status: 'canceled' }))
      await service.jobGet({ sessionId: 's1', jobId: 'j1' })
      expect(service.getRecords({ sessionId: 's1' })?.unknownSubmissions).toHaveLength(1)
      expect(service.getRecords({ sessionId: 's1' })?.control?.phase).toBe('reconcile_required')
      expect(() => service.beginRound({ sessionId: 's1' })).toThrow()
    })

    it('停止使迟到审核确认失效，不重新授予生成权限', async () => {
      const entered = Promise.withResolvers<void>()
      const receipt = Promise.withResolvers<IndustrialVideoResult<any>>()
      client.reviewConfirm = vi.fn(() => {
        entered.resolve()
        return receipt.promise
      })
      const { service } = makeService(client, session)
      service.setReviewAuthorizationProvider({ authorize: async () => 'trusted' })
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      const confirm = service.reviewConfirm({ sessionId: 's1', run: 'r1', expectedReviewVersion: 'v1' })
      const rejected = expect(confirm).rejects.toMatchObject({ code: 'IVIDEO_STOPPED' })
      await entered.promise
      await service.stop({ sessionId: 's1' })
      receipt.resolve(ok({ review_version: 'v1', generation_allowed: true, remaining_blockers: [] }))
      await rejected
      expect(service.getConfirmedReview({ sessionId: 's1' })).toBeNull()
    })
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
      // expect(service.getRecords({ sessionId: 's1' })).toMatchObject({ run: 'r1', state: 'canceled' })
      expect(service.getRecords({ sessionId: 's1' })).toMatchObject({ run: 'r1', state: 'parsing' })
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

    it('未知提交再次写入时明确提示待确认而非生成失败', async () => {
      const c = makeClient({ videoStart: vi.fn(async () => fail({ category: 'timeout', outcomeUnknown: true })) })
      const { service } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await expect(service.videoStart({ sessionId: 's1', run: 'r1' })).rejects.toThrow()
      await expect(service.videoStart({ sessionId: 's1', run: 'r1' })).rejects.toThrow('提交结果待确认')
      expect(c.videoStart).toHaveBeenCalledTimes(1)
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
    it('job_get cannot clear an unknown submission merely because its run matches', async () => {
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
      expect(rec.unknownSubmissions.length).toBe(1)
      expect(rec.jobId).toBeNull()
      await expect(service.videoStart({ sessionId: 's1', run: 'r1' })).rejects.toMatchObject({
        code: 'IVIDEO_SUBMISSION_UNKNOWN'
      })
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
      // expect((store['industrial_video.records'] as any).s1.state).toBe('generating')
      expect((store['industrial_video.records'] as any).s1.state).toBe('parsing')
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

  describe('写入前实时终态校验', () => {
    it.each(['done', 'failed', 'blocked', 'canceled'])('%s 查询终态后允许下一次写入', async (status) => {
      const c = makeClient()
      const { service } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await service.parse({ sessionId: 's1', run: 'r1', texts: [{ text: 'x' }] })
      c.jobGet.mockResolvedValue(ok({ run: 'r1', status }))
      await expect(service.parse({ sessionId: 's1', run: 'r1', texts: [{ text: 'next' }] })).resolves.toBeDefined()
      expect(c.jobGet).toHaveBeenCalledWith({ job_id: 'j1' })
      expect(c.videoStart).toHaveBeenCalledTimes(2)
      expect(c.jobCancel).not.toHaveBeenCalled()
    })

    it.each(['blocked', 'canceled'])('%s 后允许显式创建下一项目', async (status) => {
      const c = makeClient()
      const { service } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await service.parse({ sessionId: 's1', run: 'r1' })
      c.jobGet.mockResolvedValue(ok({ run: 'r1', status }))
      // c.runCreate.mockResolvedValue(ok({ run: 'r2' }))
      c.runCreate.mockResolvedValue(ok({ run: 'r2', raw: { run: 'r2' } }))
      await expect(service.runCreate({ sessionId: 's1', baseName: 'next' })).resolves.toEqual({ run: 'r2' })
      expect(c.jobCancel).not.toHaveBeenCalled()
    })

    it.each(['running', 'queued', 'unknown', 'offline', 'foreign'])('%s 拒绝写入且不取消重提', async (status) => {
      const c = makeClient()
      const { service } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await service.parse({ sessionId: 's1', run: 'r1', texts: [{ text: 'x' }] })
      await service.jobGet({ sessionId: 's1', jobId: 'j1' })
      if (status === 'offline') c.jobGet.mockResolvedValue(fail())
      else c.jobGet.mockResolvedValue(ok({ run: status === 'foreign' ? 'other' : 'r1', status }))
      await expect(service.parse({ sessionId: 's1', run: 'r1', texts: [{ text: 'next' }] })).rejects.toThrow()
      expect(c.videoStart).toHaveBeenCalledTimes(1)
      expect(c.jobCancel).not.toHaveBeenCalled()
    })

    it('未知查询状态不能借用旧终态释放停止门禁', async () => {
      const c = makeClient()
      const { service, store } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await service.parse({ sessionId: 's1', run: 'r1' })
      await service.stop({ sessionId: 's1' })
      const record = (store['industrial_video.records'] as Record<string, IndustrialVideoProductionRecord>).s1
      record.state = 'canceled'
      c.jobGet.mockResolvedValue(ok({ run: 'r1', status: 'unknown' }))
      await service.jobGet({ sessionId: 's1', jobId: 'j1' })
      expect(service.getRecords({ sessionId: 's1' })?.control?.phase).toBe('reconcile_required')
    })

    it.each(['blocked', 'canceled'])('%s 查询确认后释放停止门禁及新轮入口', async (status) => {
      const c = makeClient()
      const { service } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await service.parse({ sessionId: 's1', run: 'r1', texts: [{ text: 'x' }] })
      await service.stop({ sessionId: 's1' })
      expect(service.getRecords({ sessionId: 's1' })?.control?.phase).toBe('reconcile_required')
      c.jobGet.mockResolvedValue(ok({ run: 'r1', status }))
      await service.jobGet({ sessionId: 's1', jobId: 'j1' })
      expect(service.getRecords({ sessionId: 's1' })?.control?.phase).toBe('stopped')
      expect(() => service.beginRound({ sessionId: 's1' })).not.toThrow()
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

    // it('persists a cancellation round and moves to canceled without extra cancel calls', async () => {
    it('保存取消回执但保留真实任务状态', async () => {
      const { service, store } = makeService(client, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await service.parse({ sessionId: 's1', run: 'r1', texts: [{ text: 'x' }] }) // job j1
      await service.jobCancel({ sessionId: 's1', jobId: 'j1' })
      const rec = (store['industrial_video.records'] as any).s1
      // expect(rec.state).toBe('canceled')
      expect(rec.state).toBe('parsing')
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
      await service.jobGet({ sessionId: 's1', jobId: 'j1' })
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

  it('静态英文音色经私有设置映射透传到服务端', async () => {
    const { service } = makeService(client, session)
    await service.runCreate({ sessionId: 's1', baseName: 'demo' })
    await service.videoStart({ sessionId: 's1', run: 'r1', voice: 'en-US-JennyNeural', subtitleLanguage: 'en-US', secondSubtitleLanguage: 'zh-CN', ttsEnabled: true, narrationFollowsSubtitles: true })
    expect(client.videoStart).toHaveBeenCalledWith(expect.objectContaining({ voice: 'en-US-JennyNeural', subtitle_language: 'en-US', second_subtitle_language: 'zh-CN', tts_enabled: true, narration_follows_subtitles: true }))
    expect(service).not.toHaveProperty('ttsOptionsGet')
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
      // rec.run = 'other' // tamper so r1 no longer belongs
      // 历史成功登记的 r1 仍属本会话；同时移除登记才代表外部 run。
      rec.run = 'other'
      rec.rounds = []
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

  describe('工业字幕：camelCase → snake_case 透传 + stage:"plan" 安全路径', () => {
    function subtitleVideoStartClient() {
      return makeClient({
        videoStart: vi.fn(async () =>
          ok({
            job_id: 'j1',
            effective_settings: {
              settings_version: 3,
              subtitle_language: 'en-US',
              second_subtitle_language: 'ja-JP',
              bilingual_subtitles: true,
              narration_follows_subtitles: true,
              subtitle_enabled: true
            },
            settings_persisted: true,
            settings_changed: true,
            requires_replan: false,
            approval_invalidated: false
          })
        )
      })
    }

    it('video_start 把字幕 camelCase 字段转 snake_case 透传并回传 effectiveSettings 字幕字段', async () => {
      const c = subtitleVideoStartClient()
      const { service } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      const res = await service.videoStart({
        sessionId: 's1',
        run: 'r1',
        subtitleLanguage: 'en-US',
        secondSubtitleLanguage: 'ja-JP',
        bilingualSubtitles: true,
        narrationFollowsSubtitles: true,
        subtitleEnabled: true,
        expectedSettingsVersion: 1
      })
      expect(c.videoStart).toHaveBeenCalledWith(
        expect.objectContaining({
          run: 'r1',
          stage: 'video',
          subtitle_language: 'en-US',
          second_subtitle_language: 'ja-JP',
          bilingual_subtitles: true,
          narration_follows_subtitles: true,
          subtitle_enabled: true,
          expected_settings_version: 1
        })
      )
      expect(res.effectiveSettings).toMatchObject({
        subtitle_language: 'en-US',
        second_subtitle_language: 'ja-JP',
        bilingual_subtitles: true,
        narration_follows_subtitles: true
      })
      expect(res.settingsVersion).toBe(3)
    })

    it('video_start stage:"plan" 安全透传，不请求生成（记录 planning 状态）', async () => {
      const c = subtitleVideoStartClient()
      const { service, store } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      const res = await service.videoStart({
        sessionId: 's1',
        run: 'r1',
        stage: 'plan',
        subtitleLanguage: 'en-US',
        expectedSettingsVersion: 1
      } as never)
      expect(c.videoStart).toHaveBeenCalledWith(expect.objectContaining({ stage: 'plan', subtitle_language: 'en-US' }))
      expect(res.jobId).toBe('j1')
      expect((store['industrial_video.records'] as any).s1.state).toBe('planning')
    })

    it('video_start 缺省仍为生成状态（向后兼容）', async () => {
      const c = subtitleVideoStartClient()
      const { service, store } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await service.videoStart({ sessionId: 's1', run: 'r1' })
      expect((store['industrial_video.records'] as any).s1.state).toBe('generating')
    })

    it('parse 把字幕字段编入全量快照并转 snake_case 透传（stage=parse）', async () => {
      const c = makeClient({
        videoStart: vi.fn(async () => ok({ job_id: 'j1', effective_settings: { settings_version: 1 } }))
      })
      const { service } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await service.parse({
        sessionId: 's1',
        run: 'r1',
        texts: [{ text: 'x' }],
        subtitleLanguage: 'de-DE',
        bilingualSubtitles: true,
        secondSubtitleLanguage: 'fr-FR',
        narrationFollowsSubtitles: true
      })
      expect(c.videoStart).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'parse',
          subtitle_language: 'de-DE',
          second_subtitle_language: 'fr-FR',
          bilingual_subtitles: true,
          narration_follows_subtitles: true
        })
      )
    })

    it('estimate 透传字幕字段（只读，不提交任务）', async () => {
      const c = makeClient({
        estimate: vi.fn(async () =>
          ok({ estimate: { fee: 9 }, effective_settings: { settings_version: 2 }, settings_persisted: false, settings_changed: false })
        )
      })
      const { service } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await service.estimate({ sessionId: 's1', run: 'r1', subtitleLanguage: 'ko-KR', bilingualSubtitles: false })
      expect(c.estimate).toHaveBeenCalledWith(
        expect.objectContaining({ subtitle_language: 'ko-KR', bilingual_subtitles: false })
      )
    })

    it('设置版本冲突（settings_version_conflict）必须抛出，不得吞掉', async () => {
      const c = makeClient({
        videoStart: vi.fn(async () =>
          fail({ category: 'validation', status: 409, code: 'settings_version_conflict', message: '设置版本已变化' })
        )
      })
      const { service } = makeService(c, session)
      await service.runCreate({ sessionId: 's1', baseName: 'demo' })
      await expect(service.videoStart({ sessionId: 's1', run: 'r1' })).rejects.toMatchObject({
        code: 'IVIDEO_HTTP_ERROR',
        data: { code: 'settings_version_conflict' }
      })
    })
  })
})
