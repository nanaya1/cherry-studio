/**
 * Contract tests for the in-process MCP industrial-video tools provider.
 *
 * These tools are the *only* surface a Claude-Code agent gets into the trusted
 * `IndustrialVideoService`. The contract we pin here:
 *  - exactly the operation whitelist is exposed (no generic HTTP, no arbitrary op),
 *  - `sessionId` / `agentId` are injected from the trusted runtime context and can
 *    never be supplied by the model,
 *  - ownership (agent + industrial-video featureKind) is re-checked at call time,
 *  - success and failure are both returned as real structured JSON (token never leaks),
 *  - the server, not the model, still enforces review approval on `start`.
 */

import type { Mock } from 'vitest'
import { describe, expect, it, vi } from 'vitest'
import * as z from 'zod'

const { agentSessionGetByIdMock, ivServiceMock, loggerErrorMock, loggerWarnMock } = vi.hoisted(() => ({
  agentSessionGetByIdMock: vi.fn(),
  ivServiceMock: {
    getExecutionToken: vi.fn(() => Object.freeze({ sessionId: 's1', epoch: 1 })),
    assertExecution: vi.fn(),
    withExecution: vi.fn((_token: unknown, fn: () => unknown) => fn()),
    getRecords: vi.fn(),
    runCreate: vi.fn(),
    planningContextGet: vi.fn(),
    storyboardGet: vi.fn(),
    storyboardSubmit: vi.fn(),
    reviewSnapshotGet: vi.fn(),
    workbenchOpen: vi.fn(),
    workbenchGet: vi.fn(),
    parse: vi.fn(),
    estimate: vi.fn(),
    videoStart: vi.fn(),
    ttsOptionsGet: vi.fn(),
    jobGet: vi.fn(),
    downloadArtifact: vi.fn()
  },
  loggerErrorMock: vi.fn(),
  loggerWarnMock: vi.fn()
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ error: loggerErrorMock, warn: loggerWarnMock }) }
}))

vi.mock('@main/data/services/AgentSessionService', () => ({
  agentSessionService: { getById: agentSessionGetByIdMock }
}))

vi.mock('@application', () => ({
  application: {
    get: (name: string) => {
      if (name === 'IndustrialVideoService') return ivServiceMock
      throw new Error(`unexpected application service: ${name}`)
    }
  }
}))

const { MeacoworkIndustrialVideoTools } = await import('../meacoworkIndustrialVideoTools')
const { IpcError } = await import('@shared/ipc/errors/IpcError')

const AGENT_ID = 'agent-1'
const SESSION_ID = 's1'

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    agentId: AGENT_ID,
    featureKind: 'industrial-video',
    workspaceId: 'ws1',
    ...overrides
  }
}

function makeTools() {
  return new MeacoworkIndustrialVideoTools({ agentId: AGENT_ID, sessionId: SESSION_ID })
}

