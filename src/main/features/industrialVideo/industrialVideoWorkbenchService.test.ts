import { describe, expect, it, vi } from 'vitest'

import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'

// import type { IndustrialVideoClientConfig, IndustrialVideoResult } from './IndustrialVideoClient'
import type { IndustrialVideoResult } from './IndustrialVideoClient'
import { IndustrialVideoService } from './IndustrialVideoService'

function makeSession(): AgentSessionEntity {
  return {
    id: 's1',
    featureKind: 'industrial-video',
    workspaceId: 'ws1'
  } as AgentSessionEntity
}

function ok<T>(data: T): IndustrialVideoResult<T> {
  return { ok: true, requestId: 'req-ok', data }
}

// IndustrialVideoService 是单例（BaseService 全局注册），测试内复用同一实例并每次重置 deps。
let sharedService: IndustrialVideoService | null = null
function makeService(
  fakeClient: Record<string, unknown>,
  extraDeps: Record<string, unknown> = {}
): IndustrialVideoService {
  if (!sharedService) sharedService = new IndustrialVideoService()
  sharedService.setTestDeps({
    resolveConfig: () => ({ baseUrl: 'http://x', token: 't', timeoutMs: 1 }),
    getSession: () => makeSession(),
    createClient: () => fakeClient as never,
    getPersist: () =>
      ({
        s1: { run: 'r1' }
      }) as never,
    setPersist: () => {},
    // 真实批准读取需要本地审核身份；测试环境提供稳定的 local actor 以便断言签发成功。
    getLocalReviewActor: () => 'local:test-actor',
    setLocalReviewActor: () => {},
    getReviewActor: async () => 'local:test-actor',
    ...extraDeps
  })
  return sharedService
}

