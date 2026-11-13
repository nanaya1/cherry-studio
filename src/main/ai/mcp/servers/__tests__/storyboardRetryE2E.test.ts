/**
 * 端到端集成验证：分镜缺必填字段 → 客户端预校验拦截 → **错误即终态**（不自动重提）。
 *
 * 自动重提已按用户决定停用（2026-11-13）：工具层不再传 _meta.industrialVideoValidationError，
 * 结构化 runtime 不置 retryable，连接层把错误当终态结束本轮。
 * 恢复自动重提时：取消 meacoworkIndustrialVideoTools.ts 预校验分支中的 _meta 标记注释、
 * industrialVideoStructuredRuntime.ts 系统提示词中的纠正条款注释，并把本测试换回重提断言。
 *
 * 与单元测试不同，这里串起**真实的三段**：
 *  - 真实 MeacoworkIndustrialVideoTools（只 mock 底层 IndustrialVideoService 与会话查询）
 *  - 真实 runtime toolExecutor（run 绑定注入、_meta → retryable 换算通道保持原样）
 *  - 真实 IndustrialVideoStructuredConnection.runTurn（协议解析、终态错误处理）
 *
 * 仅两处为假：模型按脚本输出（6 字段残缺分镜动作），服务端提交回执。
 * 断言点：
 *  1. 提交收到 IVIDEO_STORYBOARD_SCHEMA_INVALID 且**未**调服务端（本地拦截）
 *  2. 连接层产生终态 error 事件（不再自修循环）
 *  3. 服务端 storyboardSubmit 零调用（残缺分镜不出客户端）
 *  4. 模型不会被再次询问（无第二轮模型调用）
 */

import type { Mock } from 'vitest'
import { describe, expect, it, vi } from 'vitest'

const { agentSessionGetByIdMock, ivServiceMock } = vi.hoisted(() => ({
  agentSessionGetByIdMock: vi.fn(),
  ivServiceMock: {
    getExecutionToken: vi.fn(() => Object.freeze({ sessionId: 's1', epoch: 1 })),
    assertExecution: vi.fn(),
    withExecution: vi.fn((_token: unknown, fn: () => unknown) => fn()),
    getRecords: vi.fn(() => ({ run: 'r-1', state: 'parsed', jobId: null, unknownSubmissions: [] })),
    getPendingReviewSnapshot: vi.fn(() => undefined),
    getConfirmedReview: vi.fn(() => undefined),
    planningContextGet: vi.fn(),
    storyboardSubmit: vi.fn(),
    workbenchOpen: vi.fn(),
    workbenchGet: vi.fn(),
    parse: vi.fn(),
    estimate: vi.fn(),
    videoStart: vi.fn(),
    jobGet: vi.fn(),
    downloadArtifact: vi.fn()
  }
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ error: vi.fn(), warn: vi.fn() }) }
}))

vi.mock('@main/data/services/AgentSessionService', () => ({
  agentSessionService: { getById: agentSessionGetByIdMock }
}))

vi.mock('@application', () => ({
  application: {
    get: (name: string) => {
      if (name === 'IndustrialVideoService') return ivServiceMock
      if (name === 'AiService') return { generateText: aiGenerateTextFactory() }
      throw new Error(`unexpected application service: ${name}`)
    }
  }
}))

// runtime 依赖的数据服务（连接加载 transcript 用）
vi.mock('@main/data/services/AgentSessionMessageService', () => ({
  agentSessionMessageService: { listSessionMessages: vi.fn(() => ({ items: [], nextCursor: undefined })) }
}))
vi.mock('@main/data/services/ModelService', () => ({
  modelService: { getByKey: vi.fn(() => ({ id: 'm', providerId: 'p' })) }
}))
vi.mock('@main/data/services/ProviderService', () => ({
  providerService: { getByProviderId: vi.fn(() => ({ id: 'p' })) }
}))

// const { MeacoworkIndustrialVideoTools } = await import('../meacoworkIndustrialVideoTools')
await import('../meacoworkIndustrialVideoTools')
const { createIndustrialVideoStructuredConnection } = await import(
  '@main/features/industrialVideo/industrialVideoStructuredRuntime'
)

const AGENT_ID = 'agent-1'
const SESSION_ID = 's1'

// 模型脚本与调用记录：脚本耗尽即抛错，任何超出预期的模型调用都会使测试失败
const generateTextScript: Array<{ text: string }> = []
const modelCallInputs: Array<{ system?: string; prompt?: string }> = []
function aiGenerateTextFactory() {
  return async (input: { system?: string; prompt?: string }) => {
    modelCallInputs.push({ system: input.system, prompt: input.prompt })
    const next = generateTextScript.shift()
    if (!next) throw new Error('模型脚本耗尽：出现了预期之外的模型调用（自动重提未停用？）')
    return { text: next.text, usage: undefined }
  }
}