describe('服务端工作台交接', () => {
  it('生成前状态读取失败时返回工作台并结束，不提交或自动批准', async () => {
    agentSessionGetByIdMock.mockReturnValue(makeSession())
    ivServiceMock.videoStart.mockClear()
    ivServiceMock.getRecords.mockReturnValueOnce(null)
    ivServiceMock.workbenchGet.mockRejectedValueOnce(new Error('状态服务暂不可用'))
    ivServiceMock.workbenchOpen.mockResolvedValueOnce({ run: 'r1', workbench_url: 'https://video.example/workbench' })
    const data = jsonOf(await makeTools().call('ivideo_start', { run: 'r1' }))
    expect(data).toMatchObject({
      ok: true,
      started: false,
      end_turn: true,
      workbench_url: 'https://video.example/workbench'
    })
    expect(data.message).toContain('无法确认')
    expect(ivServiceMock.videoStart).not.toHaveBeenCalled()
  })

  it('每次生成重新读取状态，网页批准失效后不沿用上次结果', async () => {
    agentSessionGetByIdMock.mockReturnValue(makeSession())
    ivServiceMock.getRecords.mockReturnValue(null)
    ivServiceMock.videoStart.mockClear()
    ivServiceMock.videoStart.mockResolvedValueOnce({ jobId: 'new-job' })
    ivServiceMock.workbenchGet
      .mockResolvedValueOnce({ generatable: true, blockers: [] })
      .mockResolvedValueOnce({ generatable: false, blockers: ['awaiting_script_review'] })
    ivServiceMock.workbenchOpen.mockResolvedValueOnce({ run: 'r1', workbench_url: 'https://video.example/workbench' })
    const tools = makeTools()
    expect(jsonOf(await tools.call('ivideo_start', { run: 'r1' }))).toMatchObject({ jobId: 'new-job' })
    expect(jsonOf(await tools.call('ivideo_start', { run: 'r1' }))).toMatchObject({ started: false, end_turn: true })
    expect(ivServiceMock.videoStart).toHaveBeenCalledExactlyOnceWith({ sessionId: 's1', run: 'r1' })
  })

  it('旧审核入口返回工作台并要求结束本轮，不再读取本地审核快照', async () => {
    agentSessionGetByIdMock.mockReturnValue(makeSession())
    ivServiceMock.workbenchOpen.mockResolvedValue({ run: 'r1', workbench_url: 'https://video.example/workbench' })
    const result = await makeTools().call('ivideo_review_snapshot_get', { run: 'r1' })
    const data = JSON.parse((result.content[0] as { text: string }).text)
    expect(data).toMatchObject({ ok: true, end_turn: true, workbench_url: 'https://video.example/workbench' })
    expect(data.message).toContain('开始生成视频')
  })

  it('服务端未批准时不提交生成', async () => {
    agentSessionGetByIdMock.mockReturnValue(makeSession())
    ivServiceMock.videoStart.mockClear()
    ivServiceMock.workbenchGet.mockResolvedValue({ generatable: false, blockers: ['awaiting_script_review'] })
    ivServiceMock.workbenchOpen.mockResolvedValue({ run: 'r1', workbench_url: 'https://video.example/workbench' })
    const result = await makeTools().call('ivideo_start', { run: 'r1' })
    const data = JSON.parse((result.content[0] as { text: string }).text)
    expect(data.started).toBe(false)
    expect(data.end_turn).toBe(true)
    expect(ivServiceMock.videoStart).not.toHaveBeenCalled()
  })
})

it('已有作业时只查询，不再次提交生成', async () => {
  agentSessionGetByIdMock.mockReturnValue(makeSession())
  ivServiceMock.videoStart.mockClear()
  ivServiceMock.getRecords.mockReturnValueOnce({ run: 'r1', jobId: 'job-existing' })
  ivServiceMock.jobGet.mockResolvedValueOnce({ status: 'running' })
  const result = await makeTools().call('ivideo_start', { run: 'r1' })
  expect(jsonOf(result)).toMatchObject({ ok: true, jobId: 'job-existing', started: false, status: 'running' })
  expect(ivServiceMock.videoStart).not.toHaveBeenCalled()
})

describe('生成入口已有作业分流', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    agentSessionGetByIdMock.mockReturnValue(makeSession())
    ivServiceMock.getRecords.mockReturnValue({ run: 'r1', jobId: 'old-job' })
    ivServiceMock.workbenchGet.mockResolvedValue({ generatable: true, blockers: [] })
    ivServiceMock.videoStart.mockResolvedValue({ jobId: 'new-job' })
  })

  it.each(['done', 'failed', 'blocked', 'canceled', 'cancelled'])(
    '已有作业确认终态 %s 后重新检查并提交一次',
    async (status) => {
      ivServiceMock.jobGet.mockResolvedValueOnce({ run: 'r1', status })
      const result = jsonOf(await makeTools().call('ivideo_start', { run: 'r1' }))
      expect(result).toMatchObject({ ok: true, jobId: 'new-job' })
      expect(ivServiceMock.workbenchGet).toHaveBeenCalledExactlyOnceWith({ sessionId: SESSION_ID, run: 'r1' })
      expect(ivServiceMock.videoStart).toHaveBeenCalledExactlyOnceWith({ sessionId: SESSION_ID, run: 'r1' })
    }
  )

  it.each(['queued', 'running', 'processing', 'unrecognized', undefined])(
    '已有作业状态 %s 未确认终态时不提交',
    async (status) => {
      ivServiceMock.jobGet.mockResolvedValueOnce({ run: 'r1', status })
      expect(jsonOf(await makeTools().call('ivideo_start', { run: 'r1' }))).toMatchObject({ started: false })
      expect(ivServiceMock.videoStart).not.toHaveBeenCalled()
      expect(ivServiceMock.workbenchGet).not.toHaveBeenCalled()
    }
  )

  it('查询失败不重发生成', async () => {
    ivServiceMock.jobGet.mockRejectedValueOnce(new Error('offline'))
    expect(jsonOf(await makeTools().call('ivideo_start', { run: 'r1' }))).toMatchObject({ ok: false })
    expect(ivServiceMock.videoStart).not.toHaveBeenCalled()
  })

  it('终态但run不匹配不能放行', async () => {
    ivServiceMock.jobGet.mockResolvedValueOnce({ run: 'other', status: 'done' })
    expect(jsonOf(await makeTools().call('ivideo_start', { run: 'r1' }))).toMatchObject({ started: false })
    expect(ivServiceMock.videoStart).not.toHaveBeenCalled()
  })

  it('旧任务完成但网页已失效时引导回工作台，不提交', async () => {
    ivServiceMock.jobGet.mockResolvedValueOnce({ run: 'r1', status: 'done' })
    ivServiceMock.workbenchGet.mockResolvedValueOnce({ generatable: false, blockers: ['awaiting_script_review'] })
    ivServiceMock.workbenchOpen.mockResolvedValueOnce({ run: 'r1', workbench_url: 'https://video.example/workbench' })
    expect(jsonOf(await makeTools().call('ivideo_start', { run: 'r1' }))).toMatchObject({
      started: false,
      end_turn: true,
      workbench_url: 'https://video.example/workbench'
    })
    expect(ivServiceMock.videoStart).not.toHaveBeenCalled()
  })
})

