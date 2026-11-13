/**
 * 工业视频 MCP 白名单：注入可信会话并逐次校验归属，通过类型化服务调用，不暴露凭据。
 * 用户确认与可信审核不可由模型代签；本工具不提供确认接口。
 */

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import * as z from 'zod'

import { application } from '@application'
import { agentSessionService } from '@main/data/services/AgentSessionService'
import {
  storyboardSchema,
  storyboardValidator,
  validateStoryboard
} from '@main/features/industrialVideo/industrialVideoStoryboardSchema'
import { isAbortError } from '@main/utils/error'
import { INDUSTRIAL_VIDEO_SUBTITLE_LANGUAGE_CODES } from '@shared/data/cache/cacheValueTypes'
import { INDUSTRIAL_VIDEO_VOICE_IDS } from '@shared/data/industrialVideoVoices'
import { IpcError } from '@shared/ipc/errors/IpcError'

// ── Trusted context (injected by the runtime; never from tool args) ──────────

export interface MeacoworkIndustrialVideoContext {
  /** Trusted agent id bound to this connection — re-checked against the live session at call time. */
  agentId: string
  /** Trusted session id bound to this connection — injected into every service call. */
  sessionId: string
}

// ── Contract constants mirrored exactly from `IndustrialVideoService` ─────────
// `IndustrialVideoVoice` is a `type`-only export there, so the fixed voice enum is re-listed here;
// it is the verbatim COWORK_HTTP_GUIDE §17.1 set the server rejects anything outside of (422).

// const INDUSTRIAL_VIDEO_VOICES = [
//   'zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunxiNeural',
//   'zh-CN-YunjianNeural', 'zh-CN-YunyangNeural', 'zh-CN-YunxiaNeural'
// ] as const

const INDUSTRIAL_VIDEO_NARRATIVE_STYLES = [
  'auto',
  'industrial',
  'modern',
  'technology',
  'wuxia',
  'historical',
  'ceo_drama',
  'humor',
  'emotional'
] as const

/** Settings block shared by `parse` / `estimate` / `start` — field names match the Service contract. */
const videoSettingsFields = {
  // voice: z.enum(INDUSTRIAL_VIDEO_VOICES).optional(),
  voice: z.enum(INDUSTRIAL_VIDEO_VOICE_IDS).optional(),
  aspectRatio: z.enum(['16:9', '9:16', '1:1']).optional(),
  style: z.enum(['marketing', 'training']).optional(),
  targetDurationS: z.number().nullable().optional(),
  resolution: z.enum(['720P', '1080P']).nullable().optional(),
  ttsEnabled: z.boolean().nullable().optional(),
  subtitleEnabled: z.boolean().nullable().optional(),
  backgroundMusicEnabled: z.boolean().nullable().optional(),
  withAudio: z.boolean().nullable().optional(),
  expectedSettingsVersion: z.number().int().optional(),
  narrativeStyle: z.enum(INDUSTRIAL_VIDEO_NARRATIVE_STYLES).optional(),
  // 工业字幕（§17）：camelCase 提交，主进程转 snake_case 透传。
  subtitleLanguage: z.enum(INDUSTRIAL_VIDEO_SUBTITLE_LANGUAGE_CODES).optional(),
  secondSubtitleLanguage: z.enum(INDUSTRIAL_VIDEO_SUBTITLE_LANGUAGE_CODES).optional(),
  bilingualSubtitles: z.boolean().optional(),
  narrationFollowsSubtitles: z.boolean().optional()
} as const

// ── Per-operation input schemas (strict: only the declared Service fields) ───

const RunCreateSchema = z.strictObject({
  baseName: z.string().min(1),
  prefix: z.string().nullable().optional()
})

const ContextSchema = z.strictObject({
  run: z.string().min(1)
})

const StoryboardGetSchema = z.strictObject({
  run: z.string().min(1),
  full: z.boolean().optional()
})

const ReviewSnapshotGetSchema = z.strictObject({
  run: z.string().min(1)
})