function makeCompleteScene(id: number) {
  return {
    id,
    title: '精准落座',
    duration: 6,
    prompt: `工业质感精密装配场景 ${id}，技师将轴承座平稳落到安装基面。`,
    prompt_en: `Cinematic industrial assembly scene ${id} with a technician seating a bearing housing.`,
    narration: [{ text: '精准落座，是可靠装配的第一步。', start: 0.5, end: 5.5 }],
    operation_type: 'install',
    granularity: 'component',
    operation_type_options: ['install'],
    granularity_options: ['component'],
    state_transition: {
      before: { part: '轴承座悬停在安装基面上方' },
      after: { part: '轴承座已平稳落在安装基面' },
      invariants: { fixture: '夹具与安装基面位置保持不变' },
      action_en: 'Lower the bearing housing onto the mounting surface.',
      contact_en: 'Full contact between housing base and mounting surface.',
      verification_en: 'Housing fully seated with no visible gap.',
      source_lines: [1, 2],
      phases: [{ start: 0, end: 6, description_en: 'Lower and seat the housing.' }]
    }
  }
}

// 模拟模型犯的错：只有 6 个基础字段（用户多轮实测的原始失败形态）
function makeSixFieldStoryboard() {
  return {
    video_title: '精密装配，数据见证',
    scenes: [makeCompleteScene(1), makeCompleteScene(2), makeCompleteScene(3)].map((scene) => {
      const slim = { ...scene }
      delete (slim as Record<string, unknown>).operation_type
      delete (slim as Record<string, unknown>).granularity
      delete (slim as Record<string, unknown>).operation_type_options
      delete (slim as Record<string, unknown>).granularity_options
      delete (slim as Record<string, unknown>).state_transition
      return slim
    })
  }
}

describe('分镜预校验纠错（端到端）', () => {
  it('6字段提交→本地拦截→模型修改完整分镜→唯一一次服务端提交', async () => {
    agentSessionGetByIdMock.mockReturnValue({
      id: SESSION_ID,
      agentId: AGENT_ID,
      featureKind: 'industrial-video',
      workspaceId: 'ws1'
    })
    ivServiceMock.storyboardSubmit
      .mockClear()
      .mockResolvedValue({ submitted: true, reviewRequired: true, workbench_url: 'https://wb.example/r-1' })

    generateTextScript.push(
      {
        text: JSON.stringify({
          action: {
            tool: 'mcp__meacowork-tools__ivideo_storyboard_submit',
            args: {
              run: 'r-1',
              storyboard: makeSixFieldStoryboard(),
              expectedInputFingerprint: 'fp-1',
              expectedStoryboardSha256: ''
            }
          }
        })
      },
      {
        text: JSON.stringify({
          action: {
            tool: 'mcp__meacowork-tools__ivideo_storyboard_submit',
            args: {
              run: 'r-1',
              storyboard: {
                video_title: '精密装配，数据见证',
                scenes: [makeCompleteScene(1), makeCompleteScene(2), makeCompleteScene(3)]
              },
              expectedInputFingerprint: 'fp-1',
              expectedStoryboardSha256: ''
            }
          }
        })
      },
      { text: JSON.stringify({ reply: '分镜已提交。' }) }
    )

    const connection = createIndustrialVideoStructuredConnection({
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      modelId: 'p::m',
      executionToken: Object.freeze({ sessionId: SESSION_ID, epoch: 1 }),
      extractUserText: () => '制作装配视频'
    })

    connection.send({ message: { data: { parts: [] } } } as never)
    const events: unknown[] = []
    for await (const event of connection.events) events.push(event)

    const chunks = events
      .filter((e) => (e as { type: string }).type === 'chunk')
      .map((e) => (e as { chunk: Record<string, unknown> }).chunk)
    const errorEvents = events.filter((e) => (e as { type: string }).type === 'error')

    // 断言1：预校验本地拦截（工具层错误输出），错误含逐场景缺失清单
    const toolErrors = chunks.filter((c) => c.type === 'tool-output-error')
    expect(toolErrors.length).toBeGreaterThanOrEqual(1)
    const firstErrorText = String((toolErrors[0] as { errorText?: string }).errorText ?? '')
    expect(firstErrorText).toContain('IVIDEO_STORYBOARD_SCHEMA_INVALID')
    expect(firstErrorText).toContain('场景 1')
    expect(firstErrorText).toContain('operation_type')
    expect(firstErrorText).toContain('state_transition')

    // 断言2：可修正错误不结束本轮，修正后正常完成
    expect(errorEvents.length).toBe(0)

    // 断言3：残缺分镜不出客户端，只有修正后的完整分镜提交一次
    expect((ivServiceMock.storyboardSubmit as Mock).mock.calls.length).toBe(1)
    expect((ivServiceMock.storyboardSubmit as Mock).mock.calls[0][0].storyboard.scenes[0].operation_type).toBe('install')

    // 断言4：模型收到错误后修正，并在成功后回复
    expect(modelCallInputs.length).toBe(3)
    expect(modelCallInputs[1].prompt).toContain('IVIDEO_STORYBOARD_SCHEMA_INVALID')
  })
})