function makeStoryboard() {
  return {
    video_title: '安全操作',
    scenes: [
      {
        id: 1,
        title: '停机确认',
        duration: 6,
        prompt: '工业车间内静止且已隔离的电机。',
        prompt_en: 'A stationary isolated motor in an industrial workshop.',
        narration: [{ text: '维护前停机并确认断电。', start: 0, end: 6 }]
      }
    ]
  }
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0]?.type === 'text' ? (result.content[0].text ?? '') : ''
}

function jsonOf(result: { content: Array<{ type: string; text?: string }> }): any {
  return JSON.parse(textOf(result))
}

describe('MeacoworkIndustrialVideoTools — visibility & contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    agentSessionGetByIdMock.mockReturnValue(makeSession())
    for (const fn of Object.values(ivServiceMock)) (fn as Mock).mockReset()
    ivServiceMock.workbenchGet.mockResolvedValue({ generatable: true, blockers: [] })
    ivServiceMock.getExecutionToken.mockReturnValue(Object.freeze({ sessionId: SESSION_ID, epoch: 1 }))
    ivServiceMock.withExecution.mockImplementation((_token, fn) => fn())
  })

  it('旧轮工具不能借用新轮权限发起写请求', async () => {
    const token = Object.freeze({ sessionId: SESSION_ID, epoch: 1 })
    ivServiceMock.getExecutionToken.mockReturnValue(token)
    ivServiceMock.assertExecution.mockImplementation(() => {
      throw new IpcError('IVIDEO_STOPPED', '旧轮已失效')
    })
    const provider = makeTools()
    ivServiceMock.runCreate.mockResolvedValue({ run: 'unexpected' })
    const result = await provider.call('ivideo_run_create', { baseName: '返修' })
    expect(jsonOf(result)).toMatchObject({ ok: false, error: { code: 'IVIDEO_STOPPED' } })
    expect(ivServiceMock.runCreate).not.toHaveBeenCalled()
    ivServiceMock.assertExecution.mockReset()
  })

  it('exposes only the production operations plus the read-only review snapshot (no confirm surface)', () => {
    const names = makeTools()
      .tools()
      .map((t) => t.name)
      .sort()
    expect(names).toEqual(
      [
        'ivideo_context',
        'ivideo_download',
        'ivideo_estimate',
        'ivideo_parse',
        'ivideo_run_create',
        'ivideo_review_snapshot_get',
        'ivideo_start',
        'ivideo_status',
        'ivideo_storyboard_get',
        'ivideo_storyboard_submit',
        'ivideo_tts_options_get'
      ].sort()
    )
    // The provider only claims its own allowlisted names, not inherited object keys.
    const provider = makeTools()
    expect(provider.handles('ivideo_run_create')).toBe(true)
    expect(provider.handles('web_search')).toBe(false)
    expect(provider.handles('constructor')).toBe(false)
    expect(provider.handles('toString')).toBe(false)
  })

  it('读取审核快照时注入可信会话，且不暴露确认工具', async () => {
    const snapshot = {
      review_version: 'review-7',
      script: '真实脚本',
      storyboard: makeStoryboard(),
      remaining_blockers: ['awaiting_script_review']
    }
    void snapshot
    ivServiceMock.workbenchOpen.mockResolvedValue({ run: 'r-1', workbench_url: 'https://video.example/workbench' })

    const provider = makeTools()
    const result = await provider.call('ivideo_review_snapshot_get', { run: 'r-1' })

    expect(jsonOf(result)).toMatchObject({ ok: true, run: 'r-1', end_turn: true })
    expect(ivServiceMock.workbenchOpen).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      run: 'r-1',
      embed: true
    })
    expect(ivServiceMock.reviewSnapshotGet).not.toHaveBeenCalled()
    expect(provider.handles('ivideo_review_confirm')).toBe(false)
  })

  it('可信审核后跳过估价直接启动生成，不再要求费用确认', () => {
    for (const tool of makeTools().tools()) {
      // 默认在线预览，下载不得成为制作流程的自动尾步。
      expect(tool.description).toContain('审核与成本确认均在网页完成')
      expect(tool.description).toContain('用户下一轮')
      expect(tool.description).toContain('结束本轮')
      expect(tool.description).not.toContain('用户确认生成及费用')
    }
  })

  it('every tool description documents the production workflow', () => {
    for (const tool of makeTools().tools()) {
      expect(tool.description).toMatch(/run_create|parse|storyboard|start|status|download/i)
      // Each description must point the model at the ordered pipeline.
      // expect(tool.description.toLowerCase()).toContain('run_create')
      expect(tool.description?.toLowerCase()).toContain('run_create')
    }
  })

  it('要求在生成前通过原生 AskUserQuestion 取得用户确认，而不是用 start 探测批准', () => {
    for (const tool of makeTools().tools()) {
      expect(tool.description).toContain('禁止再弹 AskUserQuestion')
      expect(tool.description).toContain('服务端最新状态')
      expect(tool.description).toContain('不满足则回工作台并结束')
      expect(tool.description).not.toContain('call estimate then start')
      expect(tool.description).not.toContain('storyboard_submit → estimate → start')
    }
  })

  it('公开的分镜提交 schema 允许首次无分镜时使用空 SHA，但仍要求该字段存在且为字符串', () => {
    const tool = makeTools()
      .tools()
      .find((tool) => tool.name === 'ivideo_storyboard_submit')!
    // const schema = z.fromJSONSchema(tool.inputSchema)
    const schema = z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0])
    const input = {
      run: 'r-1',
      storyboard: makeStoryboard(),
      expectedInputFingerprint: 'fp'
    }

    expect(schema.safeParse({ ...input, expectedStoryboardSha256: '' }).success).toBe(true)
    expect(schema.safeParse({ ...input, expectedStoryboardSha256: 'h' }).success).toBe(true)
    expect(schema.safeParse(input).success).toBe(false)
    expect(schema.safeParse({ ...input, expectedStoryboardSha256: null }).success).toBe(false)
    expect(schema.safeParse({ ...input, expectedStoryboardSha256: 1 }).success).toBe(false)
  })

  it('拒绝空分镜，避免 Agent 在首次规划时提交 storyboard 空对象', () => {
    const tool = makeTools()
      .tools()
      .find((tool) => tool.name === 'ivideo_storyboard_submit')!
    const schema = z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0])
    const input = { run: 'r-1', expectedInputFingerprint: 'fp', expectedStoryboardSha256: '' }

    expect(schema.safeParse({ ...input, storyboard: {} }).success).toBe(false)
    expect(schema.safeParse({ ...input, storyboard: { video_title: '安全操作', scenes: [] } }).success).toBe(false)
    expect(schema.safeParse({ ...input, storyboard: { video_title: '安全操作', scenes: [{}] } }).success).toBe(false)
    expect(
      schema.safeParse({ ...input, storyboard: { video_title: ' ', scenes: makeStoryboard().scenes } }).success
    ).toBe(false)
  })

  it('拒绝缺失或非法 prompt_en，避免把英文视觉提示词只写入 prompt', async () => {
    const base = makeStoryboard()
    const scene = base.scenes[0]
    const call = (overrides: Record<string, unknown>) =>
      makeTools().call('ivideo_storyboard_submit', {
        run: 'r-1',
        storyboard: { ...base, scenes: [{ ...scene, ...overrides }] },
        expectedInputFingerprint: 'fp',
        expectedStoryboardSha256: ''
      })

    const missing = await call({ prompt_en: undefined })
    const tooShort = await call({ prompt_en: 'Too short' })
    const chinese = await call({ prompt_en: 'A detailed visual prompt mixed with 中文内容.' })

    expect(missing.isError).toBe(true)
    expect(tooShort.isError).toBe(true)
    expect(chinese.isError).toBe(true)
    expect(ivServiceMock.storyboardSubmit).not.toHaveBeenCalled()
  })

  it('明确要求首次规划先按 context schema 编写并提交分镜，再调用 storyboard_get', () => {
    const tools = makeTools().tools()
    const context = tools.find((tool) => tool.name === 'ivideo_context')!
    const get = tools.find((tool) => tool.name === 'ivideo_storyboard_get')!
    const submit = tools.find((tool) => tool.name === 'ivideo_storyboard_submit')!

    expect(context.description).toContain('current_storyboard')
    expect(context.description).toContain('不要调用 storyboard_get')
    expect(get.description).toContain('仅用于读取已提交的分镜')
    expect(submit.description).toContain('storyboard_schema')
  })

  it('ivideo_parse 只接受服务端 HTTP 契约规定的内联文字结构和分辨率', () => {
    const tool = makeTools()
      .tools()
      .find((tool) => tool.name === 'ivideo_parse')!
    const schema = z.fromJSONSchema(tool.inputSchema as Parameters<typeof z.fromJSONSchema>[0])

    expect(
      schema.safeParse({ run: 'r-1', resolution: '1080P', texts: [{ text: '维护前必须断电', title: '操作要求' }] })
        .success
    ).toBe(true)
    expect(schema.safeParse({ run: 'r-1', resolution: '1080p', texts: [{ text: '维护前必须断电' }] }).success).toBe(
      false
    )
    expect(schema.safeParse({ run: 'r-1', texts: ['维护前必须断电'] }).success).toBe(false)
    expect(schema.safeParse({ run: 'r-1', texts: '维护前必须断电' }).success).toBe(false)
    expect(schema.safeParse({ run: 'r-1', texts: [{ name: '资料', content: '维护前必须断电' }] }).success).toBe(false)
  })

  it('advertises object input schemas without a $schema dialect marker', () => {
    for (const tool of makeTools().tools()) {
      expect(tool.inputSchema.type).toBe('object')
      expect((tool.inputSchema as Record<string, unknown>).$schema).toBeUndefined()
    }
  })
})

