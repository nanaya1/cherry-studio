import { describe, expect, it, vi } from 'vitest'

import { IndustrialVideoWorkbenchBridge } from '../industrialVideoWorkbenchBridge'

type Deps = ConstructorParameters<typeof IndustrialVideoWorkbenchBridge>[0]

const SNAPSHOT = {
  review_version: 'v1',
  script: 'script',
  storyboard: { scenes: [] },
  effective_settings: { resolution: '1080P' },
  allowed_actions: ['regenerate_storyboard'] as string[]
}

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    sessionId: 'sess-1',
    run: 'run-1',
    coworkReviewGet: vi.fn(async () => structuredClone(SNAPSHOT)),
    coworkReviewConfirm: vi.fn(async () => ({ task_operation: 'storyboard_stage_task_get' })),
    resumeStages: vi.fn(async () => 'resumed'),
    ...overrides
  }
}

function request(overrides: Partial<import('@shared/utils/industrialVideoWorkbench').IndustrialVideoWorkbenchRequest> = {}) {
  return {
    requestId: 'req-1',
    type: 'regenerate_storyboard' as const,
    sessionId: 'sess-1',
    run: 'run-1',
    reviewVersion: 'v1',
    ...overrides
  }
}

function snapshotRequest(overrides: Parameters<typeof request>[0] = {}) {
  const { reviewVersion: _version, ...value } = request(overrides)
  return { ...value, requestId: `get:${value.requestId}`, type: 'get_review_snapshot' as const }
}

