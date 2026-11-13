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

// 服务端固定支持的字幕译文语言（COWORK_HTTP_GUIDE §17，storyboard.schema.json translations
// propertyNames.enum）。translations 仅接受这 8 个语言代码，不得出现其它代码（如 'xx'）。
const SERVER_SUBTITLE_LANGS = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', 'es-ES', 'fr-FR', 'de-DE'] as const

// 构建覆盖服务端 8 语言、每条均为合法非空译文的 translations 映射。
function fullTranslations(value = 'translated'): Record<string, string> {
  return Object.fromEntries(SERVER_SUBTITLE_LANGS.map((lang) => [lang, value]))
}

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

it('模型实际工具定义与服务端完整分镜契约逐字段一致', async () => {
  const { storyboardSchema } = await import('@main/features/industrialVideo/industrialVideoStoryboardSchema')
  const tool = makeTools()
    .tools()
    .find((item) => item.name === 'ivideo_storyboard_submit')!
  expect(tool.inputSchema.properties?.storyboard).toEqual(storyboardSchema)
  const scene = (tool.inputSchema.properties?.storyboard as any).properties.scenes.items
  expect(scene.required).toEqual(
    expect.arrayContaining([
      'operation_type',
      'granularity',
      'operation_type_options',
      'granularity_options',
      'state_transition'
    ])
  )
  expect(scene.properties.state_transition.required).toEqual(
    expect.arrayContaining(['before', 'after', 'action_en', 'contact_en', 'verification_en', 'source_lines', 'phases'])
  )
})

it('三个镜头完整动作字段经工具层传递到服务且不裁剪合法扩展字段', async () => {
  agentSessionGetByIdMock.mockReturnValue(makeSession())
  ivServiceMock.storyboardSubmit.mockClear()
  ivServiceMock.storyboardSubmit.mockResolvedValue({ submitted: true, reviewRequired: true })
  const board = makeStoryboard()
  board.scenes = [1, 2, 3].map((id) => ({
    ...structuredClone(board.scenes[0]),
    id,
    scene_uid: `scene-${id}`,
    media_refs: ['asset-1'],
    media_notes: { 'asset-1': '设备' }
  }))
  const result = await makeTools().call('ivideo_storyboard_submit', {
    run: 'r1',
    storyboard: board,
    expectedInputFingerprint: 'fp',
    expectedStoryboardSha256: '',
    expectedDocumentVersion: 7
  })
  expect(result.isError).toBeFalsy()
  expect(ivServiceMock.storyboardSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ storyboard: board, expectedDocumentVersion: 7 })
  )
})

it('空状态首次返回当前模型纠错任务，重复错误停止且不发送服务端', async () => {
  agentSessionGetByIdMock.mockReturnValue(makeSession())
  ivServiceMock.storyboardSubmit.mockClear()
  const tools = makeTools()
  const board = makeStoryboard()
  board.scenes[0].state_transition.before = {} as (typeof board.scenes)[0]['state_transition']['before']
  board.scenes[0].state_transition.after = {} as (typeof board.scenes)[0]['state_transition']['after']
  const args = { run: 'repair-run', storyboard: board, expectedInputFingerprint: 'fp', expectedStoryboardSha256: '' }
  const first = await tools.call('ivideo_storyboard_submit', args)
  expect(first._meta?.industrialVideoValidationError).toBe(true)
  const task = jsonOf(first).repair_task
  expect(task).toMatchObject({
    run: 'repair-run',
    execution_model: 'current_selected_model',
    next_operation: 'ivideo_context'
  })
  expect(task.candidate_storyboard).toEqual(board)
  expect(task.validation_error).toContain('state_transition.after')
  const second = await tools.call('ivideo_storyboard_submit', args)
  expect(jsonOf(second).error.code).toBe('IVIDEO_STORYBOARD_RETRY_STOPPED')
  expect(second._meta?.industrialVideoValidationError).toBeUndefined()
  expect(ivServiceMock.storyboardSubmit).not.toHaveBeenCalled()
})