describe('MeacoworkIndustrialVideoTools — routing to the trusted service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    agentSessionGetByIdMock.mockReturnValue(makeSession())
    for (const fn of Object.values(ivServiceMock)) (fn as Mock).mockReset()
    ivServiceMock.workbenchGet.mockResolvedValue({ generatable: true, blockers: [] })
    ivServiceMock.getExecutionToken.mockReturnValue(Object.freeze({ sessionId: SESSION_ID, epoch: 1 }))
    ivServiceMock.withExecution.mockImplementation((_token, fn) => fn())
  })

  it('ivideo_run_create calls runCreate with the injected sessionId (no token, no supplied sessionId)', async () => {
    ivServiceMock.runCreate.mockResolvedValue({ run: 'r-1' })
    const result = await makeTools().call('ivideo_run_create', { baseName: 'demo', prefix: 'p' })

    expect(result.isError).toBeFalsy()
    expect(jsonOf(result)).toEqual({ ok: true, run: 'r-1' })
    expect(ivServiceMock.runCreate).toHaveBeenCalledTimes(1)
    const arg = ivServiceMock.runCreate.mock.calls[0][0]
    expect(arg).toMatchObject({ sessionId: SESSION_ID, baseName: 'demo', prefix: 'p' })
    // The token is resolved only in the main process; the model never sees or sends it.
    expect(arg).not.toHaveProperty('token')
  })

  it('ivideo_context routes to planningContextGet', async () => {
    ivServiceMock.planningContextGet.mockResolvedValue({ input_fingerprint: 'fp', expected_storyboard_sha256: 'h' })
    const result = await makeTools().call('ivideo_context', { run: 'r-1' })
    expect(jsonOf(result)).toMatchObject({ ok: true, input_fingerprint: 'fp' })
    expect(ivServiceMock.planningContextGet).toHaveBeenCalledWith({ sessionId: SESSION_ID, run: 'r-1' })
  })

  it('ivideo_storyboard_get defaults full=true and routes to storyboardGet', async () => {
    ivServiceMock.storyboardGet.mockResolvedValue({ video_title: 't' })
    await makeTools().call('ivideo_storyboard_get', { run: 'r-1' })
    expect(ivServiceMock.storyboardGet).toHaveBeenCalledWith({ sessionId: SESSION_ID, run: 'r-1', full: true })
  })

  it('无已提交分镜时返回可执行的首次规划指引', async () => {
    ivServiceMock.storyboardGet.mockRejectedValue(
      new IpcError('IVIDEO_HTTP_ERROR', '该 run 尚无分镜脚本(storyboard.json 不存在): r-1')
    )
    const result = await makeTools().call('ivideo_storyboard_get', { run: 'r-1' })

    expect(result.isError).toBe(true)
    expect(jsonOf(result).error).toEqual({
      code: 'IVIDEO_STORYBOARD_NOT_FOUND',
      message:
        '该 run 尚无已提交分镜。请调用 ivideo_context，依据返回的 storyboard_schema、素材与 guidance 编写完整分镜，再调用 ivideo_storyboard_submit；不要提交空 storyboard。'
    })
  })

  it('其他 storyboard_get 服务端错误保持原始错误码和消息', async () => {
    ivServiceMock.storyboardGet.mockRejectedValue(new IpcError('IVIDEO_HTTP_ERROR', '读取 storyboard.json 失败: r-1'))
    const result = await makeTools().call('ivideo_storyboard_get', { run: 'r-1' })

    expect(jsonOf(result).error).toEqual({ code: 'IVIDEO_HTTP_ERROR', message: '读取 storyboard.json 失败: r-1' })
  })

  it('拒绝空场景且不调用分镜提交服务', async () => {
    const result = await makeTools().call('ivideo_storyboard_submit', {
      run: 'r-1',
      storyboard: { video_title: '安全操作', scenes: [{}] },
      expectedInputFingerprint: 'fp',
      expectedStoryboardSha256: ''
    })

    expect(result.isError).toBe(true)
    expect(jsonOf(result).ok).toBe(false)
    expect(ivServiceMock.storyboardSubmit).not.toHaveBeenCalled()
  })

  it('ivideo_storyboard_submit routes to storyboardSubmit with the four declared fields', async () => {
    ivServiceMock.storyboardSubmit.mockResolvedValue({ submitted: true, reviewRequired: true })
    const result = await makeTools().call('ivideo_storyboard_submit', {
      run: 'r-1',
      // storyboard: { scenes: [] },
      storyboard: makeStoryboard(),
      expectedInputFingerprint: 'fp',
      expectedStoryboardSha256: 'h'
    })
    expect(jsonOf(result)).toMatchObject({ ok: true, submitted: true, reviewRequired: true })
    expect(ivServiceMock.storyboardSubmit).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      run: 'r-1',
      // storyboard: { scenes: [] },
      storyboard: makeStoryboard(),
      expectedInputFingerprint: 'fp',
      expectedStoryboardSha256: 'h'
    })
  })

  it('首次提交将空 SHA 原样传递给服务，待审核结果不触发后续生成', async () => {
    ivServiceMock.storyboardSubmit.mockResolvedValue({ submitted: true, reviewRequired: true })
    const input = {
      run: 'r-1',
      // storyboard: { scenes: [] },
      storyboard: makeStoryboard(),
      expectedInputFingerprint: 'fp',
      expectedStoryboardSha256: ''
    }
    const result = await makeTools().call('ivideo_storyboard_submit', input)

    expect(result.isError).toBeFalsy()
    expect(jsonOf(result)).toEqual({ ok: true, submitted: true, reviewRequired: true })
    expect(ivServiceMock.storyboardSubmit).toHaveBeenCalledExactlyOnceWith({ sessionId: SESSION_ID, ...input })
    expect(ivServiceMock.estimate).not.toHaveBeenCalled()
    expect(ivServiceMock.videoStart).not.toHaveBeenCalled()
  })

  it.each([undefined, null, 1])('拒绝非法 SHA %s 且不调用分镜提交服务', async (sha) => {
    const result = await makeTools().call('ivideo_storyboard_submit', {
      run: 'r-1',
      storyboard: makeStoryboard(),
      expectedInputFingerprint: 'fp',
      ...(sha === undefined ? {} : { expectedStoryboardSha256: sha })
    })

    expect(result.isError).toBe(true)
    expect(jsonOf(result).ok).toBe(false)
    expect(ivServiceMock.storyboardSubmit).not.toHaveBeenCalled()
  })

  it('未获审核批准的 start 保持失败，不返回生成任务', async () => {
    ivServiceMock.videoStart.mockRejectedValue(new IpcError('IVIDEO_REVIEW_REQUIRED', '等待可信审核'))
    const result = await makeTools().call('ivideo_start', { run: 'r-1' })

    expect(result.isError).toBe(true)
    expect(jsonOf(result)).toEqual({
      ok: false,
      error: { code: 'IVIDEO_REVIEW_REQUIRED', message: '等待可信审核' }
    })
    expect(jsonOf(result)).not.toHaveProperty('jobId')
    expect(ivServiceMock.jobGet).not.toHaveBeenCalled()
  })

  it('ivideo_parse forwards run + settings + payloads to parse', async () => {
    ivServiceMock.parse.mockResolvedValue({ jobId: 'j-1', settingsVersion: 3 })
    const result = await makeTools().call('ivideo_parse', {
      run: 'r-1',
      voice: 'zh-CN-XiaoxiaoNeural',
      aspectRatio: '16:9',
      style: 'marketing',
      targetDurationS: 60,
      texts: [{ text: 'x' }],
      media: [],
      logo: null
    })
    expect(jsonOf(result)).toMatchObject({ ok: true, jobId: 'j-1', settingsVersion: 3 })
    expect(ivServiceMock.parse).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        run: 'r-1',
        voice: 'zh-CN-XiaoxiaoNeural',
        aspectRatio: '16:9',
        style: 'marketing',
        targetDurationS: 60,
        texts: [{ text: 'x' }],
        media: [],
        logo: null
      })
    )
  })

  it('ivideo_estimate routes to estimate (read-only fee pre-check)', async () => {
    ivServiceMock.estimate.mockResolvedValue({ estimate: { fee: 10 } })
    const result = await makeTools().call('ivideo_estimate', { run: 'r-1' })
    expect(jsonOf(result)).toMatchObject({ ok: true, estimate: { fee: 10 } })
    expect(ivServiceMock.estimate).toHaveBeenCalledWith(expect.objectContaining({ sessionId: SESSION_ID, run: 'r-1' }))
  })

  it('ivideo_start routes to videoStart (server still enforces review approval)', async () => {
    ivServiceMock.videoStart.mockResolvedValue({ jobId: 'j-2', approvalInvalidated: false })
    const result = await makeTools().call('ivideo_start', { run: 'r-1', resolution: '1080P' })
    expect(jsonOf(result)).toMatchObject({ ok: true, jobId: 'j-2' })
    expect(ivServiceMock.videoStart).toHaveBeenCalledWith({ sessionId: SESSION_ID, run: 'r-1' })
  })

  it('ivideo_status routes to jobGet', async () => {
    ivServiceMock.jobGet.mockResolvedValue({ run: 'r-1', status: 'done' })
    const result = await makeTools().call('ivideo_status', { jobId: 'j-2', waitS: 2, tailLines: 10 })
    expect(jsonOf(result)).toMatchObject({ ok: true, status: 'done' })
    expect(ivServiceMock.jobGet).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      jobId: 'j-2',
      waitS: 2,
      tailLines: 10
    })
  })

  it('ivideo_download routes to downloadArtifact', async () => {
    ivServiceMock.downloadArtifact.mockResolvedValue({ filePath: '/ws/m.mp4', size: 123 })
    const result = await makeTools().call('ivideo_download', { run: 'r-1', path: 'movie.mp4', expectedSize: 123 })
    expect(jsonOf(result)).toMatchObject({ ok: true, filePath: '/ws/m.mp4', size: 123 })
    expect(ivServiceMock.downloadArtifact).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      run: 'r-1',
      path: 'movie.mp4',
      expectedSize: 123
    })
  })
})