describe('IndustrialVideoWorkbenchBridge', () => {
  it.each(['get', 'confirm'] as const)('失效会阻断 pending %s 后的确认和续跑', async (stage) => {
    const deps = makeDeps()
    const bridge = new IndustrialVideoWorkbenchBridge(deps)
    await bridge.getSnapshot(snapshotRequest())
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    if (stage === 'get') deps.coworkReviewGet = vi.fn(async () => { await pending; return SNAPSHOT })
    else deps.coworkReviewConfirm = vi.fn(async () => { await pending; return { task_operation: 'storyboard_stage_task_get' } })
    const result = bridge.regenerateStoryboard(request())
    if (stage === 'confirm') await vi.waitFor(() => expect(deps.coworkReviewConfirm).toHaveBeenCalledTimes(1))
    bridge.invalidate()
    release()
    expect(await result).toMatchObject({ ok: false, code: 'stale' })
    expect(deps.resumeStages).not.toHaveBeenCalled()
    if (stage === 'get') expect(deps.coworkReviewConfirm).not.toHaveBeenCalled()
  })

  it('失效的 pending 快照不能恢复可用版本', async () => {
    let release!: (value: typeof SNAPSHOT) => void
    // const deps = makeDeps({ coworkReviewGet: vi.fn(() => new Promise((resolve) => { release = resolve })) })
    const deps = makeDeps({ coworkReviewGet: vi.fn(() => new Promise<typeof SNAPSHOT>((resolve) => { release = resolve })) })
    const bridge = new IndustrialVideoWorkbenchBridge(deps)
    const result = bridge.getSnapshot(snapshotRequest())
    bridge.invalidate()
    release(SNAPSHOT)
    expect(await result).toMatchObject({ ok: false, code: 'stale' })
    expect(await bridge.getSnapshot(snapshotRequest({ requestId: 'new' }))).toMatchObject({ ok: false, code: 'stale' })
  })

  it.each([null, { type: 'init' }, { type: 'response' }, { requestId: '' }, { reviewVersion: 1 }])('拒绝非法信封 %j', async (value) => {
    const deps = makeDeps()
    const bridge = new IndustrialVideoWorkbenchBridge(deps)
    expect(await bridge.regenerateStoryboard(value === null ? value as never : { ...request(), ...value } as never)).toMatchObject({ ok: false, code: 'invalid_request' })
    expect(deps.coworkReviewGet).not.toHaveBeenCalled()
  })
  it('构造后注册及替换的续跑回调按执行时查找', async () => {
    let current: Deps['resumeStages']
    const deps=makeDeps({getResumeStages:()=>current,resumeStages:undefined})
    const bridge=new IndustrialVideoWorkbenchBridge(deps)
    await bridge.getSnapshot(snapshotRequest())
    const old=vi.fn(async()=>{})
    current=old
    const latest=vi.fn(async()=>{})
    deps.coworkReviewConfirm=vi.fn(async()=>{current=latest;return {task_operation:'storyboard_stage_task_get'}})
    expect(await bridge.regenerateStoryboard(request())).toMatchObject({ok:true})
    expect(old).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledExactlyOnceWith('run-1')
  })

  it('拒绝：未注册 resumeStages 时显式点击 regenerate 不调用 confirm', async () => {
    const deps = makeDeps({ resumeStages: undefined })
    const bridge = new IndustrialVideoWorkbenchBridge(deps)
    await bridge.getSnapshot(snapshotRequest())
    const result = await bridge.regenerateStoryboard(request())
    expect(result.ok).toBe(false)
    expect((result as { code?: string }).code).toBe('unregistered')
    expect(deps.coworkReviewConfirm).not.toHaveBeenCalled()
  })

  it('拒绝：不可信来源（串 session）', async () => {
    const deps = makeDeps()
    const bridge = new IndustrialVideoWorkbenchBridge(deps)
    await bridge.getSnapshot(snapshotRequest())
    const result = await bridge.regenerateStoryboard(request({ sessionId: 'other-session' }))
    expect(result.ok).toBe(false)
    expect((result as { code?: string }).code).toBe('untrusted_source')
    expect(deps.coworkReviewConfirm).not.toHaveBeenCalled()
  })

  it('拒绝：串 run', async () => {
    const deps = makeDeps()
    const bridge = new IndustrialVideoWorkbenchBridge(deps)
    await bridge.getSnapshot(snapshotRequest())
    const result = await bridge.regenerateStoryboard(request({ run: 'other-run' }))
    expect(result.ok).toBe(false)
    expect((result as { code?: string }).code).toBe('untrusted_source')
    expect(deps.coworkReviewConfirm).not.toHaveBeenCalled()
  })

  it('拒绝：版本变更（服务端版本已变化）', async () => {
    // 第一次 get（展示）返回 v1，第二次 get（确认前复核）返回 v2。
    let call = 0
    const deps = makeDeps({
      coworkReviewGet: vi.fn(async () => {
        const snap = structuredClone(SNAPSHOT)
        if (call++ > 0) snap.review_version = 'v2'
        return snap
      })
    })
    const bridge = new IndustrialVideoWorkbenchBridge(deps)
    await bridge.getSnapshot(snapshotRequest())
    const result = await bridge.regenerateStoryboard(request())
    expect(result.ok).toBe(false)
    expect((result as { code?: string }).code).toBe('version_changed')
    expect(deps.coworkReviewConfirm).not.toHaveBeenCalled()
  })

  it('拒绝：点击版本与展示版本不一致', async () => {
    const deps = makeDeps()
    const bridge = new IndustrialVideoWorkbenchBridge(deps)
    await bridge.getSnapshot(snapshotRequest())
    const result = await bridge.regenerateStoryboard(request({ reviewVersion: 'v-different' }))
    expect(result.ok).toBe(false)
    expect((result as { code?: string }).code).toBe('version_mismatch')
    expect(deps.coworkReviewConfirm).not.toHaveBeenCalled()
  })

  it('拒绝：重放同一 requestId', async () => {
    const deps = makeDeps()
    const bridge = new IndustrialVideoWorkbenchBridge(deps)
    await bridge.getSnapshot(snapshotRequest())
    const first = await bridge.regenerateStoryboard(request({ requestId: 'dup' }))
    expect(first.ok).toBe(true)
    const second = await bridge.regenerateStoryboard(request({ requestId: 'dup' }))
    expect(second.ok).toBe(false)
    expect((second as { code?: string }).code).toBe('replay')
    expect(deps.coworkReviewConfirm).toHaveBeenCalledTimes(1)
  })

  it('拒绝：忙碌中重复请求', async () => {
    let resolveGet: () => void = () => {}
    const deps = makeDeps({
      coworkReviewGet: vi.fn(
        () =>
          new Promise<typeof SNAPSHOT>((resolve) => {
            resolveGet = () => resolve(structuredClone(SNAPSHOT))
          })
      )
    })
    const bridge = new IndustrialVideoWorkbenchBridge(deps)
    // 第一个请求卡在 getSnapshot（未返回），第二个应被忙碌拒绝
    const pending = bridge.getSnapshot(snapshotRequest({ requestId: 'a' }))
    const busy = await bridge.regenerateStoryboard(request({ requestId: 'b' }))
    expect(busy.ok).toBe(false)
    expect((busy as { code?: string }).code).toBe('busy')
    resolveGet()
    await pending
  })

  it('合法：显式点击仅触发一次 confirm + resume，不 video_start', async () => {
    const deps = makeDeps()
    const bridge = new IndustrialVideoWorkbenchBridge(deps)
    await bridge.getSnapshot(snapshotRequest())
    const result = await bridge.regenerateStoryboard(request())
    expect(result.ok).toBe(true)
    expect(deps.coworkReviewConfirm).toHaveBeenCalledTimes(1)
    expect(deps.coworkReviewConfirm).toHaveBeenCalledWith('v1', 'regenerate_storyboard')
    expect(deps.resumeStages).toHaveBeenCalledTimes(1)
    expect(deps.resumeStages).toHaveBeenCalledWith('run-1')
  })

  it('拒绝：异常 task_operation 回执不能成功或续跑', async () => {
    const deps = makeDeps({
      coworkReviewConfirm: vi.fn(async () => ({ task_operation: 'other' }))
    })
    const bridge = new IndustrialVideoWorkbenchBridge(deps)
    await bridge.getSnapshot(snapshotRequest())
    const result = await bridge.regenerateStoryboard(request())
    expect(result).toMatchObject({ ok: false, code: 'unexpected_operation' })
    expect(deps.resumeStages).not.toHaveBeenCalled()
  })

  it('失效：离开页面后同请求被拒绝', async () => {
    const deps = makeDeps()
    const bridge = new IndustrialVideoWorkbenchBridge(deps)
    await bridge.getSnapshot(snapshotRequest())
    bridge.invalidate()
    const result = await bridge.regenerateStoryboard(request())
    expect(result.ok).toBe(false)
    expect((result as { code?: string }).code).toBe('stale')
    expect(deps.coworkReviewConfirm).not.toHaveBeenCalled()
  })

  it('getSnapshot 失败不污染当前版本，不触发 resume', async () => {
    const deps = makeDeps({
      coworkReviewGet: vi.fn(async () => {
        throw new Error('network')
      })
    })
    const bridge = new IndustrialVideoWorkbenchBridge(deps)
    const result = await bridge.getSnapshot(snapshotRequest())
    expect(result.ok).toBe(false)
    const regen = await bridge.regenerateStoryboard(request())
    expect(regen.ok).toBe(false)
    expect(deps.resumeStages).not.toHaveBeenCalled()
  })

  // ── 每次操作的新鲜 dirty 查询：向记录的最近活跃网页发唯一 requestId，仅匹配响应有效 ──
  const dirtyAnswer = (overrides: Record<string, unknown> = {}) => ({
    requestId: 'q-1',
    type: 'dirty_query_response' as const,
    sessionId: 'sess-1',
    run: 'run-1',
    dirty: false,
    ...overrides
  })

  const attach = (bridge: IndustrialVideoWorkbenchBridge, send = vi.fn()) => {
    const port = { send }
    bridge.attachWebview(port)
    return port
  }

  it('响应 dirty=false 时放行，请求携带同一 requestId', async () => {
    const bridge = new IndustrialVideoWorkbenchBridge(makeDeps())
    const port = attach(bridge)
    const pending = bridge.queryFreshDirty('q-1')
    expect(port.send).toHaveBeenCalledExactlyOnceWith('industrial-video-workbench:bridge', {
      requestId: 'q-1',
      type: 'dirty_query',
      sessionId: 'sess-1',
      run: 'run-1'
    })
    expect(bridge.answerDirtyQuery(dirtyAnswer())).toBe(true)
    expect(await pending).toBe(false)
  })

  it('响应 dirty=true 时返回 true（由 host 阻断）', async () => {
    const bridge = new IndustrialVideoWorkbenchBridge(makeDeps())
    attach(bridge)
    const pending = bridge.queryFreshDirty('q-1')
    expect(bridge.answerDirtyQuery(dirtyAnswer({ dirty: true }))).toBe(true)
    expect(await pending).toBe(true)
  })

  it('忽略 requestId 不符与串 session/run 的响应', async () => {
    const bridge = new IndustrialVideoWorkbenchBridge(makeDeps())
    attach(bridge)
    const pending = bridge.queryFreshDirty('q-1')
    expect(bridge.answerDirtyQuery(dirtyAnswer({ requestId: 'spoofed' }))).toBe(false)
    expect(bridge.answerDirtyQuery(dirtyAnswer({ run: 'other-run' }))).toBe(false)
    expect(bridge.answerDirtyQuery(dirtyAnswer({ sessionId: 'other-session' }))).toBe(false)
    expect(bridge.answerDirtyQuery(dirtyAnswer({ dirty: 'yes' }))).toBe(false)
    expect(bridge.answerDirtyQuery(dirtyAnswer())).toBe(true)
    expect(await pending).toBe(false)
  })

  it('无活跃网页时立即拒绝，不发查询', async () => {
    const bridge = new IndustrialVideoWorkbenchBridge(makeDeps())
    const send = vi.fn()
    const port = { send }
    bridge.attachWebview(port)
    bridge.attachWebview(null)
    await expect(bridge.queryFreshDirty('q-1')).rejects.toMatchObject({ code: 'IVIDEO_WORKBENCH_DIRTY_UNKNOWN' })
    expect(send).not.toHaveBeenCalled()
  })

  it('新鲜查询超时 fail closed', async () => {
    vi.useFakeTimers()
    try {
      const bridge = new IndustrialVideoWorkbenchBridge(makeDeps())
      attach(bridge)
      const pending = bridge.queryFreshDirty('q-timeout')
      const assertion = expect(pending).rejects.toMatchObject({ code: 'IVIDEO_WORKBENCH_DIRTY_UNKNOWN' })
      await vi.advanceTimersByTimeAsync(6000)
      await assertion
      expect(bridge.answerDirtyQuery(dirtyAnswer({ requestId: 'q-timeout' }))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('invalidate 后未完成的 fresh 查询立即 fail closed', async () => {
    const bridge = new IndustrialVideoWorkbenchBridge(makeDeps())
    attach(bridge)
    const pending = bridge.queryFreshDirty('q-1')
    bridge.invalidate()
    await expect(pending).rejects.toMatchObject({ code: 'IVIDEO_WORKBENCH_DIRTY_UNKNOWN' })
  })
})