/* 停用旧六字段校验，使用服务端完整 Schema。
const StoryboardNarrationSchema = z.strictObject({
  text: z.string().min(1).max(200),
  start: z.number().min(0),
  end: z.number().min(0),
  translations: z
    .partialRecord(z.enum(INDUSTRIAL_VIDEO_SUBTITLE_LANGUAGE_CODES), z.string().trim().min(1).max(500))
    .optional()
})

const StoryboardSceneSchema = z.looseObject({
  id: z.number().int().min(1),
  title: z.string().min(1).max(12),
  duration: z.number().int().min(5).max(15),
  prompt: z.string().min(1).max(20_000),
  prompt_en: z
    .string()
    .min(20)
    .max(20_000)
    .regex(/[A-Za-z]/)
    .regex(/^[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]*$/u),
  narration: z.array(StoryboardNarrationSchema).max(4)
})

*/

// 服务端 STORYBOARD_SCHEMA（storyboard/planning.py）对每个 scene 的必填字段在
// z.looseObject 之外——looseObject 只校验形状不强制存在。这里维护与服务端一致的
// 必填清单，提交前本地预校验：缺字段立即返回可执行错误让模型自修，省一次
// 服务端往返（旧链路模型按 6 字段描述提交，服务端整批拒绝后只能整轮重试）。
const SCENE_REQUIRED_FIELDS = [
  'operation_type',
  'granularity',
  'operation_type_options',
  'granularity_options',
  'state_transition'
] as const

const STATE_TRANSITION_REQUIRED_FIELDS = [
  'before',
  'after',
  'action_en',
  'contact_en',
  'verification_en',
  'source_lines',
  'phases'
] as const

function validateStoryboardRequiredFields(storyboard: { scenes?: Array<Record<string, unknown>> }): string[] {
  const errors: string[] = []
  const scenes = Array.isArray(storyboard.scenes) ? storyboard.scenes : []
  scenes.forEach((scene, index) => {
    if (!scene || typeof scene !== 'object') return
    const sid = typeof scene.id === 'number' ? `场景 ${scene.id}` : `scenes[${index}]`
    for (const field of SCENE_REQUIRED_FIELDS) {
      if (scene[field] === undefined || scene[field] === null) {
        errors.push(`${sid} 缺少必填字段 ${field}`)
      }
    }
    const state = scene.state_transition
    if (state && typeof state === 'object') {
      for (const field of STATE_TRANSITION_REQUIRED_FIELDS) {
        if ((state as Record<string, unknown>)[field] === undefined) {
          errors.push(`${sid} 的 state_transition 缺少子字段 ${field}`)
        }
      }
    }
  })
  return errors
}

// 保留旧定义供回滚，注册与校验改用服务端完整契约。
// const StoryboardSchema = z.looseObject({ video_title: z.string().regex(/\S/).max(120), scenes: z.array(StoryboardSceneSchema).min(1).max(100) })
const StoryboardSchema = storyboardValidator(storyboardSchema)

const StoryboardSubmitSchema = z.strictObject({
  run: z.string().min(1),
  // storyboard: z.record(z.string(), z.unknown()),
  storyboard: StoryboardSchema,
  expectedInputFingerprint: z.string().min(1),
  // expectedStoryboardSha256: z.string().min(1)
  expectedStoryboardSha256: z.string(),
  expectedDocumentVersion: z.number().int().optional()
})

const InlineTextSchema = z.strictObject({
  text: z.string().min(1).max(20_000),
  title: z.string().optional()
})

// const TextReferenceFields = {
//   title: z.string().optional(),
//   knowledge_id: z.string().optional(),
//   document_id: z.string().optional(),
//   revision: z.string().optional(),
//   citation: z.string().optional()
// } as const

// const TextReferenceSchema = z.union([
//   z.strictObject({ name: z.string().min(1), ...TextReferenceFields }),
//   z.strictObject({ url: z.url(), ...TextReferenceFields })
// ])
// 停用 texts 的 {name}/{url} 引用形态：服务端虽支持（uploads/ + COWORK_SOURCE_ROOT，且限
// txt/md/csv/srt/json），但客户端附件走本地可信提取（GBK 解码/乱码防线/20000 拆分），
// txt 等原文件不上传、docx/pdf 不在服务端白名单，模型传引用必然"句柄未找到"且丢失全部提取成果。