it('首次规划向模型交付服务端任务、真实来源和非空状态要求', async () => {
  agentSessionGetByIdMock.mockReturnValue(makeSession())
  const context = {
    client_planning_task: { task: '按来源生成' },
    source_lines: [{ line: 5, text: '授权资料' }],
    current_storyboard: null,
    storyboard_schema: { type: 'object', properties: {} },
    input_fingerprint: 'fp',
    expected_storyboard_sha256: '',
    document: { version: 0 }
  }
  ivServiceMock.planningContextGet.mockResolvedValueOnce(context)
  const result = jsonOf(await makeTools().call('ivideo_context', { run: 'r1' }))
  expect(result.client_planning_task).toEqual(context.client_planning_task)
  expect(result.source_lines).toEqual(context.source_lines)
  expect(result.client_generation_requirements.before_first_submit).toContain('before/after')
  expect(result.client_generation_requirements.before_first_submit).toContain('不得提交空对象')
  expect(result.client_generation_requirements.execution_model).toBe('current_selected_model')
  expect(result.client_generation_requirements).toHaveProperty('state_object_contract')
})

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

// 服务端完整 STORYBOARD_SCHEMA（storyboard.schema.json）：每个 scene 必填 id/title/duration/
// prompt/narration + 动作规划五件套（operation_type/granularity/operation_type_options/
// granularity_options/state_transition），state_transition 必含 before/after/action_en/contact_en/
// verification_en/source_lines/phases。prompt_en 为可选字段（服务端 schema 未列入 required）。
// 旧六字段版已升级为完整合法 fixture。
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
        narration: [{ text: '维护前停机并确认断电。', start: 0, end: 6 }],
        operation_type: 'inspect',
        granularity: 'measurement',
        operation_type_options: ['inspect', 'measure'],
        granularity_options: ['measurement'],
        state_transition: {
          before: { 轴承座: '待测量' },
          after: { 轴承座: '间隙已确认' },
          action_en: 'Measure the axial clearance of the seated bearing housing.',
          contact_en: 'Probe lightly touches the housing shoulder.',
          verification_en: 'Clearance verified within tolerance.',
          source_lines: [1],
          phases: [{ start: 0, end: 6, description_en: 'Probe contact and read clearance.' }]
        }
      }
    ]
  }
}