describe('MeacoworkIndustrialVideoTools — call-time re-validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const fn of Object.values(ivServiceMock)) (fn as Mock).mockReset()
    ivServiceMock.workbenchGet.mockResolvedValue({ generatable: true, blockers: [] })
    ivServiceMock.getExecutionToken.mockReturnValue(Object.freeze({ sessionId: SESSION_ID, epoch: 1 }))
    ivServiceMock.withExecution.mockImplementation((_token, fn) => fn())
  })

  it('rejects when the active runtime no longer owns the session (agentId mismatch)', async () => {
    agentSessionGetByIdMock.mockReturnValue(makeSession({ agentId: 'agent-other' }))
    const result = await makeTools().call('ivideo_run_create', { baseName: 'demo' })
    expect(result.isError).toBe(true)
    expect(jsonOf(result).ok).toBe(false)
    expect(jsonOf(result).error.code).toBe('IVIDEO_SESSION_FORBIDDEN')
    expect(jsonOf(result).error.message).toMatch(/does not own/i)
    expect(ivServiceMock.runCreate).not.toHaveBeenCalled()
  })

  it('rejects a session that is not an industrial-video session', async () => {
    agentSessionGetByIdMock.mockReturnValue(makeSession({ featureKind: 'general' }))
    const result = await makeTools().call('ivideo_run_create', { baseName: 'demo' })
    expect(result.isError).toBe(true)
    expect(jsonOf(result).error.code).toBe('IVIDEO_SESSION_INVALID')
    expect(ivServiceMock.runCreate).not.toHaveBeenCalled()
  })

  it('rejects a missing session', async () => {
    agentSessionGetByIdMock.mockImplementation(() => {
      throw new Error('not found')
    })
    const result = await makeTools().call('ivideo_run_create', { baseName: 'demo' })
    expect(result.isError).toBe(true)
    expect(jsonOf(result).error.code).toBe('IVIDEO_SESSION_INVALID')
    expect(ivServiceMock.runCreate).not.toHaveBeenCalled()
  })
})

