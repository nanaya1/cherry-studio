import { describe, expect, it, vi } from 'vitest'

import { type DedicatedFlowRecord, runIndustrialVideoDedicatedFlow } from './industrialVideoDedicatedFlow'

function fixture(
  outputs: unknown[] = [
    { intent: 'prepare', baseName: '展示', parse: { texts: [{ text: '螺母' }], targetDurationS: 10 } },
    { storyboard: { video_title: '展示', scenes: [] } }
  ]
) {
  let record: DedicatedFlowRecord | null = null
  const calls: string[] = []
  const model = vi.fn<() => Promise<string>>(async () => JSON.stringify(outputs.shift()))
  const call = vi.fn<(tool: string) => Promise<Record<string, unknown>>>(async (tool: string) => {
    calls.push(tool)
    if (tool === 'ivideo_run_create') {
      record = { run: 'r1', jobId: null, rounds: [], unknownSubmissions: [] }
      return { run: 'r1' }
    }
    if (tool === 'ivideo_parse') {
      record!.jobId = 'p1'
      return { jobId: 'p1' }
    }
    if (tool === 'ivideo_status') return { run: 'r1', status: 'done', stage: 'parse' }
    if (tool === 'ivideo_context')
      return {
        sources_ready: true,
        input_fingerprint: 'fp',
        expected_storyboard_sha256: '',
        effective_settings: { target_duration_s: 10 }
      }
    if (tool === 'ivideo_storyboard_submit') {
      record!.jobId = null
      return { submitted: true }
    }
    return { ok: true }
  })
  const review = vi.fn<() => Promise<boolean>>(async () => false)
  const workbenchOpen = vi.fn<(run: string, embed: boolean) => Promise<{ workbenchUrl: string }>>(async (run) => ({
    workbenchUrl: `https://wb.example/${run}`
  }))
  const workbenchGet = vi.fn<
    (
      run: string
    ) => Promise<{ approved: boolean; generatable: boolean; blockers: string[]; raw: Record<string, unknown> }>
  >(async () => ({ approved: false, generatable: false, blockers: [], raw: {} }))
  const deps = {
    model,
    call,
    getRecord: () => record,
    review,
    workbenchOpen,
    workbenchGet,
    signal: new AbortController().signal
  }
  return {
    deps,
    calls,
    model,
    call,
    review,
    workbenchOpen,
    workbenchGet,
    setRecord: (r: DedicatedFlowRecord) => {
      record = r
    }
  }
}

