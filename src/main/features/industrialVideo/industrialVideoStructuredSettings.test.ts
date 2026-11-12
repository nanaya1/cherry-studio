import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it, vi } from 'vitest'

import { createIndustrialVideoStructuredSettingsExecutor } from './industrialVideoStructuredSettings'

const result = (data: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ ok: true, ...data }) }]
})

function setup() {
  const record = {
    run: 'r1',
    state: 'parsing',
    unknownSubmissions: [] as unknown[],
    rounds: [] as { run: string; operation: string; outcome: string }[]
  }
  const call = vi.fn<(tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<CallToolResult>>(
    async (tool) =>
      tool === 'ivideo_context'
        ? result({ run: 'r1', effective_settings: { settings_version: 7, target_duration_s: 24, tts_enabled: false } })
        : result({ run: 'r1', effectiveSettings: { settings_version: 8, target_duration_s: 24, tts_enabled: false } })
  )
  const execute = createIndustrialVideoStructuredSettingsExecutor({
    call,
    getRecord: () => record,
    assertExecution: vi.fn()
  })
  return { execute, call, record }
}

describe('structured 专属设置执行边界', () => {
  it('从正式 context 绑定版本且不覆盖业务参数或原对象', async () => {
    const { execute, call } = setup()
    const args = { run: 'r1', targetDurationS: 24, ttsEnabled: false, texts: [{ text: '素材' }] }
    await execute('ivideo_parse', args)
    expect(call.mock.calls[1]).toEqual(['ivideo_parse', { ...args, expectedSettingsVersion: 7 }, undefined])
    expect(args).not.toHaveProperty('expectedSettingsVersion')
  })

  it('模型显式旧版本必须拒绝，不能覆盖成新版本', async () => {
    const { execute, call } = setup()
    await expect(execute('ivideo_parse', { run: 'r1', expectedSettingsVersion: 6 })).rejects.toThrow('版本冲突')
    expect(call.mock.calls.map(([tool]) => tool)).toEqual(['ivideo_context'])
  })

  it('正式新建且从未 parse 的 run 无设置版本时原样初次提交，不猜零版本', async () => {
    const { execute, call, record } = setup()
    record.state = 'idle'
    record.rounds.push({ run: 'r1', operation: 'run_create', outcome: 'ok' })
    await execute('ivideo_parse', { run: 'r1', targetDurationS: 24 })
    expect(call.mock.calls).toEqual([['ivideo_parse', { run: 'r1', targetDurationS: 24 }, undefined]])
  })

  it('首次 parse 先入库再核验回执，不查询尚未初始化的规划上下文', async () => {
    const { execute, call, record } = setup()
    record.state = 'idle'
    record.rounds.push({ run: 'r1', operation: 'run_create', outcome: 'ok' })
    call.mockImplementation(async (tool) =>
      tool === 'ivideo_context'
        ? { isError: true, content: [{ type: 'text', text: 'run 不存在' }] }
        : result({ run: 'r1', effectiveSettings: { target_duration_s: 24 } })
    )
    const response = await execute('ivideo_parse', { run: 'r1', targetDurationS: 24 })
    expect(response.isError).not.toBe(true)
    expect(call.mock.calls.map(([tool]) => tool)).toEqual(['ivideo_parse'])
    expect(call.mock.calls[0][1]).toEqual({ run: 'r1', targetDurationS: 24 })
    await expect(execute('ivideo_review_snapshot_get', { run: 'r1' })).resolves.toMatchObject({ isError: true })
  })

  it('首次 parse 回执不符仍阻断后续审核', async () => {
    const { execute, call, record } = setup()
    record.state = 'idle'
    record.rounds.push({ run: 'r1', operation: 'run_create', outcome: 'ok' })
    call.mockResolvedValue(result({ run: 'r1', effectiveSettings: { target_duration_s: 30 } }))
    await expect(execute('ivideo_parse', { run: 'r1', targetDurationS: 24 })).rejects.toThrow('生效设置')
    await expect(execute('ivideo_review_snapshot_get', { run: 'r1' })).rejects.toThrow('尚未核验')
    expect(call.mock.calls.map(([tool]) => tool)).toEqual(['ivideo_parse'])
  })

  it.each(['intended', 'failed', 'ok'])('存在 parse %s 记录时不能再走首次免查询路径', async (outcome) => {
    const { execute, call, record } = setup()
    record.state = 'idle'
    record.rounds.push(
      { run: 'r1', operation: 'run_create', outcome: 'ok' },
      { run: 'r1', operation: 'parse', outcome }
    )
    call.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'run 不存在' }] })
    expect(await execute('ivideo_parse', { run: 'r1' })).toMatchObject({ isError: true })
    expect(call.mock.calls.map(([tool]) => tool)).toEqual(['ivideo_context'])
  })

  it('首次 parse 也不能绕过未知写结果守卫', async () => {
    const { execute, call, record } = setup()
    record.state = 'idle'
    record.rounds.push({ run: 'r1', operation: 'run_create', outcome: 'ok' })
    record.unknownSubmissions.push({ operation: 'parse' })
    await expect(execute('ivideo_parse', { run: 'r1' })).rejects.toThrow('未知')
    expect(call).not.toHaveBeenCalled()
  })

  it('首次 parse 回执迟到且已取消时不得解除审核门禁', async () => {
    const { execute, call, record } = setup()
    record.state = 'idle'
    record.rounds.push({ run: 'r1', operation: 'run_create', outcome: 'ok' })
    const controller = new AbortController()
    call.mockImplementationOnce(async () => {
      controller.abort()
      return result({ run: 'r1', effectiveSettings: { target_duration_s: 24 } })
    })
    await expect(execute('ivideo_parse', { run: 'r1', targetDurationS: 24 }, controller.signal)).rejects.toThrow(
      'aborted'
    )
    await expect(execute('ivideo_review_snapshot_get', { run: 'r1' })).rejects.toThrow('尚未核验')
    expect(call.mock.calls.map(([tool]) => tool)).toEqual(['ivideo_parse'])
  })

  it('首次 parse 显式版本仍查询正式 context，不丢弃版本', async () => {
    const { execute, call, record } = setup()
    record.state = 'idle'
    record.rounds.push({ run: 'r1', operation: 'run_create', outcome: 'ok' })
    await expect(execute('ivideo_parse', { run: 'r1', expectedSettingsVersion: 6 })).rejects.toThrow('版本冲突')
    expect(call.mock.calls.map(([tool]) => tool)).toEqual(['ivideo_context'])
  })

  it('parse 完成的 done 状态不等于已经生成视频，仍允许带版本更新', async () => {
    const { execute, call, record } = setup()
    record.state = 'done'
    await execute('ivideo_parse', { run: 'r1' })
    expect(call.mock.calls[1][1]).toEqual({ run: 'r1', expectedSettingsVersion: 7 })
  })

  it('没有正式设置版本时不猜测', async () => {
    const { execute, call } = setup()
    call.mockResolvedValueOnce(result({ effective_settings: {} }))
    await expect(execute('ivideo_parse', { run: 'r1' })).rejects.toThrow('设置版本')
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('未绑定 run 不得隐式查询并认领归属', async () => {
    const { execute, call } = setup()
    await expect(execute('ivideo_parse', { run: 'other' })).rejects.toThrow('归属')
    expect(call).not.toHaveBeenCalled()
  })

  it('context 迟到时归属变化不能触发写', async () => {
    const { execute, call, record } = setup()
    call.mockImplementationOnce(async () => {
      record.run = 'other'
      return result({ settings_version: 7 })
    })
    await expect(execute('ivideo_parse', { run: 'r1' })).rejects.toThrow('归属')
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('并发更新导致服务端版本冲突时只提交一次，不刷新版本重写', async () => {
    const { execute, call } = setup()
    const conflict = { isError: true, content: [{ type: 'text' as const, text: 'settings version conflict' }] }
    call.mockResolvedValueOnce(result({ settings_version: 7 })).mockResolvedValueOnce(conflict)
    expect(await execute('ivideo_parse', { run: 'r1' })).toEqual(conflict)
    expect(call.mock.calls.map(([tool]) => tool)).toEqual(['ivideo_context', 'ivideo_parse'])
  })

  it('未知写结果不重试，下一次写也被拦截', async () => {
    const { execute, call, record } = setup()
    call
      .mockImplementationOnce(async () => result({ settings_version: 7 }))
      .mockImplementationOnce(async () => {
        record.unknownSubmissions.push({ operation: 'parse' })
        return { isError: true, content: [{ type: 'text', text: '未知写结果' }] }
      })
    await execute('ivideo_parse', { run: 'r1' })
    await expect(execute('ivideo_parse', { run: 'r1' })).rejects.toThrow('未知')
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('取消后 context 即使成功迟到也不写入', async () => {
    const { execute, call } = setup()
    const controller = new AbortController()
    call.mockImplementationOnce(async () => {
      controller.abort()
      return result({ settings_version: 7 })
    })
    await expect(execute('ivideo_parse', { run: 'r1' }, controller.signal)).rejects.toThrow('aborted')
    expect(call).toHaveBeenCalledTimes(1)
  })

  it.each(['ivideo_storyboard_submit', 'ivideo_review_snapshot_get', 'ivideo_start'])(
    '明确提交设置与回执不符时阻断 %s，不能用后续默认值擦除意图',
    async (tool) => {
      const { execute, call } = setup()
      call
        .mockResolvedValueOnce(result({ settings_version: 7 }))
        .mockResolvedValueOnce(result({ run: 'r1', effectiveSettings: { target_duration_s: 30, tts_enabled: true } }))
      await expect(execute('ivideo_parse', { run: 'r1', targetDurationS: 24, ttsEnabled: false })).rejects.toThrow(
        '生效设置'
      )
      await expect(execute(tool, { run: 'r1' })).rejects.toThrow('生效设置')
      expect(call).toHaveBeenCalledTimes(2)
    }
  )

  it('parse 回执缺少明确提交字段不得算核验成功', async () => {
    const { execute, call } = setup()
    call.mockResolvedValueOnce(result({ settings_version: 7 })).mockResolvedValueOnce(result({ run: 'r1' }))
    await expect(execute('ivideo_parse', { run: 'r1', ttsEnabled: false })).rejects.toThrow('生效设置')
  })

  it('提交后正式 context 参数漂移仍然阻断审核', async () => {
    const { execute, call } = setup()
    await execute('ivideo_parse', { run: 'r1', targetDurationS: 24, ttsEnabled: false })
    call.mockResolvedValueOnce(
      result({ effective_settings: { settings_version: 9, target_duration_s: 30, tts_enabled: true } })
    )
    await expect(execute('ivideo_review_snapshot_get', { run: 'r1' })).rejects.toThrow('生效设置')
    expect(call.mock.calls.map(([tool]) => tool)).not.toContain('ivideo_review_snapshot_get')
  })

  it('显式当前版本原样保留，启动不得覆盖已经核验的业务意图', async () => {
    const { execute, call } = setup()
    await execute('ivideo_parse', { run: 'r1', expectedSettingsVersion: 7, targetDurationS: 24, ttsEnabled: false })
    expect(call.mock.calls[1][1].expectedSettingsVersion).toBe(7)
    await expect(execute('ivideo_start', { run: 'r1', targetDurationS: 30 })).rejects.toThrow('意图')
    expect(call.mock.calls.map(([tool]) => tool)).not.toContain('ivideo_start')
  })

  it('epoch 失效后的 context 迟到不能提交', async () => {
    const call = vi.fn(async () => result({ settings_version: 7 }))
    const assertExecution = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementation(() => {
        throw new Error('旧 epoch')
      })
    const execute = createIndustrialVideoStructuredSettingsExecutor({
      call,
      assertExecution,
      getRecord: () => ({ run: 'r1', state: 'parsing', rounds: [], unknownSubmissions: [] })
    })
    await expect(execute('ivideo_parse', { run: 'r1' })).rejects.toThrow('旧 epoch')
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('已完成成片拒绝给自动返修分支携带旧 run 版本', async () => {
    const { call } = setup()
    const execute = createIndustrialVideoStructuredSettingsExecutor({
      call,
      assertExecution: () => undefined,
      getRecord: () => ({
        run: 'r1',
        state: 'done',
        jobId: 'j1',
        unknownSubmissions: [],
        rounds: [{ run: 'r1', jobId: 'j1', operation: 'video_start', outcome: 'ok' }]
      })
    })
    await expect(execute('ivideo_parse', { run: 'r1' })).rejects.toThrow('返修')
    expect(call).not.toHaveBeenCalled()
  })

  it('查询不读取隐式 context，其他执行轮次不继承意图', async () => {
    const { execute, call } = setup()
    await execute('ivideo_status', { jobId: 'j1' })
    expect(call.mock.calls.map(([tool]) => tool)).toEqual(['ivideo_status'])
    const next = setup()
    await next.execute('ivideo_review_snapshot_get', { run: 'r1' })
    expect(next.call.mock.calls.map(([tool]) => tool)).toEqual(['ivideo_review_snapshot_get'])
  })
})
