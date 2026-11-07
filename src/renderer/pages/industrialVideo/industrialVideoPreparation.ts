import { cacheService } from '@data/CacheService'
import { dataApiService } from '@data/DataApiService'
import { loggerService } from '@logger'
import { ipcApi } from '@renderer/ipc'
import { buildFilePartsForAttachments } from '@renderer/utils/file/buildFileParts'
import type { ComposerAttachment } from '@renderer/utils/message/composerAttachment'
import { readDefaultModel } from '@renderer/utils/model'
import type { CacheIndustrialVideoDraft, CacheIndustrialVideoPreparation } from '@shared/data/cache/cacheValueTypes'
// import type { FileUIPart } from '@shared/data/types/message'
import type { Model } from '@shared/data/types/model'
import { withCherryMeta } from '@shared/data/types/uiParts'
import { IpcError } from '@shared/ipc/errors/IpcError'

import { buildIndustrialVideoSettingsParams, industrialVideoVoiceId } from './industrialVideoRequest'
import { uploadIndustrialLogo, uploadIndustrialMedia } from './industrialVideoWorkflow'

/**
 * 工业视频准备任务 runner（独立渲染进程模块，不依赖任何 React 组件生命周期）。
 *
 * 设计目标：
 *  - 模块级 `activePreparations` Map 防同窗口并发重复（同一 session 第二次调用返回同一 Promise）。
 *  - 执行在组件之外，页面切换不中止；状态每步持久化到 persist 缓存。
 *  - 失败保存 error 并正常 resolve，绝不自动重试；未知提交（parse 失败）也不得自动 retry。
 *  - 不调用 `ai.text.abort`、不调用 `industrial_video.video_start`，不触发付费视频生成。
 *
 * 流程：config_status → uploadIndustrialMedia/uploadIndustrialLogo →
 * buildFilePartsForAttachments → ai.text.generate（资料分析） → run_create → parse。
 */

/** 准备任务入参：当前会话草稿（含 attachments/materials/logo）。 */
export interface IndustrialVideoPreparationInput {
  draft: CacheIndustrialVideoDraft
}

/** 图片/视频素材扩展名（与现有 Composer startProduction 保持一致）。 */
const MEDIA_EXTENSION_PATTERN = /\.(png|jpe?g|webp|gif|mp4|mov|webm|mkv)$/i

const preparationKey = (sessionId: string) => `industrial_video.preparation.${sessionId}` as const
const sessionDraftKey = (sessionId: string) => `industrial_video.session_draft.${sessionId}` as const

/** 同窗口并发去重：sessionId → 进行中的 Promise。 */
const activePreparations = new Map<string, Promise<void>>()
const logger = loggerService.withContext('industrial-video-preparation')

// 仅记录结构化错误标识，原始 message/data 可能包含正文或凭据。
function diagnosticError(cause: unknown) {
  const error = cause instanceof IpcError ? cause : null
  const data = error?.data && typeof error.data === 'object' ? (error.data as Record<string, unknown>) : {}
  const identifier = (value: unknown) =>
    typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value) ? value : undefined
  return {
    code: identifier(error?.code),
    status: typeof data.status === 'number' ? data.status : undefined,
    category: identifier(data.category),
    serverCode: identifier(data.code),
    outcomeUnknown: typeof data.outcomeUnknown === 'boolean' ? data.outcomeUnknown : undefined,
    issues: Array.isArray(data.issues)
      ? data.issues.slice(0, 20).map((issue: unknown) => {
          const item = issue && typeof issue === 'object' ? (issue as Record<string, unknown>) : {}
          return {
            path: Array.isArray(item.path)
              ? item.path
                  .slice(0, 10)
                  .map((part) => (typeof part === 'number' ? part : (identifier(part) ?? '[redacted]')))
              : [],
            code: identifier(item.code)
          }
        })
      : undefined
  }
}

/**
 * 是否该 session 的准备任务正在本窗口执行中（组件可轮询此值决定是否禁用按钮）。
 * 仅反映本窗口内存状态；跨窗口/重启的去重由 persist 准备记录承担。
 */
export function isIndustrialVideoPreparing(sessionId: string): boolean {
  return activePreparations.has(sessionId)
}