describe('IndustrialVideoService workbench（真实契约：generation_status + review_snapshot_get）', () => {
  it('workbenchOpen 不传 run 时取会话绑定 run，返回归一 workbench_url', async () => {
    const fakeClient = {
      workbenchOpen: vi.fn(async () => ok({ workbenchUrl: 'https://wb/r1', raw: { workbench_url: 'https://wb/r1' } }))
    }
    const service = makeService(fakeClient)
    const out = await service.workbenchOpen({ sessionId: 's1' })
    expect(fakeClient.workbenchOpen).toHaveBeenCalledWith({ run: 'r1', embed: undefined })
    expect(out.workbench_url).toBe('https://wb/r1')
    expect(out.run).toBe('r1')
  })

  it('workbenchGet 真实契约：generation_status=ready 且 review_snapshot_get 批准 → generatable', async () => {
    const fakeClient = {
      workbenchGet: vi.fn(async () =>
        ok({
          generation_status: 'ready',
          needs_script_sync: false,
          document: { needs_sync: false, version: 0, text: '', synced_storyboard_sha256: '', text_sha256: '' },
          delivery_status: 'not_reviewed'
        })
      ),
      reviewSnapshotGet: vi.fn(async () =>
        ok({ review_version: 'v1', generation_allowed: true, remaining_blockers: [], script: '', storyboard: {} })
      )
    }
    const service = makeService(fakeClient)
    const status = await service.workbenchGet({ sessionId: 's1', run: 'r1' })
    expect(status.generation_status).toBe('ready')
    expect(status.needs_script_sync).toBe(false)
    expect(status.document_needs_sync).toBe(false)
    expect(status.approved).toBe(true)
    expect(status.approved_verified).toBe(true)
    expect(status.generatable).toBe(true)
    expect(status.blockers).toEqual([])
    expect(status.raw).toMatchObject({ generation_status: 'ready' })
    expect(fakeClient.reviewSnapshotGet).toHaveBeenCalled()
  })

  it('workbenchGet 分镜未同步或存在阻塞项 → generatable=false（不猜测字段）', async () => {
    const fakeClient = {
      workbenchGet: vi.fn(async () =>
        ok({
          generation_status: 'blocked',
          needs_script_sync: true,
          document: { needs_sync: false, version: 0, text: '', synced_storyboard_sha256: '', text_sha256: '' },
          delivery_status: 'not_reviewed'
        })
      ),
      reviewSnapshotGet: vi.fn(async () =>
        ok({
          review_version: 'v1',
          generation_allowed: false,
          remaining_blockers: ['awaiting_script_review'],
          script: '',
          storyboard: {}
        })
      )
    }
    const service = makeService(fakeClient)
    const status = await service.workbenchGet({ sessionId: 's1', run: 'r1' })
    expect(status.generation_status).toBe('blocked')
    expect(status.needs_script_sync).toBe(true)
    expect(status.approved).toBe(false)
    expect(status.generatable).toBe(false)
    // blockers 同时来自状态机与真实批准读取，绝不凭空猜测。
    expect(status.blockers.some((b) => b.includes('needs_script_sync'))).toBe(true)
    expect(status.blockers.some((b) => b.includes('awaiting_script_review'))).toBe(true)
  })

  it('workbenchGet 批准读取不可用（认证失败）→ 保守拒绝并报告真实缺口', async () => {
    const fakeClient = {
      workbenchGet: vi.fn(async () =>
        ok({
          generation_status: 'ready',
          needs_script_sync: false,
          document: { needs_sync: false, version: 0, text: '', synced_storyboard_sha256: '', text_sha256: '' },
          delivery_status: 'not_reviewed'
        })
      ),
      reviewSnapshotGet: vi.fn(async () =>
        ok({ review_version: 'v1', generation_allowed: true, remaining_blockers: [], script: '', storyboard: {} })
      )
    }
    // 不提供本地审核身份 → createReviewAssertion 失败 → 批准读取不可用。
    const service = makeService(fakeClient, {
      getLocalReviewActor: () => {
        throw new Error('no local actor')
      },
      getReviewActor: async () => null
    })
    const status = await service.workbenchGet({ sessionId: 's1', run: 'r1' })
    expect(status.approved_verified).toBe(false)
    expect(status.approved).toBe(false)
    expect(status.generatable).toBe(false)
    expect(status.blockers.some((b) => b.includes('审核授权') || b.includes('无法确认人工批准'))).toBe(true)
  })

  it.each([
    { generation_status: 'awaiting_script_review' },
    { generation_status: 'awaiting_scene_review' },
    { needs_script_sync: true },
    { document: { needs_sync: true } }
  ])('真实批准不能绕过未就绪或未同步状态 %j', async (changes) => {
    const service = makeService({
      workbenchGet: vi.fn(async () =>
        ok({ generation_status: 'ready', needs_script_sync: false, document: { needs_sync: false }, ...changes })
      ),
      reviewSnapshotGet: vi.fn(async () => ok({ generation_allowed: true, remaining_blockers: [] }))
    })
    const status = await service.workbenchGet({ sessionId: 's1', run: 'r1' })
    expect(status.generatable).toBe(false)
    expect(status.blockers.length).toBeGreaterThan(0)
  })

  it('审核读取异常不能沿用上次批准', async () => {
    const reviewSnapshotGet = vi
      .fn()
      .mockResolvedValueOnce(ok({ generation_allowed: true, remaining_blockers: [] }))
      .mockRejectedValueOnce(new Error('offline'))
    const service = makeService({
      workbenchGet: vi.fn(async () => ok({ generation_status: 'ready', needs_script_sync: false })),
      reviewSnapshotGet
    })
    expect((await service.workbenchGet({ sessionId: 's1', run: 'r1' })).generatable).toBe(true)
    expect(await service.workbenchGet({ sessionId: 's1', run: 'r1' })).toMatchObject({
      approved: false,
      approved_verified: false,
      generatable: false
    })
  })

  it('workbench_get 客户端失败时抛出 IpcError', async () => {
    const fakeClient = {
      workbenchGet: vi.fn(async () => ({
        ok: false,
        requestId: 'e',
        error: { category: 'http', operation: 'workbench_get', requestId: 'e', message: 'boom', outcomeUnknown: false }
      }))
    }
    const service = makeService(fakeClient)
    await expect(service.workbenchGet({ sessionId: 's1', run: 'r1' })).rejects.toThrow()
  })
})