// 服务端 STORYBOARD_SCHEMA 对每个 scene 还要求动作规划五件套 + state_transition 七子字段。
// 升级后 makeStoryboard 已是完整合法 fixture，此处保留以保持历史引用兼容（等价展开）。
function makeCompleteStoryboard() {
  const storyboard = makeStoryboard()
  return {
    ...storyboard,
    scenes: [
      {
        ...storyboard.scenes[0],
        operation_type: 'inspect',
        granularity: 'measurement',
        operation_type_options: ['inspect', 'measure'],
        granularity_options: ['measurement'],
        state_transition: {
          before: { 轴承座: '待测量' },
          after: { 轴承座: '间隙已确认' },
          action_en: 'Measure the axial clearance of the seated bearing housing.',
          contact_en: 'Probe lightly touches the housing shoulder.',
          verification_en: 'Clearance verified within tolerance.',
          source_lines: [1],
          phases: [{ start: 0, end: 6, description_en: 'Probe contact and read clearance.' }]
        }
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
        'ivideo_storyboard_submit'
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
      schema.safeParse({ ...input, storyboard: { video_title: '', scenes: makeStoryboard().scenes } }).success
    ).toBe(false)
  })

  // 服务端完整 schema 中 prompt_en 为可选字段（未列入 scene.required），不再强制英文或最小长度。
  // 完整分镜缺省 / 含中文 / 短文本均通过本地与结构校验，不拦截。
  it('prompt_en 可选：完整分镜缺省或含中文/短文本均通过校验，不再强制英文', async () => {
    ivServiceMock.storyboardSubmit.mockResolvedValue({ submitted: true, reviewRequired: true })
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
    const chinese = await call({ prompt_en: '一个中文英文适配字段。' })

    expect(jsonOf(missing).ok).toBe(true)
    expect(jsonOf(tooShort).ok).toBe(true)
    expect(jsonOf(chinese).ok).toBe(true)
    expect(ivServiceMock.storyboardSubmit).toHaveBeenCalledTimes(3)
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
    // {name}/{url} 引用形态已停用：客户端附件自动提取，模型传不出合法 uploads/ 句柄
    expect(schema.safeParse({ run: 'r-1', texts: [{ name: '参数表.txt', title: '参数表' }] }).success).toBe(false)
    expect(schema.safeParse({ run: 'r-1', texts: [{ url: 'https://example.com/a.md' }] }).success).toBe(false)
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

  // 服务端 get_context 恒全量返回（source_text/source_lines/materials.texts 是同一份 manual.md 的
  // 多种形态）。包装层瘦身：materials[].text 改为 text_chars 元数据（全文保留在 source_text），
  // 但 source_lines 保留——它是服务端真实来源行号，供当前模型规划与纠错按行号锚定，不可丢弃。
  it('ivideo_context 瘦身：去 materials[].text（改 text_chars），保留 source_text 与 source_lines', async () => {
    ivServiceMock.planningContextGet.mockResolvedValue({
      input_fingerprint: 'fp',
      source_text: '第1行\n第2行\n第3行',
      source_lines: [
        { line: 1, text: '第1行' },
        { line: 2, text: '第2行' },
        { line: 3, text: '第3行' }
      ],
      materials: {
        schema_version: 2,
        texts: [
          { id: 'txt_001', title: '参数表.txt', text: '第1行\n第2行\n第3行', sha256: 'abc' },
          { id: 'txt_002', title: '手册.docx 1/2', text: '第1行', sha256: 'def' }
        ],
        media: [{ id: 'img_001', path: 'uploads/a.jpg', caption: '装配图' }],
        logo: null
      }
    })
    const result = await makeTools().call('ivideo_context', { run: 'r-1' })
    const data = jsonOf(result)
    expect(data.ok).toBe(true)
    expect(data.source_text).toBe('第1行\n第2行\n第3行')
    // source_lines 保留：服务端真实来源行号，模型按行号规划与纠错。
    expect(data.source_lines).toEqual([
      { line: 1, text: '第1行' },
      { line: 2, text: '第2行' },
      { line: 3, text: '第3行' }
    ])
    expect(data.materials.texts[0]).toEqual({ id: 'txt_001', title: '参数表.txt', sha256: 'abc', text_chars: 11 })
    expect(data.materials.texts[1]).toEqual({ id: 'txt_002', title: '手册.docx 1/2', sha256: 'def', text_chars: 3 })
    expect(data.materials.media).toEqual([{ id: 'img_001', path: 'uploads/a.jpg', caption: '装配图' }])
    // guidance/schema/settings 等其余字段原样保留
    expect(data.input_fingerprint).toBe('fp')
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
      storyboard: makeCompleteStoryboard(),
      expectedInputFingerprint: 'fp',
      expectedStoryboardSha256: 'h'
    })
    expect(jsonOf(result)).toMatchObject({ ok: true, submitted: true, reviewRequired: true })
    expect(ivServiceMock.storyboardSubmit).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      run: 'r-1',
      // storyboard: { scenes: [] },
      storyboard: makeCompleteStoryboard(),
      expectedInputFingerprint: 'fp',
      expectedStoryboardSha256: 'h'
    })
  })

  // 服务端完整 schema 通过 z.fromJSONSchema 直接校验：scene 缺动作规划五件套时由 zod 结构校验
  // 拦截（code=INTERNAL，错误信息以路径列出缺失字段），不发起服务端往返。
  it('scene 缺动作规划五件套时由 schema 拦截，不调服务端，错误列出缺失字段', async () => {
    ivServiceMock.storyboardSubmit.mockResolvedValue({ submitted: true })
    const storyboard = makeStoryboard() // 完整合法 fixture
    const scene = storyboard.scenes[0] as Record<string, unknown>
    // 删掉五件套，模拟模型漏填。
    delete scene.operation_type
    delete scene.granularity
    delete scene.operation_type_options
    delete scene.granularity_options
    delete scene.state_transition
    const result = await makeTools().call('ivideo_storyboard_submit', {
      run: 'r-1',
      storyboard,
      expectedInputFingerprint: 'fp',
      expectedStoryboardSha256: ''
    })
    expect(result.isError).toBe(true)
    const body = jsonOf(result)
    expect(body.ok).toBe(false)
    // 完整 schema 升级后，缺字段由 zod 结构校验抛出，归一化为 INTERNAL（不再是本地预校验的
    // IVIDEO_STORYBOARD_SCHEMA_INVALID）。
    expect(body.error.code).toBe('IVIDEO_STORYBOARD_SCHEMA_INVALID')
    expect(body.error.message).toContain('operation_type')
    expect(body.error.message).toContain('granularity')
    expect(body.error.message).toContain('state_transition')
    expect(ivServiceMock.storyboardSubmit).not.toHaveBeenCalled()
  })

  it('缺字段被拦截后携带可纠错标记，允许模型修改后重提', async () => {
    ivServiceMock.storyboardSubmit.mockResolvedValue({ submitted: true })
    const storyboard = makeStoryboard() // 完整合法 fixture
    const scene = storyboard.scenes[0] as Record<string, unknown>
    delete scene.operation_type
    delete scene.granularity
    delete scene.operation_type_options
    delete scene.granularity_options
    delete scene.state_transition
    const result = await makeTools().call('ivideo_storyboard_submit', {
      run: 'r-1',
      storyboard,
      expectedInputFingerprint: 'fp',
      expectedStoryboardSha256: ''
    })
    expect(result.isError).toBe(true)
    expect(result._meta?.industrialVideoValidationError).toBe(true)
  })

  it('state_transition 缺子字段时本地拦截并指出具体子字段', async () => {
    ivServiceMock.storyboardSubmit.mockResolvedValue({ submitted: true })
    const storyboard = makeCompleteStoryboard()
    delete (storyboard.scenes[0] as Record<string, unknown>).operation_type_options
    ;(storyboard.scenes[0] as Record<string, unknown>).state_transition = {
      before: { x: '1' },
      after: { x: '2' },
      action_en: 'Do it.',
      contact_en: 'Touch it.',
      verification_en: 'Done.',
      source_lines: [1],
      phases: [{ start: 0, end: 6, description_en: 'Step.' }]
      // 缺 verification_en 之外——删掉 contact_en 测试子字段报错
    }
    delete ((storyboard.scenes[0] as Record<string, unknown>).state_transition as Record<string, unknown>).contact_en
    const result = await makeTools().call('ivideo_storyboard_submit', {
      run: 'r-1',
      storyboard,
      expectedInputFingerprint: 'fp',
      expectedStoryboardSha256: ''
    })
    expect(result.isError).toBe(true)
    const body = jsonOf(result)
    // 完整 schema 升级后，缺子字段由 zod 结构校验抛出，归一化为 INTERNAL。
    expect(body.error.code).toBe('IVIDEO_STORYBOARD_SCHEMA_INVALID')
    expect(body.error.message).toContain('operation_type_options')
    expect(body.error.message).toContain('contact_en')
    expect(ivServiceMock.storyboardSubmit).not.toHaveBeenCalled()
  })

  it('首次提交将空 SHA 原样传递给服务，待审核结果不触发后续生成', async () => {
    ivServiceMock.storyboardSubmit.mockResolvedValue({ submitted: true, reviewRequired: true })
    const input = {
      run: 'r-1',
      // storyboard: { scenes: [] },
      storyboard: makeCompleteStoryboard(), // 服务端必填字段需齐全，本地预校验才放行
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

  it('固定英文音色 MCP 枚举允许并透传，拒绝未知音色', async () => {
    ivServiceMock.parse.mockResolvedValue({ jobId: 'j-en' })
    const provider = makeTools()
    const result = await provider.call('ivideo_parse', { run: 'r-1', voice: 'en-US-JennyNeural', subtitleLanguage: 'en-US', narrationFollowsSubtitles: true })
    expect(jsonOf(result).ok).toBe(true)
    expect(ivServiceMock.parse).toHaveBeenCalledWith(expect.objectContaining({ voice: 'en-US-JennyNeural', subtitleLanguage: 'en-US', narrationFollowsSubtitles: true }))
    ivServiceMock.parse.mockClear()
    const invalid = await provider.call('ivideo_parse', { run: 'r-1', voice: 'en-US-UnknownNeural' })
    expect(invalid.isError).toBe(true)
    expect(ivServiceMock.parse).not.toHaveBeenCalled()
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
})

describe('工业字幕适配（MCP 工具层）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    agentSessionGetByIdMock.mockReturnValue(makeSession())
    for (const fn of Object.values(ivServiceMock)) (fn as Mock).mockReset()
    ivServiceMock.workbenchGet.mockResolvedValue({ generatable: true, blockers: [] })
    ivServiceMock.getExecutionToken.mockReturnValue(Object.freeze({ sessionId: SESSION_ID, epoch: 1 }))
    ivServiceMock.withExecution.mockImplementation((_token, fn) => fn())
  })

  it('ivideo_storyboard_submit 接受 narration text 放宽到 200 字，translations 须覆盖服务端 8 语言', async () => {
    ivServiceMock.storyboardSubmit.mockResolvedValue({ submitted: true, reviewRequired: false })
    const longText = '维'.repeat(200)
    const board = makeCompleteStoryboard()
    // translations 仅接受服务端 8 语言代码（storyboard.schema.json propertyNames.enum），
    // 经 z.fromJSONSchema 转换后须提供全部 8 个键。
    const translations = Object.fromEntries(
      SERVER_SUBTITLE_LANGS.map((lang) => [
        lang,
        lang === 'en-US' ? 'Stop and confirm power off before maintenance.' : 'translated'
      ])
    )
    const result = await makeTools().call('ivideo_storyboard_submit', {
      run: 'r1',
      storyboard: {
        ...board,
        scenes: [
          {
            ...board.scenes[0],
            narration: [
              {
                text: longText,
                start: 0,
                end: 6,
                translations
              }
            ]
          }
        ]
      },
      expectedInputFingerprint: 'fp',
      expectedStoryboardSha256: 'sha'
    })
    expect(jsonOf(result)).toMatchObject({ ok: true, submitted: true })
    expect(ivServiceMock.storyboardSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        storyboard: expect.objectContaining({
          scenes: expect.arrayContaining([
            expect.objectContaining({
              narration: [
                {
                  text: longText,
                  start: 0,
                  end: 6,
                  translations
                }
              ]
            })
          ])
        })
      })
    )
  })

  it.each([
    { text: '维'.repeat(201), start: 0, end: 6 },
    { text: '维护', start: 0, end: 6, translations: { 'en-US': '' } },
    { text: '维护', start: 0, end: 6, translations: { 'en-US': '   ' } },
    { text: '维护', start: 0, end: 6, translations: { 'en-US': 'a'.repeat(501) } },
    { text: '维护', start: 0, end: 6, translations: { xx: 'translation' } },
    { text: '维护', start: 0, end: 6, injected: true }
  ])('拒绝非法旁白或译文，不提交分镜：%j', async (narration) => {
    const board = makeCompleteStoryboard()
    const result = await makeTools().call('ivideo_storyboard_submit', {
      run: 'r1',
      storyboard: { ...board, scenes: [{ ...board.scenes[0], narration: [narration] }] },
      expectedInputFingerprint: 'fp',
      expectedStoryboardSha256: 'sha'
    })
    expect(jsonOf(result).ok).toBe(false)
    expect(ivServiceMock.storyboardSubmit).not.toHaveBeenCalled()
  })

  // translations 须覆盖服务端 8 语言（z.fromJSONSchema 转换后全部键必填），单条译文 ≤500 字边界通过。
  it('translations 须覆盖服务端 8 语言且单条 ≤500 字边界，保持旁白 strict', async () => {
    ivServiceMock.storyboardSubmit.mockResolvedValue({ submitted: true })
    const board = makeCompleteStoryboard()
    const narration = [{ text: '维护', start: 0, end: 6, translations: fullTranslations('a'.repeat(500)) }]
    const result = await makeTools().call('ivideo_storyboard_submit', {
      run: 'r1',
      storyboard: { ...board, scenes: [{ ...board.scenes[0], narration }] },
      expectedInputFingerprint: 'fp',
      expectedStoryboardSha256: 'sha'
    })
    expect(jsonOf(result).ok).toBe(true)
  })

  it('ivideo_storyboard_submit 拒绝 narration text 超过 200 字', async () => {
    ivServiceMock.storyboardSubmit.mockResolvedValue({ submitted: true, reviewRequired: false })
    const tooLong = '维'.repeat(201)
    const board = makeCompleteStoryboard()
    const result = await makeTools().call('ivideo_storyboard_submit', {
      run: 'r1',
      storyboard: {
        ...board,
        scenes: [
          {
            ...board.scenes[0],
            narration: [{ text: tooLong, start: 0, end: 6 }]
          }
        ]
      },
      expectedInputFingerprint: 'fp',
      expectedStoryboardSha256: 'sha'
    })
    expect(jsonOf(result).ok).toBe(false)
  })

  it('ivideo_storyboard_submit 拒绝空 translations 译文（非空且 ≤500）', async () => {
    ivServiceMock.storyboardSubmit.mockResolvedValue({ submitted: true, reviewRequired: false })
    const board = makeCompleteStoryboard()
    const result = await makeTools().call('ivideo_storyboard_submit', {
      run: 'r1',
      storyboard: {
        ...board,
        scenes: [
          {
            ...board.scenes[0],
            narration: [{ text: 'a'.repeat(10), start: 0, end: 6, translations: { 'en-US': '' } }]
          }
        ]
      },
      expectedInputFingerprint: 'fp',
      expectedStoryboardSha256: 'sha'
    })
    expect(jsonOf(result).ok).toBe(false)
  })

  it('ivideo_parse 接受字幕 camelCase 字段并转发给 service.parse', async () => {
    ivServiceMock.parse.mockResolvedValue({ jobId: 'j1' })
    const result = await makeTools().call('ivideo_parse', {
      run: 'r1',
      texts: [{ text: 'x' }],
      subtitleLanguage: 'en-US',
      bilingualSubtitles: true,
      secondSubtitleLanguage: 'ja-JP',
      narrationFollowsSubtitles: true
    })
    expect(jsonOf(result).ok).toBe(true)
    expect(ivServiceMock.parse).toHaveBeenCalledWith(
      expect.objectContaining({
        subtitleLanguage: 'en-US',
        bilingualSubtitles: true,
        secondSubtitleLanguage: 'ja-JP',
        narrationFollowsSubtitles: true
      })
    )
  })

  it('ivideo_start 透传 stage:"plan" 给 service.videoStart（不静默丢弃）', async () => {
    ivServiceMock.getRecords.mockReturnValue(null)
    ivServiceMock.videoStart.mockResolvedValue({ jobId: 'j-plan' })
    ivServiceMock.workbenchGet.mockResolvedValue({ generatable: false, blockers: ['awaiting_script_review'] })
    const settings = {
      subtitleLanguage: 'en-US',
      secondSubtitleLanguage: 'ja-JP',
      bilingualSubtitles: false,
      narrationFollowsSubtitles: true,
      expectedSettingsVersion: 2
    }
    const result = await makeTools().call('ivideo_start', { run: 'r1', stage: 'plan', ...settings })
    expect(jsonOf(result)).toMatchObject({ ok: true, jobId: 'j-plan', started: false })
    expect(ivServiceMock.videoStart).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        run: 'r1',
        stage: 'plan',
        ...settings
      })
    )
    expect(ivServiceMock.workbenchGet).not.toHaveBeenCalled()
  })

  it('估算保留字幕设置且不提交任务', async () => {
    ivServiceMock.estimate.mockResolvedValue({ estimate: { fee: 1 } })
    const settings = {
      subtitleLanguage: 'de-DE',
      secondSubtitleLanguage: 'en-US',
      bilingualSubtitles: false,
      narrationFollowsSubtitles: true
    }
    expect(jsonOf(await makeTools().call('ivideo_estimate', { run: 'r1', ...settings })).ok).toBe(true)
    expect(ivServiceMock.estimate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(settings))
    expect(ivServiceMock.videoStart).not.toHaveBeenCalled()
  })

  it('上下文和提交说明明确按翻译任务生成主语言与译文，继续网页审核', () => {
    for (const name of ['ivideo_context', 'ivideo_storyboard_submit']) {
      const tool = makeTools()
        .tools()
        .find((item) => item.name === name)!
      expect(tool.description).toContain('subtitle_translation_task')
      expect(tool.description).toContain('translations')
      expect(tool.description).toContain('网页')
    }
  })
})