/**
 * 启动（或复用）一次工业视频准备任务。返回 Promise 在失败时也正常 resolve，错误留在 persist 状态里。
 *
 * 并发契约：
 *  - 若本窗口已有同 session 的活动任务，直接返回同一 Promise（不重复执行）。
 *  - 否则读取 persist 准备记录：非 failed/非 submitted 的既有任务存在时拒绝新建，避免重启或多窗口重复。
 *    submitted 视为可重做版本（UI 须以明确按钮触发，runner 仅放行）。
 */
export function startIndustrialVideoPreparation(
  sessionId: string,
  input: IndustrialVideoPreparationInput,
  prompt: string
): Promise<void> {
  const existing = activePreparations.get(sessionId)
  if (existing) return existing
  const promise = runPreparation(sessionId, input, prompt).finally(() => {
    // 无论成功失败都释放 Map 槽位，允许后续（重做）新建。
    activePreparations.delete(sessionId)
  })
  activePreparations.set(sessionId, promise)
  return promise
}

/** 解析用于资料分析的模型：优先草稿所选 modelId，否则回退默认模型。 */
async function resolvePreparationModel(draft: CacheIndustrialVideoDraft): Promise<Model> {
  if (draft.modelId) {
    const byId = await dataApiService.get(`/models/${draft.modelId}`)
    if (byId) return byId
  }
  const fallback = await readDefaultModel()
  if (!fallback) throw new Error('未选择用于资料分析的模型，请在设置中选择默认模型或会话模型。')
  return fallback
}

/** 把 persist 准备记录写回；每步在发起 IPC 前调用，保证“保存状态早于 IPC”。 */
function writePreparation(
  sessionId: string,
  draft: CacheIndustrialVideoDraft,
  patch: Partial<Omit<CacheIndustrialVideoPreparation, 'input'>> & { startedAt?: number },
  now: number
): void {
  const prev = cacheService.getPersist(preparationKey(sessionId))
  const next: CacheIndustrialVideoPreparation = {
    input: draft,
    stage: patch.stage ?? prev?.stage ?? 'uploading',
    result: patch.result ?? prev?.result ?? '',
    error: patch.error ?? '',
    startedAt: patch.startedAt ?? prev?.startedAt ?? now,
    updatedAt: now
  }
  cacheService.setPersist(preparationKey(sessionId), next)
}