const ParseSchema = z.strictObject({
  run: z.string().min(1),
  ...videoSettingsFields,
  // texts: z.array(z.unknown()).nullable().optional(),
  // texts: z.array(z.union([InlineTextSchema, TextReferenceSchema])).max(50).nullable().optional(),
  texts: z.array(InlineTextSchema).max(50).nullable().optional(),
  media: z.array(z.unknown()).nullable().optional(),
  logo: z.unknown().nullable().optional()
})

const EstimateSchema = z.strictObject({
  run: z.string().min(1),
  ...videoSettingsFields
})

const StartSchema = EstimateSchema.extend({
  // 仅保存规划设置；缺省仍为经网页审核后的真实生成。
  stage: z.enum(['plan', 'video']).optional()
})

const StatusSchema = z.strictObject({
  jobId: z.string().min(1),
  waitS: z.number().optional(),
  tailLines: z.number().int().optional()
})

const DownloadSchema = z.strictObject({
  run: z.string().min(1),
  path: z.string().min(1),
  expectedSize: z.number().int().optional()
})

// ── Tool metadata ────────────────────────────────────────────────────────────

const WORKFLOW_HINT =
  '流程：run_create → parse → context → storyboard_submit → review_snapshot_get 返回工作台链接，然后结束本轮。' +
  '审核与成本确认均在网页完成，禁止再弹 AskUserQuestion 审核框。用户下一轮发送「开始生成视频」才调用 start；start 会核验服务端最新状态，不满足则回工作台并结束。不得覆盖网页设置，结果未知不重提。'

// const WORKFLOW_HINT =
// '流程：run_create → parse → context → 客户端按 storyboard_schema 编写分镜 → storyboard_submit → review_snapshot_get → AskUserQuestion → 可信审核通过 → estimate → 用户确认生成及费用 → start → status → download。' +
// 默认使用已有在线预览，下载不属于自动制作步骤。
// '流程：run_create → parse → context → 客户端按 storyboard_schema 编写分镜 → storyboard_submit → review_snapshot_get → AskUserQuestion → 可信审核通过 → start → status → download。' +
// '流程：run_create → parse → context → 客户端按 storyboard_schema 编写分镜 → storyboard_submit → review_snapshot_get → AskUserQuestion → 可信审核通过 → start → status → 在线预览。仅在用户明确要求下载时调用 ivideo_download。' +
// 'reviewRequired 时必须调用 ivideo_review_snapshot_get 读取真实脚本、分镜和 review_version，再调用原生 AskUserQuestion；问题必须是“脚本与分镜是否确认？”，选项必须是“脚本与分镜没问题，开始生成视频”和“我要修改脚本或分镜”。' +
// '不得调用 start 探测或绕过批准；AskUserQuestion 的回答明确包含“系统可信审核已通过”后才可 estimate，且不得再次询问脚本与分镜确认；未获批准不得报告为生成中。'
// '不得调用 start 探测或绕过批准；必须通过原生 AskUserQuestion 取得用户确认并绑定 metadata.reviewVersion。' +
// '回答明确包含“系统可信审核已通过”后，保持制作参数与已审核分镜不变，不要调用 ivideo_estimate，立即调用 ivideo_start，不要等待单独确认或再次询问脚本与分镜确认；未获批准不得报告为生成中。'

