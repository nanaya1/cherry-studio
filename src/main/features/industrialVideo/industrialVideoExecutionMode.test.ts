import { describe, expect, it } from 'vitest'

import { BaseService } from '@main/core/lifecycle'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'
import type { IndustrialVideoProductionRecord } from '@shared/data/cache/cacheValueTypes'
// import { industrialVideoRequestSchemas } from '@shared/ipc/schemas/industrialVideo'

import { IndustrialVideoService } from './IndustrialVideoService'

function makeSession(overrides: Partial<AgentSessionEntity> = {}): AgentSessionEntity {
  return {
    id: 's1',
    featureKind: 'industrial-video',
    workspaceId: 'ws1',
    ...overrides
  } as AgentSessionEntity
}

function makeService(session: AgentSessionEntity) {
  BaseService.resetInstances()
  const store: Record<string, unknown> = {}
  const service = new IndustrialVideoService()
  service.setTestDeps({
    resolveConfig: () => ({ baseUrl: 'http://svc', token: 't', timeoutMs: 1000 }),
    getSession: () => session,
    getPersist: (key: string) => (store[key] ?? {}) as Record<string, IndustrialVideoProductionRecord>,
    setPersist: (key: string, value: unknown) => {
      store[key] = value
    },
    getWorkspacePath: () => '/abs/ws',
    createDownloader: () => ({}) as never,
    getReviewActor: async () => null,
    getLocalReviewActor: () => '',
    setLocalReviewActor: () => undefined
  })
  return { service }
}

function expectCode(fn: () => void, code: string): void {
  let thrown: unknown
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(Error)
  expect((thrown as { code?: string }).code).toBe(code)
}

describe('industrial video round execution guard', () => {
  // MEA:industrial-video 旧模式绑定已由统一工具链替代，保留历史测试供回溯。
  /* it('dedicated-flow显式绑定可持久化且不能切换旧模式', () => {
    const { service } = makeService(makeSession())
    service.bindExecutionMode({ sessionId: 's1', mode: 'dedicated-flow' })
    expect(service.getExecutionMode({ sessionId: 's1' })).toBe('dedicated-flow')
    expect(
      industrialVideoRequestSchemas['industrial_video.get_records'].output.parse(
        service.getRecords({ sessionId: 's1' })
      )
    ).toMatchObject({ execution_mode: 'dedicated-flow' })
    expectCode(() => service.bindExecutionMode({ sessionId: 's1', mode: 'native' }), 'IVIDEO_MODE_FROZEN')
  })
  it('正式记录输出保留 execution_mode 且兼容旧记录', () => {
    const { service } = makeService(makeSession())
    service.bindExecutionMode({ sessionId: 's1', mode: 'structured-action' })
    const schema = industrialVideoRequestSchemas['industrial_video.get_records'].output
    const record = service.getRecords({ sessionId: 's1' })!
    expect(schema.parse(record)).toMatchObject({ execution_mode: 'structured-action' })
    const legacy = { ...record }
    delete legacy.execution_mode
    expect(schema.safeParse(legacy).success).toBe(true)
  }) */

  it('无业务副作用可释放轮次，但未知提交不能被释放或开启新轮', () => {
    const { service } = makeService(makeSession())
    const token = service.beginRound({ sessionId: 's1' })
    service.releaseRound(token)
    expect(service.getRecords({ sessionId: 's1' })?.control?.phase).toBe('idle')
    const next = service.beginRound({ sessionId: 's1' })
    expect(next.epoch).toBeGreaterThan(token.epoch)
    const record = service.getRecords({ sessionId: 's1' })!
    record.unknownSubmissions.push({
      version: 1,
      operation: 'parse',
      run: 'r1',
      jobId: null,
      state: 'failed',
      requestId: 'q1',
      at: 1,
      outcome: 'unknown'
    })
    // 通过测试持久层注入未知写结果，验证终态清理不能解除对账门禁。
    ;(service as unknown as { saveRecord(record: IndustrialVideoProductionRecord): void }).saveRecord(record)
    service.releaseRound(next)
    expect(service.getRecords({ sessionId: 's1' })?.control?.phase).toBe('active')
    expectCode(() => service.beginRound({ sessionId: 's1' }), 'IVIDEO_RECONCILE_REQUIRED')
  })

  it('refuses to begin a round for a non-industrial session', () => {
    const { service } = makeService(makeSession({ featureKind: 'general' }))
    expectCode(() => service.beginRound({ sessionId: 's1' }), 'IVIDEO_SESSION_INVALID')
  })

  /* it('refuses to bind a non-industrial session (general)', () => {
    const { service } = makeService(makeSession({ featureKind: 'general' }))
    expectCode(
      () => service.bindExecutionMode({ sessionId: 's1', mode: 'structured-action' }),
      'IVIDEO_SESSION_INVALID'
    )
  })

  it('defaults to native when no mode was bound', () => {
    const { service } = makeService(makeSession())
    expect(service.getExecutionMode({ sessionId: 's1' })).toBe('native')
  })

  it('binds and reads back structured-action for an industrial session', () => {
    const { service } = makeService(makeSession())
    service.bindExecutionMode({ sessionId: 's1', mode: 'structured-action' })
    expect(service.getExecutionMode({ sessionId: 's1' })).toBe('structured-action')
  })

  it('rejects re-binding a different mode (mode freeze)', () => {
    const { service } = makeService(makeSession())
    service.bindExecutionMode({ sessionId: 's1', mode: 'structured-action' })
    expectCode(() => service.bindExecutionMode({ sessionId: 's1', mode: 'native' }), 'IVIDEO_MODE_FROZEN')
    // The previously frozen mode survives the rejected attempt.
    expect(service.getExecutionMode({ sessionId: 's1' })).toBe('structured-action')
  }) */
})