describe('MeacoworkIndustrialVideoTools — structured failure, never leaks the token', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    agentSessionGetByIdMock.mockReturnValue(makeSession())
    for (const fn of Object.values(ivServiceMock)) (fn as Mock).mockReset()
    ivServiceMock.workbenchGet.mockResolvedValue({ generatable: true, blockers: [] })
    ivServiceMock.getExecutionToken.mockReturnValue(Object.freeze({ sessionId: SESSION_ID, epoch: 1 }))
    ivServiceMock.withExecution.mockImplementation((_token, fn) => fn())
  })

  it('turns a service IpcError into a structured error result and never exposes the token', async () => {
    ivServiceMock.runCreate.mockRejectedValue(
      new IpcError('IVIDEO_NOT_CONFIGURED', 'Industrial-video service not configured')
    )
    const result = await makeTools().call('ivideo_run_create', { baseName: 'demo' })
    expect(result.isError).toBe(true)
    const body = jsonOf(result)
    expect(body).toEqual({
      ok: false,
      error: { code: 'IVIDEO_NOT_CONFIGURED', message: 'Industrial-video service not configured' }
    })
    expect(JSON.stringify(result)).not.toContain('token')
  })

  it('does not expose any injected credentials on a successful call', async () => {
    ivServiceMock.runCreate.mockResolvedValue({ run: 'r-1' })
    const result = await makeTools().call('ivideo_run_create', { baseName: 'demo' })
    expect(JSON.stringify(result)).not.toContain('token')
  })

  it('ivideo_tts_options_get 返回服务端完整语言音色目录', async () => {
    ivServiceMock.ttsOptionsGet.mockResolvedValue({
      languages: [{ id: 'zh', default_voice: 'v-zh' }],
      voices: [{ id: 'v-zh', language: 'zh', label: '中文' }]
    })
    const result = await makeTools().call('ivideo_tts_options_get', {})
    expect(ivServiceMock.ttsOptionsGet).toHaveBeenCalledWith({ sessionId: SESSION_ID })
    const body = jsonOf(result)
    expect(body).toMatchObject({
      ok: true,
      languages: [{ id: 'zh', default_voice: 'v-zh' }],
      voices: [{ id: 'v-zh', language: 'zh', label: '中文' }]
    })
  })

  it('ivideo_parse 转发 language / narrativeStyle 到 service（snake_case 由 service 负责）', async () => {
    ivServiceMock.parse.mockResolvedValue({ jobId: 'j1' })
    await makeTools().call('ivideo_parse', { run: 'r1', language: 'en', narrativeStyle: 'wuxia' })
    expect(ivServiceMock.parse).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION_ID, run: 'r1', language: 'en', narrativeStyle: 'wuxia' })
    )
  })
})