const IVIDEO_TOOLS: readonly Tool[] = [
  {
    name: 'ivideo_run_create',
    description:
      'Create a new industrial-video production run for this session. Returns a run id you must carry into every later step. ' +
      WORKFLOW_HINT,
    inputSchema: toMcpInputSchema(RunCreateSchema)
  },
  {
    name: 'ivideo_context',
    description:
      '按 subtitle_translation_task 的主语言生成 narration.text，按要求将目标语言译文写入 narration.translations；不自行忽略翻译任务。' +
      '获取规划上下文。若 current_storyboard 为 null，必须依据 storyboard_schema、素材与 guidance 自行编写完整分镜并直接调用 storyboard_submit，不要调用 storyboard_get。' +
      WORKFLOW_HINT,
    inputSchema: toMcpInputSchema(ContextSchema)
  },
  {
    name: 'ivideo_storyboard_get',
    description:
      '仅用于读取已提交的分镜（默认 full=true），不会创建或初始化分镜。首次规划应先按 ivideo_context 返回的 storyboard_schema 编写并提交分镜。' +
      WORKFLOW_HINT,
    inputSchema: toMcpInputSchema(StoryboardGetSchema)
  },
  {
    name: 'ivideo_storyboard_submit',
    description:
      '依据 subtitle_translation_task 提交主语言 narration.text（1-200字）与 narration.translations（语言代码到非空译文的映射，每条最多500字）。' +
      '提交符合 ivideo_context.storyboard_schema 的完整分镜。每个 scene 必填：id、title、duration(5-15秒)、prompt、prompt_en(可选英文适配字段)、narration，' +
      '以及动作规划五件套（缺任一项服务端必拒）：operation_type(枚举 overview/prepare/isolate/remove/install/adjust/measure/inspect/verify/warning/demo/proof/cta)、' +
      'granularity(枚举 macro/component/hand_tool/measurement/verification)、operation_type_options(上述枚举的非空子集)、granularity_options(同上)、' +
      'state_transition{before,after(首次提交就必须填写中文对象名到非空中文状态的映射，各1–24项、对象键一致，禁止{}空占位),action_en,contact_en,verification_en(兼容字段名，内容必须为中文动作/接触/验证描述),source_lines(整数数组,引用 source_text 真实非空行号,至少1项),phases(1-4段不重叠秒级动作,每段含 start/end/description_en)}。' +
      '禁止空 scene 或空 storyboard；不得只把英文视觉提示词写进 prompt。' +
      '首次无分镜时 expectedStoryboardSha256 可为空字符串；必须使用 context 返回的指纹和 SHA。' +
      // '需要审核时按流程读取快照并调用原生 AskUserQuestion；不得代签、猜测审核身份或直接 start。' +
      '提交后获取工作台链接并结束本轮；不得代签或在本轮直接 start。' +
      WORKFLOW_HINT,
    inputSchema: toMcpInputSchema(StoryboardSubmitSchema)
  },
  {
    name: 'ivideo_review_snapshot_get',
    description:
      // '只读获取当前 run 的可信脚本与分镜审核快照，返回 review_version、script、storyboard 和 remaining_blockers。' +
      // '不得把读取快照当作确认；必须把 review_version 原样放入后续 AskUserQuestion metadata.reviewVersion。' +
      '获取当前 run 的服务端工作台入口。输出链接及 message 后结束本轮，不调用本地审核框。' + WORKFLOW_HINT,
    inputSchema: toMcpInputSchema(ReviewSnapshotGetSchema)
  },
  {
    name: 'ivideo_parse',
    description:
      'Parse planning inputs into a job. texts items must be inline { text, title? } only — ' +
      'user-attached files are extracted automatically by the client; do NOT pass file names or URLs as references. ' +
      'media items must use { name, caption } where name is a handle returned by upload and caption is REQUIRED narration text. ' +
      'Do not pass string items or { name, content }. Resolution is exactly 720P or 1080P. ' +
      WORKFLOW_HINT,
    inputSchema: toMcpInputSchema(ParseSchema)
  },
  {
    name: 'ivideo_estimate',
    description:
      'Read-only fee / range pre-check for a run with the chosen settings. Returns the estimate and effective settings without starting generation. ' +
      WORKFLOW_HINT,
    inputSchema: toMcpInputSchema(EstimateSchema)
  },
  {
    name: 'ivideo_start',
    description:
      '默认提交视频生成，仍须通过网页审核，不得由客户端代确认。stage=plan 仅同步规划与字幕设置，不生成视频、不代表已批准；不得用来绕过网页审核。' +
      WORKFLOW_HINT,
    inputSchema: toMcpInputSchema(StartSchema)
  },
  {
    name: 'ivideo_status',
    description: 'Poll a generation/assembly job by jobId and reconcile authoritative state. ' + WORKFLOW_HINT,
    inputSchema: toMcpInputSchema(StatusSchema)
  },
  {
    name: 'ivideo_download',
    description:
      'Download one finished artifact into this session’s trusted workspace (path comes from a status/job result). ' +
      WORKFLOW_HINT,
    inputSchema: toMcpInputSchema(DownloadSchema)
  }
]

const IVIDEO_TOOL_NAMES = new Set(IVIDEO_TOOLS.map((t) => t.name))

// ── Helpers ──────────────────────────────────────────────────────────────────