describe('工业专属固定编排', () => {
  it('模型只返回业务意图和分镜，无原生工具调用仍创建解析并工作台交接（不再本地审核弹框）', async () => {
    const f = fixture()
    const text = await runIndustrialVideoDedicatedFlow('制作', f.deps)
    expect(f.calls).toEqual([
      'ivideo_run_create',
      'ivideo_parse',
      'ivideo_status',
      'ivideo_context',
      'ivideo_storyboard_submit'
    ])
    expect(f.model).toHaveBeenCalledTimes(2)
    expect(f.review).not.toHaveBeenCalled()
    expect(f.call.mock.calls.map(([t]) => t)).not.toContain('ivideo_review_snapshot_get')
    expect(f.workbenchOpen).toHaveBeenCalledWith('r1', true)
    expect(text).toContain('r1')
    expect(text).toContain('工作台')
  })
  it('只有计划文字，纠正失败后零业务提交', async () => {
    const f = fixture()
    f.model.mockResolvedValue('Let me load tools first')
    await expect(runIndustrialVideoDedicatedFlow('制作', f.deps)).rejects.toThrow('前置分析')
    expect(f.model).toHaveBeenCalledTimes(2)
    expect(f.calls).toEqual([])
  })
  it('解析queued由宿主等待，done后不再让模型查询', async () => {
    const f = fixture()
    let n = 0
    const original = f.call.getMockImplementation()!
    f.call.mockImplementation(async (tool) =>
      tool === 'ivideo_status' && n++ === 0 ? { run: 'r1', status: 'queued' } : original(tool)
    )
    await runIndustrialVideoDedicatedFlow('制作', f.deps)
    expect(f.model).toHaveBeenCalledTimes(2)
    expect(f.call.mock.calls.filter(([t]) => t === 'ivideo_status')).toHaveLength(2)
  })
  it('存在unknown时不重提任何写操作', async () => {
    const f = fixture()
    f.setRecord({ run: 'r1', jobId: null, unknownSubmissions: [{}], rounds: [] })
    await expect(runIndustrialVideoDedicatedFlow('制作', f.deps)).rejects.toThrow('未知提交')
    expect(f.calls).toEqual([])
  })
  it('解析失败不进入分镜或审核', async () => {
    const f = fixture()
    const original = f.call.getMockImplementation()!
    f.call.mockImplementation(async (tool) =>
      tool === 'ivideo_status' ? { run: 'r1', status: 'failed' } : original(tool)
    )
    await expect(runIndustrialVideoDedicatedFlow('制作', f.deps)).rejects.toThrow('解析')
    expect(f.model).toHaveBeenCalledTimes(1)
    expect(f.review).not.toHaveBeenCalled()
  })
  it('已停止时不调用模型或业务接口', async () => {
    const f = fixture()
    const controller = new AbortController()
    controller.abort()
    f.deps.signal = controller.signal
    await expect(runIndustrialVideoDedicatedFlow('制作', f.deps)).rejects.toThrow()
    expect(f.model).not.toHaveBeenCalled()
    expect(f.calls).toEqual([])
  })
  it('非法解析字段在创建run之前拦截', async () => {
    const f = fixture([{ intent: 'prepare', baseName: '展示', parse: { run: 'other', arbitrary: true } }])
    await expect(runIndustrialVideoDedicatedFlow('制作', f.deps)).rejects.toThrow('前置分析')
    expect(f.calls).toEqual([])
  })
  it('生成意图按服务端工作台已批准且可生成时 submit 一次', async () => {
    const f = fixture([{ intent: 'generate' }])
    f.setRecord({ run: 'r1', jobId: null, rounds: [], unknownSubmissions: [] })
    f.workbenchGet.mockResolvedValue({
      approved: true,
      generatable: true,
      blockers: [],
      raw: { generation_allowed: true }
    })
    const original = f.call.getMockImplementation()!
    let generating = false
    f.call.mockImplementation(async (tool) => {
      if (tool === 'ivideo_start') {
        generating = true
        return { jobId: 'v1' }
      }
      if (tool === 'ivideo_status' && generating) return { run: 'r1', status: 'done', stage: 'video' }
      return original(tool)
    })
    const text = await runIndustrialVideoDedicatedFlow('生成', f.deps)
    expect(f.call.mock.calls.filter(([t]) => t === 'ivideo_start')).toHaveLength(1)
    expect(f.review).not.toHaveBeenCalled()
    expect(text).toContain('生成作业已完成')
  })
  it('作业归属不符不进入下一阶段', async () => {
    const f = fixture()
    const original = f.call.getMockImplementation()!
    f.call.mockImplementation(async (tool) =>
      tool === 'ivideo_status' ? { run: 'other', status: 'done' } : original(tool)
    )
    await expect(runIndustrialVideoDedicatedFlow('制作', f.deps)).rejects.toThrow('run')
    expect(f.review).not.toHaveBeenCalled()
  })
  it('素材未就绪不进入分镜', async () => {
    const f = fixture()
    const original = f.call.getMockImplementation()!
    f.call.mockImplementation(async (tool) => (tool === 'ivideo_context' ? { sources_ready: false } : original(tool)))
    await expect(runIndustrialVideoDedicatedFlow('制作', f.deps)).rejects.toThrow('素材')
    expect(f.model).toHaveBeenCalledTimes(1)
  })
  it('没有生成意图时只工作台交接不start', async () => {
    const f = fixture([
      { intent: 'prepare', baseName: '展示', parse: { texts: [{ text: '螺母' }] } },
      { storyboard: {} }
    ])
    f.review.mockResolvedValue(true)
    const text = await runIndustrialVideoDedicatedFlow('制作', f.deps)
    expect(f.calls).not.toContain('ivideo_start')
    expect(f.workbenchOpen).toHaveBeenCalledWith('r1', true)
    expect(text).toContain('工作台')
  })

  it('服务端工作台未批准则提示工作台并结束，不 submit', async () => {
    const f = fixture([{ intent: 'generate' }])
    f.setRecord({ run: 'r1', jobId: null, rounds: [], unknownSubmissions: [] })
    f.workbenchGet.mockResolvedValue({ approved: false, generatable: false, blockers: ['脚本未确认'], raw: {} })
    const text = await runIndustrialVideoDedicatedFlow('生成', f.deps)
    expect(f.calls).not.toContain('ivideo_start')
    expect(f.workbenchOpen).toHaveBeenCalledWith('r1', true)
    expect(text).toContain('不能生成')
    expect(text).toContain('脚本未确认')
  })

  it('已有生成 job 不重复查询工作台或提交', async () => {
    const f = fixture([{ intent: 'generate' }])
    f.setRecord({
      run: 'r1',
      jobId: 'v1',
      // rounds: [{ version: 1, operation: 'video_start', run: 'r1', jobId: 'v1', state: 'generating', requestId: 'r', at: 0, outcome: 'ok' }],
      rounds: [{ operation: 'video_start', run: 'r1', jobId: 'v1', outcome: 'ok' }],
      unknownSubmissions: []
    })
    const original = f.call.getMockImplementation()!
    f.call.mockImplementation(async (tool) =>
      tool === 'ivideo_status' ? { run: 'r1', status: 'done', stage: 'video' } : original(tool)
    )
    const text = await runIndustrialVideoDedicatedFlow('生成', f.deps)
    expect(f.workbenchGet).not.toHaveBeenCalled()
    expect(f.calls).not.toContain('ivideo_start')
    expect(text).toContain('本轮未重复生成')
  })
})