async function runPreparation(
  sessionId: string,
  input: IndustrialVideoPreparationInput,
  prompt: string
): Promise<void> {
  const draft = input.draft
  const now = Date.now()

  // 跨窗口/重启去重：非 failed 且非 submitted 的既有任务存在则拒绝新建。
  // 必须在写入本窗口“uploading”之前判断，避免把另一窗口真正在跑的任务覆盖成 failed。
  const prev = cacheService.getPersist(preparationKey(sessionId))
  if (prev && prev.stage !== 'failed' && prev.stage !== 'submitted') {
    throw new Error('该会话已有进行中的准备任务，请勿重复创建。')
  }

  // 开始先持久化草稿与准备记录（同步，早于任何 IPC），保证“保存状态早于 IPC”。
  cacheService.setPersist(sessionDraftKey(sessionId), draft)
  writePreparation(sessionId, draft, { stage: 'uploading', startedAt: now, result: '' }, now)

  let operation = 'industrial_video.config_status'
  try {
    // 1) 服务配置检查
    const configured = await ipcApi.request('industrial_video.config_status')
    if (!configured || !configured.configured) {
      throw new Error('工业视频服务尚未配置，请在主进程配置 SERVICE_BASE 和 SERVICE_TOKEN。')
    }

    // 2) 上传图片/视频素材与企业 Logo（与现有 Composer startProduction 一致）。
    const attachments: ComposerAttachment[] = (draft.attachments ?? []).filter(
      (attachment): attachment is ComposerAttachment => Boolean(attachment.path)
    )
    const media: Array<{ name: string; caption: string }> = []
    operation = 'industrial_video.media_upload'
    for (const attachment of attachments.filter((file) => MEDIA_EXTENSION_PATTERN.test(file.origin_name))) {
      const uploaded = await uploadIndustrialMedia(sessionId, attachment.path!, attachment.origin_name)
      media.push({ name: uploaded.name, caption: attachment.origin_name })
    }
    operation = 'industrial_video.logo_upload'
    const uploadedLogo = draft.logo ? await uploadIndustrialLogo(sessionId, draft.logo.name, draft.logo.source) : null

    // 3) 资料分析：把附件转为 FileUIPart，并以 withCherryMeta 注入 composer 文件 token。
    writePreparation(sessionId, draft, { stage: 'analyzing' }, Date.now())
    operation = 'build_file_parts'
    const fileParts = await buildFilePartsForAttachments(attachments)
    const tokens = fileParts.flatMap((part) => {
      const sourceId = part.providerMetadata?.cherry?.fileTokenSourceId
      return typeof sourceId === 'string'
        ? [
            {
              id: `file:${sourceId}`,
              kind: 'file' as const,
              label: part.filename ?? 'file',
              index: 0,
              textOffset: 0
            }
          ]
        : []
    })
    const analysisContent = JSON.stringify({ requirement: draft.requirement, settings: draft.settings })
    const textPart = withCherryMeta(
      { type: 'text' as const, text: analysisContent },
      { composer: { version: 1, tokens } }
    )
    operation = 'resolve_model'
    const model = await resolvePreparationModel(draft)
    const requestId = crypto.randomUUID()
    operation = 'ai.text.generate'
    const response = await ipcApi.request('ai.text.generate', {
      requestId,
      uniqueModelId: model.id,
      reasoningEffort: 'none',
      system: prompt,
      uiMessages: [{ id: crypto.randomUUID(), role: 'user', parts: [textPart, ...fileParts] }]
    })
    const analysisText = response?.text
    if (!analysisText || !analysisText.trim()) {
      throw new Error('资料分析未成功，已停止，未提交服务端解析。')
    }

    // 4) 创建 run 并提交 parse（与现有 Composer startProduction 参数一致）。
    writePreparation(sessionId, draft, { stage: 'parsing', result: analysisText }, Date.now())
    operation = 'industrial_video.run_create'
    const { run } = await ipcApi.request('industrial_video.run_create', {
      sessionId,
      baseName: draft.requirement.trim()
    })
    operation = 'industrial_video.parse'
    await ipcApi.request('industrial_video.parse', {
      sessionId,
      run,
      texts: [{ text: `${draft.requirement.trim()}\n\n${analysisText}`, title: draft.requirement.trim() }],
      media,
      logo: uploadedLogo ? { name: uploadedLogo.name } : null,
      ...buildIndustrialVideoSettingsParams(draft.settings),
      voice: industrialVideoVoiceId(draft.settings.voice),
      aspectRatio: draft.settings.ratio,
      style: draft.settings.type === 'marketing' ? 'marketing' : 'training'
    })

    writePreparation(sessionId, draft, { stage: 'submitted', result: analysisText }, Date.now())
  } catch (cause) {
    const diagnostic = diagnosticError(cause)
    const fields = diagnostic.issues?.map((issue) => `${issue.path.join('.') || '$'}: ${issue.code ?? 'invalid'}`) ?? []
    logger.error(
      'Industrial video preparation failed',
      {
        sessionId,
        operation,
        ...diagnostic,
        params: {
          requirementLength: draft.requirement.length,
          attachmentCount: draft.attachments?.length ?? 0,
          hasLogo: Boolean(draft.logo),
          voice: industrialVideoVoiceId(draft.settings.voice),
          aspectRatio: draft.settings.ratio,
          style: draft.settings.type === 'marketing' ? 'marketing' : 'training',
          ...buildIndustrialVideoSettingsParams(draft.settings)
        }
        // logToMain 标记必须单独传入，否则日志服务会丢弃整个诊断对象。
      },
      { logToMain: true }
    )
    // 失败保存 error 与 input，正常 resolve（不抛出），绝不自动重试。
    writePreparation(
      sessionId,
      draft,
      {
        stage: 'failed',
        // error: cause instanceof Error ? cause.message : String(cause)
        error: `${cause instanceof Error ? cause.message : String(cause)} [${[operation, diagnostic.code ?? 'ERROR', ...fields].join('; ')}]`
      },
      Date.now()
    )
  }
}