function toMcpInputSchema(schema: z.ZodType): Tool['inputSchema'] {
  const json = z.toJSONSchema(schema) as Record<string, unknown>
  delete json.$schema
  return json as Tool['inputSchema']
}

function okResult(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...data }) }] }
}

function errorResult(error: unknown, meta?: Record<string, unknown>): CallToolResult {
  const ipc = error instanceof IpcError ? error : IpcError.from(error)
  return {
    ...(meta ? { _meta: meta } : {}),
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: ipc.code, message: ipc.message } }) }],
    isError: true
  }
}

function getService() {
  return application.get('IndustrialVideoService')
}

export class MeacoworkIndustrialVideoTools {
  private readonly executionToken: Readonly<{ sessionId: string; epoch: number }> | undefined
  private runtimeStoryboardSchema: Record<string, unknown> = storyboardSchema
  private readonly submissionErrors = new Map<string, string>()

  constructor(private readonly context: MeacoworkIndustrialVideoContext) {
    this.executionToken = getService().getExecutionToken()
  }

  tools(): Tool[] {
    return IVIDEO_TOOLS.map((tool) =>
      tool.name === 'ivideo_storyboard_submit'
        ? {
            ...tool,
            inputSchema: {
              ...tool.inputSchema,
              properties: { ...tool.inputSchema.properties, storyboard: this.runtimeStoryboardSchema }
            }
          }
        : tool
    )
  }

  handles(toolName: string): boolean {
    return IVIDEO_TOOL_NAMES.has(toolName)
  }

  /**
   * Re-validate ownership at call time. Visibility is already gated by the server (industrial-video
   * sessions only), but a session whose agent binding or feature kind changed mid-run must be
   * rejected here before any backend call — the model cannot spoof `agentId` / `sessionId`.
   */
  private assertSessionAuthorized(): void {
    let session
    try {
      session = agentSessionService.getById(this.context.sessionId)
    } catch (error) {
      throw new IpcError('IVIDEO_SESSION_INVALID', `Industrial-video session not found: ${this.context.sessionId}`, {
        cause: String(error)
      })
    }
    if (!session) {
      throw new IpcError('IVIDEO_SESSION_INVALID', `Industrial-video session not found: ${this.context.sessionId}`)
    }
    if (session.agentId !== this.context.agentId) {
      throw new IpcError(
        'IVIDEO_SESSION_FORBIDDEN',
        `Agent ${this.context.agentId} does not own session ${this.context.sessionId}`
      )
    }
    if (session.featureKind !== 'industrial-video') {
      throw new IpcError(
        'IVIDEO_SESSION_INVALID',
        `Session ${this.context.sessionId} is not an industrial-video session (featureKind=${session.featureKind ?? 'none'}).`
      )
    }
  }

  async call(toolName: string, args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    try {
      const service = getService()
      const token = this.executionToken
      if (!token || token.sessionId !== this.context.sessionId) {
        throw new IpcError('IVIDEO_STOPPED', '该连接没有可信执行轮次，请重新发送。')
      }
      service.assertExecution(token)
      return await service.withExecution(token, () => this.callAuthorized(toolName, args, signal))
    } catch (error) {
      if (isAbortError(error)) throw error
      return errorResult(error)
    }
  }

  private async callAuthorized(toolName: string, args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
    try {
      if (signal?.aborted) {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      }
      if (!this.handles(toolName)) {
        return errorResult(new IpcError('MCP_TOOL_NOT_FOUND', `Unknown industrial-video tool: ${toolName}`))
      }
      this.assertSessionAuthorized()
      const service = getService()
      const sessionId = this.context.sessionId

      switch (toolName) {
        case 'ivideo_run_create': {
          const a = RunCreateSchema.parse(args)
          const data = await service.runCreate({ sessionId, baseName: a.baseName, prefix: a.prefix ?? null })
          return okResult(data)
        }
        case 'ivideo_context': {
          const a = ContextSchema.parse(args)
          const data = await service.planningContextGet({ sessionId, run: a.run })
          if (data.storyboard_schema && typeof data.storyboard_schema === 'object') {
            this.runtimeStoryboardSchema = data.storyboard_schema as Record<string, unknown>
          }
          // 服务端 get_context 恒全量返回：source_text/source_lines/materials.texts 是同一份
          // manual.md 的三种形态（实测三份重复占 97K 的 80%），超客户端 Agent 运行时工具结果
          // token 护栏被转存文件。包装层瘦身：去 source_lines（与 source_text 逐行重复，模型
          // 可按行号定位）、materials[].text 改 text_chars 元数据（全文在 source_text 一份就够）。
          // 服务端 validate_states 读自身 manual.md 校验行号，不依赖响应字段，溯源闭环不变。
          if (data && typeof data === 'object') {
            const slim: Record<string, unknown> = data
            // delete slim.source_lines — 保留服务端真实来源行号供当前模型规划与纠错。
            const materials = slim.materials as { texts?: Array<Record<string, unknown>> } | null | undefined
            for (const item of materials?.texts ?? []) {
              if (typeof item.text === 'string') {
                item.text_chars = item.text.length
                delete item.text
              }
            }
            return okResult({
              ...slim,
              client_generation_requirements: {
                execution_model: 'current_selected_model',
                before_first_submit:
                  '先执行 client_planning_task，依据 source_lines 与当前 storyboard_schema 一次生成完整脚本和分镜。每个镜头 before/after 必须填写有来源依据的对象起止状态，不得提交空对象、null或占位内容；不能只在prompt或action_en中描述状态。保留当前草稿中的用户修改及所有合法字段。',
                state_object_contract:
                  (
                    this.runtimeStoryboardSchema.properties as {
                      scenes?: { items?: { properties?: { state_transition?: unknown } } }
                    }
                  )?.scenes?.items?.properties?.state_transition ?? null,
                state_rules:
                  'before/after 各1–24项且对象键相同，值为非空中文；invariants可为空，非空项须在前后状态中保持同值；相邻镜头同名对象状态衔接。动态对象字段必须显式写出对象名及状态，不能生成{}。资料不足须说明，不编造事实。',
                submit_rules:
                  '生成前先完成规划自检，使用本次上下文的指纹、SHA和document.version提交原run；提交仅保存待审稿，不自动审批或生成视频。'
              }
            })
          }
          return okResult(data)
        }
        case 'ivideo_storyboard_get': {
          const a = StoryboardGetSchema.parse(args)
          try {
            const data = await service.storyboardGet({ sessionId, run: a.run, full: a.full ?? true })
            return okResult(data)
          } catch (error) {
            const ipc = error instanceof IpcError ? error : IpcError.from(error)
            if (
              ipc.code === 'IVIDEO_HTTP_ERROR' &&
              ipc.message.includes('尚无分镜脚本') &&
              ipc.message.includes('storyboard.json 不存在')
            ) {
              return errorResult(
                new IpcError(
                  'IVIDEO_STORYBOARD_NOT_FOUND',
                  '该 run 尚无已提交分镜。请调用 ivideo_context，依据返回的 storyboard_schema、素材与 guidance 编写完整分镜，再调用 ivideo_storyboard_submit；不要提交空 storyboard。'
                )
              )
            }
            throw error
          }
        }
        case 'ivideo_storyboard_submit': {
          const run = String((args as { run?: unknown })?.run ?? '')
          const blocked = this.submissionErrors.get(run)
          if (blocked?.startsWith('STOP:')) throw new IpcError('IVIDEO_STORYBOARD_RETRY_STOPPED', blocked)
          try {
            validateStoryboard(this.runtimeStoryboardSchema, (args as { storyboard?: unknown })?.storyboard)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            const repeated = blocked === message
            this.submissionErrors.set(run, repeated ? `STOP:${message}` : message)
            if (repeated)
              throw new IpcError('IVIDEO_STORYBOARD_RETRY_STOPPED', `相同结构错误再次出现，停止提交。${message}`)
            const result = errorResult(error, { industrialVideoValidationError: true })
            const task = {
              run,
              execution_model: 'current_selected_model',
              next_operation: 'ivideo_context',
              validation_error: message,
              candidate_storyboard: (args as { storyboard?: unknown })?.storyboard,
              instruction:
                '在原 run 获取最新上下文，按 client_planning_task、真实 source_lines 和 storyboard_schema 修正候选。before/after 各1–24个对象且同名，值为非空中文状态；相邻镜头状态衔接。保留用户修改、scene_uid、素材及合法字段；禁止固定默认值、空占位或原样重提。重新携带最新指纹、SHA和文档版本；相同错误再次出现必须停止。'
            }
            return {
              ...result,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    ok: false,
                    error: { code: 'IVIDEO_STORYBOARD_SCHEMA_INVALID', message },
                    repair_task: task
                  })
                }
              ]
            }
          }
          const a = StoryboardSubmitSchema.extend({ storyboard: z.record(z.string(), z.unknown()) }).parse(args)
          // 本地预校验：服务端对 scene 必填字段（动作规划五件套 + state_transition）缺失时
          // 整批拒绝，模型需一轮服务端往返才能得知。这里提前拦截并给出可执行错误。
          const missing = validateStoryboardRequiredFields(a.storyboard)
          if (missing.length > 0) {
            const message =
              `分镜缺少必填的动作规划字段：${missing.join('；')}。` +
              '每个 scene 必填 operation_type、granularity、operation_type_options、granularity_options、state_transition' +
              '（state_transition 须含 before/after/action_en/contact_en/verification_en/source_lines/phases）。' +
              '请按 ivideo_context.storyboard_schema 补齐全部场景后重新提交，不得省略动作规划字段；禁止原样重提。'
            const repeated = blocked === message
            this.submissionErrors.set(run, repeated ? `STOP:${message}` : message)
            if (repeated)
              throw new IpcError('IVIDEO_STORYBOARD_RETRY_STOPPED', `相同结构错误再次出现，停止提交。${message}`)
            // 原终态返回已停用：明确的本地结构错误允许当前模型修改后重提。
            // return errorResult(
            //   new IpcError(
            //     'IVIDEO_STORYBOARD_SCHEMA_INVALID',
            //     `分镜缺少必填的动作规划字段：${missing.join('；')}。` +
            //       '每个 scene 必填 operation_type、granularity、operation_type_options、granularity_options、state_transition' +
            //       '（state_transition 须含 before/after/action_en/contact_en/verification_en/source_lines/phases）。' +
            //       '请按 ivideo_context.storyboard_schema 补齐全部场景后重新提交，不得省略动作规划字段。'
            //   )
            // )
            return errorResult(new IpcError('IVIDEO_STORYBOARD_SCHEMA_INVALID', message), {
              industrialVideoValidationError: true
            })
          }
          const data = await service.storyboardSubmit({
            sessionId,
            run: a.run,
            storyboard: a.storyboard,
            expectedInputFingerprint: a.expectedInputFingerprint,
            expectedStoryboardSha256: a.expectedStoryboardSha256,
            expectedDocumentVersion: a.expectedDocumentVersion
          })
          return okResult(data)
        }
        case 'ivideo_review_snapshot_get': {
          const a = ReviewSnapshotGetSchema.parse(args)
          // const data = await service.reviewSnapshotGet({ sessionId, run: a.run, reviewType: 'script_and_storyboard' })
          const data = await service.workbenchOpen({ sessionId, run: a.run, embed: true })
          return okResult({
            run: data.run,
            workbench_url: data.workbench_url,
            end_turn: true,
            message:
              '打开脚本工作台检查全文和分镜。全文有改动时，先重新生成分镜脚本。确认后，在对话框发送「开始生成视频」。'
          })
        }
        case 'ivideo_parse': {
          const a = ParseSchema.parse(args)
          const data = await service.parse({
            sessionId,
            run: a.run,
            voice: a.voice,
            aspectRatio: a.aspectRatio,
            style: a.style,
            targetDurationS: a.targetDurationS,
            resolution: a.resolution,
            ttsEnabled: a.ttsEnabled,
            subtitleEnabled: a.subtitleEnabled,
            backgroundMusicEnabled: a.backgroundMusicEnabled,
            withAudio: a.withAudio,
            expectedSettingsVersion: a.expectedSettingsVersion,
            narrativeStyle: a.narrativeStyle ?? null,
            subtitleLanguage: a.subtitleLanguage ?? null,
            secondSubtitleLanguage: a.secondSubtitleLanguage ?? null,
            bilingualSubtitles: a.bilingualSubtitles ?? null,
            narrationFollowsSubtitles: a.narrationFollowsSubtitles ?? null,
            texts: a.texts,
            media: a.media,
            logo: a.logo
          })
          return okResult({ ...data, run: service.getRecords({ sessionId })?.run ?? a.run })
        }
        case 'ivideo_estimate': {
          const a = EstimateSchema.parse(args)
          const data = await service.estimate({
            sessionId,
            run: a.run,
            voice: a.voice,
            aspectRatio: a.aspectRatio,
            style: a.style,
            targetDurationS: a.targetDurationS,
            resolution: a.resolution,
            ttsEnabled: a.ttsEnabled,
            subtitleEnabled: a.subtitleEnabled,
            backgroundMusicEnabled: a.backgroundMusicEnabled,
            withAudio: a.withAudio,
            expectedSettingsVersion: a.expectedSettingsVersion,
            narrativeStyle: a.narrativeStyle ?? null,
            subtitleLanguage: a.subtitleLanguage ?? null,
            secondSubtitleLanguage: a.secondSubtitleLanguage ?? null,
            bilingualSubtitles: a.bilingualSubtitles ?? null,
            narrationFollowsSubtitles: a.narrationFollowsSubtitles ?? null
          })
          return okResult(data)
        }
        case 'ivideo_start': {
          const a = StartSchema.parse(args)
          if (a.stage === 'plan') {
            const data = await service.videoStart({ sessionId, ...a })
            return okResult({ ...data, started: false })
          }
          const record = service.getRecords({ sessionId })
          if (record?.run === a.run && record.jobId) {
            const job = await service.jobGet({ sessionId, jobId: record.jobId })
            // return okResult({ ...job, jobId: record.jobId, started: false })
            const terminal = ['done', 'failed', 'blocked', 'canceled', 'cancelled'].includes(String(job.status))
            if (job.run !== a.run || !terminal) {
              return okResult({ ...job, jobId: record.jobId, started: false })
            }
          }
          // const latest = await service.workbenchGet({ sessionId, run: a.run })
          let latest
          try {
            latest = await service.workbenchGet({ sessionId, run: a.run })
          } catch (error) {
            if (isAbortError(error)) throw error
            const wb = await service.workbenchOpen({ sessionId, run: a.run, embed: true })
            return okResult({
              started: false,
              end_turn: true,
              workbench_url: wb.workbench_url,
              message:
                '无法确认服务端最新生成条件，本轮未提交生成。请回工作台检查保存和审核状态，确认后重新发送「开始生成视频」。'
            })
          }
          if (!latest.generatable) {
            const wb = await service.workbenchOpen({ sessionId, run: a.run, embed: true })
            return okResult({
              started: false,
              end_turn: true,
              workbench_url: wb.workbench_url,
              message: `请回脚本工作台处理：${latest.blockers.join('；')}。确认后发送「开始生成视频」。`
            })
          }
          const data = await service.videoStart({
            sessionId,
            run: a.run
            // 工作台保存的设置为准，不再用模型参数覆盖。
            /* voice: a.voice,
            aspectRatio: a.aspectRatio,
            style: a.style,
            targetDurationS: a.targetDurationS,
            resolution: a.resolution,
            ttsEnabled: a.ttsEnabled,
            subtitleEnabled: a.subtitleEnabled,
            backgroundMusicEnabled: a.backgroundMusicEnabled,
            withAudio: a.withAudio,
            expectedSettingsVersion: a.expectedSettingsVersion */
          })
          return okResult(data)
        }
        case 'ivideo_status': {
          const a = StatusSchema.parse(args)
          const data = await service.jobGet({ sessionId, jobId: a.jobId, waitS: a.waitS, tailLines: a.tailLines })
          return okResult(data)
        }
        case 'ivideo_download': {
          const a = DownloadSchema.parse(args)
          const data = await service.downloadArtifact({
            sessionId,
            run: a.run,
            path: a.path,
            expectedSize: a.expectedSize
          })
          return okResult(data)
        }
        default:
          return errorResult(new IpcError('MCP_TOOL_NOT_FOUND', `Unknown industrial-video tool: ${toolName}`))
      }
    } catch (error) {
      if (isAbortError(error)) throw error
      return errorResult(error)
    }
  }
}
