import type { UpdateInfo } from 'builder-util-runtime'

import type { DoctorState } from '@shared/types/doctor'
import type { AbsoluteFilePath, FileType } from '@shared/types/file'
import type { McpTool } from '@shared/types/mcp'

import type { AgentSessionApiRetryState } from '../../ai/agentSessionApiRetry'
import type { AgentSessionBackgroundTasks, AgentSessionTaskEvents } from '../../ai/agentSessionBackgroundTasks'
import type { AgentSessionCompactionState } from '../../ai/agentSessionCompaction'
import type { AgentSessionContextUsage } from '../../ai/agentSessionContextUsage'
import type { AgentSessionFlowParts } from '../../ai/agentSessionFlowParts'
import type { AgentSessionSlashCommand } from '../../ai/agentSessionSlashCommands'
import type { AutonomousTurnOrigin } from '../../ai/agentSessionTurnOrigin'
import type { McpServer } from '../types/mcpServer'
import type { MiniApp } from '../types/miniApp'
import type { UniqueModelId } from '../types/model'
import type { ComposerMessageTokenKind } from '../types/uiParts'
import type { WebSearchStatus } from '../types/webSearch'

export interface CacheIndustrialVideoSettings {
  type: 'marketing' | 'assembly'
  duration: number
  ratio: '16:9' | '9:16' | '1:1'
  resolution: '720P' | '1080P'
  style: '工业质感' | '工业写实' | '科技' | '现代' | '武侠' | '古风'
  voice: '温柔女声' | '知性女声' | '阳光男声' | '沉稳男声' | '正式男声' | '男孩童声' | '无旁白'
  backgroundMusic: boolean
  subtitle: boolean
  withAudio: boolean
}

export interface CacheIndustrialVideoDraft {
  orchestration?: 'agent' | 'dedicated'
  requirement: string
  modelId: UniqueModelId | null
  settings: CacheIndustrialVideoSettings
  // MEA:industrial-video preparation 新增可选字段（由主代理填充，草稿持久化而非活动任务）。
  // 旧草稿缺少这些字段时按 undefined 处理，下游以可选链读取，不破坏既有写入。
  // attachments: 本地上传的素材（图片/视频/其他），仅 fileTokenSourceId/path/name 等安全字段入库。
  attachments?: CacheIndustrialVideoAttachment[]
  // materials: 知识库材料条目（解析中/就绪/失败），knowledgeItemId 关联知识库项。
  materials?: CacheIndustrialVideoMaterial[]
  // logo: 企业 Logo（dataURL 源），仅存 name 与源，绝不写入服务 base URL 或 token。
  logo?: CacheIndustrialVideoLogo
}

/**
 * 工业视频准备任务的本地附件描述，从 composer 附件裁剪而来。
 * 仅保存安全字段：文件身份、路径、名称、扩展名、大小与可选类型；不写入字节或凭证。
 */
export interface CacheIndustrialVideoAttachment {
  fileTokenSourceId: string
  path?: AbsoluteFilePath
  name: string
  origin_name: string
  ext: string
  size: number
  type?: string
}

/**
 * 工业视频准备任务的知识库材料条目。状态机与服务端解析对齐：
 * - 'parsing' 解析中（刚加入、尚未确认就绪）
 * - 'ready'   已就绪，可纳入分析上下文
 * - 'failed'  解析失败，附带 error，绝不被静默跳过或自动重试
 */
export interface CacheIndustrialVideoMaterial {
  id: string
  name: string
  path?: AbsoluteFilePath
  knowledgeItemId?: string
  status: 'parsing' | 'ready' | 'failed'
  error?: string
}

/** 企业 Logo：只存名称与 dataURL 源，上传时转二进制；不持久化任意 URL。 */
export interface CacheIndustrialVideoLogo {
  name: string
  source: string
}

/**
 * 工业视频准备任务的活动状态，持久化于 `industrial_video.preparation.${sessionId}`。
 * 与 `industrial_video.records`（主进程制作记录）分离：本表仅描述“准备阶段”
 * （资料分析 + 首次 parse），不含 run/job_id 之外的付费生成状态。
 * 状态每步持久化，且任何失败都保留 input 与 error，绝不自动重试。
 */
// export type IndustrialVideoPreparationStage = 'uploading' | 'analyzing' | 'parsing' | 'submitted' | 'failed'
export type IndustrialVideoPreparationStage =
  | 'uploading'
  | 'analyzing'
  | 'parsing'
  | 'submitted'
  | 'planning'
  | 'planned'
  | 'failed'

export interface CacheIndustrialVideoPreparation {
  planningRun?: string
  /** 任务开始时的草稿快照（含 attachments/materials/logo）。 */
  input: CacheIndustrialVideoDraft
  stage: IndustrialVideoPreparationStage
  /** 分析产出文本（parse 前的资料分析 JSON 或文本），失败时为空串。 */
  result: string
  /** 失败原因；成功或中间态为空串。 */
  error: string
  /** 任务启动时间（epoch ms），重做新版本时重置。 */
  startedAt: number
  /** 最近一次状态写回时间（epoch ms），用于 UI 轮询与跨窗口对账。 */
  updatedAt: number
}

/**
 * 专用编排的专用修改收件箱条目：用户在工作台底部输入栏提交的对成片/分镜的修改意见。
 * 仅记录文本与时间，绝不包含任何凭证或二进制；写入后触发专用编排推进（advanceIndustrialVideoOrchestration）。
 */
export interface CacheIndustrialVideoRevision {
  id: string
  text: string
  at: number
  consumedRun?: string
  scriptText?: string
}

/** 专用修改收件箱持久化结构，存于 `industrial_video.revision.${sessionId}`。 */
export interface CacheIndustrialVideoRevisionStore {
  revisions: CacheIndustrialVideoRevision[]
}

/**
 * Industrial-video production state persisted in the main-process persist cache
 * (key `industrial_video.records`, a Record keyed by agent session id).
 *
 * This is the host-owned, restart-safe record of what was actually sent to the
 * trusted service. It deliberately records:
 *  - the per-round production array (one entry per HTTP operation we issued),
 *  - the `run` directory name and the latest `job_id`,
 *  - `unknownSubmissions` — operations whose outcome we could NOT confirm
 *    (network/timeout) and which the caller must reconcile, never auto-retry,
 *  - a coarse `state` machine the host advances as the workflow proceeds.
 *
 * It never stores the service base URL or token (credentials stay in env only).
 */
export type IndustrialVideoProductionState =
  | 'idle'
  | 'parsing'
  | 'planning'
  | 'storyboard_submitted'
  | 'confirming'
  | 'generating'
  | 'assembling'
  | 'done'
  | 'failed'
  | 'blocked'
  | 'canceled'

/**
 * One *production version* of the session's industrial-video job.
 *
 * Unlike a flat HTTP log, a round captures a confirmed (or attempted) production
 * milestone: the `run` directory, the `job_id`, and the coarse `state` it moved
 * the session to. Reads (`planning_context_get`, `storyboard_get`, `qa_get`,
 * `artifact_read`, `job_list`, `get_records`) never append a round, so the array
 * stays a faithful version history and the history of `run`/`job_id` is preserved.
 */
export interface IndustrialVideoRound {
  /** 1-based production version index; a new confirmed version bumps this. */
  version: number
  /** The typed IPC operation that produced this round. */
  operation: string
  /** `run` directory this version was issued against (null for pre-run ops). */
  run: string | null
  /** Server `job_id` this version returned, else null. */
  jobId: string | null
  /** Coarse production state this version moved the session to. */
  state: IndustrialVideoProductionState
  /** Host-generated request id; empty for the pre-request intent marker. */
  requestId: string
  /** Epoch ms when the round was recorded. */
  at: number
  /** `intended` = persisted before the request; the rest are post-response outcomes. */
  outcome: 'intended' | 'ok' | 'error' | 'unknown'
  /** Operation-specific payload (e.g. the estimate object for `estimate`). */
  detail?: Record<string, unknown>
}

export interface IndustrialVideoProductionRecord {
  sessionId: string
  /** Latest confirmed production version (count of confirmed versions). */
  version: number
  /** Active `run` directory name (latest confirmed version's run), null until created. */
  run: string | null
  /** Latest `job_id` observed for this session (latest confirmed version's job). */
  jobId: string | null
  state: IndustrialVideoProductionState
  /** Confirmed-version + attempted-version history, oldest first. Never truncated. */
  rounds: IndustrialVideoRound[]
  /** Subset of `rounds` whose outcome is `unknown` (outcome-unconfirmed). */
  unknownSubmissions: IndustrialVideoRound[]
  updatedAt: number
}

export type CacheAppUpdateState = {
  info: UpdateInfo | null
  checking: boolean
  downloading: boolean
  downloaded: boolean
  downloadProgress: number
  available: boolean
  ignore: boolean
  //   /** Whether the update check was manually triggered by user clicking the button */
  manualCheck: boolean
}

export type CacheActiveSearches = Record<string, WebSearchStatus>

// For cache schema, we use any for complex types to avoid circular dependencies
// The actual type checking will be done at runtime by the cache system
export type CacheMiniAppType = MiniApp
export type CacheMcpTool = McpTool

export type McpRuntimeStatus = {
  state: 'disabled' | 'connecting' | 'connected' | 'error'
  lastCheckedAt: number
  lastError?: string
}

/**
 * MCP registry "available servers" fetched per marketplace provider, keyed by
 * provider key. Re-fetchable network data, so it lives in persist cache rather
 * than Preference/DataApi.
 */
export type McpAvailableServers = Record<string, McpServer[]>

/**
 * Tab type for browser-like tabs
 *
 * - 'route': Internal app routes rendered via MemoryRouter
 * - 'webview': External web content rendered via Electron webview
 */
export type TabType = 'route' | 'webview'

/**
 * Tab saved state for hibernation recovery
 */
export interface TabSavedState {
  scrollPosition?: number
  // 其他必要草稿字段可在此扩展
}

export interface Tab {
  id: string
  type: TabType
  url: string
  title: string
  icon?: string
  metadata?: Record<string, unknown>
  // LRU 字段
  lastAccessTime?: number // open/switch 时更新
  isDormant?: boolean // 是否已休眠
  isPinned?: boolean // 是否置顶（soft cap 下豁免 LRU；超过 hard cap 时可能休眠）
  savedState?: TabSavedState // 休眠前保存的状态
}

export interface TabsState {
  tabs: Tab[]
  activeTabId: string
}

export type GlobalSearchRecentEntry =
  | {
      kind: 'route'
      url: string
      title: string
      icon?: string
      lastAccessTime: number
    }
  | {
      kind: 'topic'
      topicId: string
      title: string
      lastAccessTime: number
    }
  | {
      kind: 'session'
      sessionId: string
      title: string
      lastAccessTime: number
    }

export type TranslatingState =
  | {
      isTranslating: true
      abortKey: string
    }
  | {
      isTranslating: false
      abortKey: null
    }

export type OpenClawGatewayStatus = 'stopped' | 'starting' | 'running' | 'error'

/**
 * Saved scroll position for a chat topic / agent-session message list.
 *
 * Stored per topic id in the Memory cache so switching topics or sessions
 * restores the previous reading position instead of jumping to the first
 * message. A `null` cache value (the schema default) means "follow the
 * latest message" — the user was at the bottom or never scrolled, so the
 * list restores to the newest message.
 */
export interface ChatScrollAnchor {
  /** Stable group key of the top-most visible message group at save time. */
  key: string
  /** Pixels scrolled past the top of that group. */
  offset: number
}

export interface CacheComposerSerializedToken {
  id: string
  kind: ComposerMessageTokenKind | 'promptVariable' | 'messagePart'
  label: string
  icon?: string
  description?: string
  promptText?: string
  payload?: unknown
  index: number
  textOffset: number
}

export interface CacheComposerAttachment {
  fileTokenSourceId: string
  path?: AbsoluteFilePath
  name: string
  origin_name: string
  ext: string
  size: number
  type: FileType
  composerFileKind?: 'pasted-text'
}

export interface CacheComposerDraftBase {
  text: string
  tokens: CacheComposerSerializedToken[]
  files: CacheComposerAttachment[]
  knowledgeBaseIds: string[]
}

export interface CacheChatComposerDraft extends CacheComposerDraftBase {
  /** Explicit per-topic model selection; runtime model records are resolved when restoring. */
  mentionedModelIds: UniqueModelId[]
  /** Selection behavior cannot be inferred when zero or one models remain selected. */
  modelMultiSelectMode: boolean
}

export interface CacheAgentComposerDraft extends CacheComposerDraftBase {
  workspaceKey: string
  agentId: string
  shouldValidateSkills?: boolean
}

/** Unsubmitted AskUserQuestion answers, keyed per question index. Survives composer remounts. */
export interface CacheAskUserQuestionDraft {
  selectedAnswers: Record<number, string[]>
  customAnswers: Record<number, string>
  currentIndex: number
}

export type ExternalOpenTargetPreferences = Record<string, string>

export type CachePaintingGenerationState = {
  status: 'running' | 'failed' | 'canceled'
  taskId: string | null
  error: string | null
  progress: number | null
}

export type CacheAgentSessionContextUsage = AgentSessionContextUsage | null
export type CacheAgentSessionCompactionState = AgentSessionCompactionState | null
export type CacheAgentSessionApiRetryState = AgentSessionApiRetryState | null
export type CacheAgentSessionSlashCommands = AgentSessionSlashCommand[] | null
export type CacheAgentSessionBackgroundTasks = AgentSessionBackgroundTasks
export type CacheAgentSessionTaskEvents = AgentSessionTaskEvents
export type CacheAgentSessionFlowParts = AgentSessionFlowParts
export type CacheAgentSessionTurnOrigin = AutonomousTurnOrigin | null

/**
 * Persisted window geometry for the WindowManager "remember bounds" capability.
 *
 * Stored in the main-process persist cache under `window.bounds`, keyed by
 * WindowType. Captured from `getNormalBounds()` (the pre-maximize rect) plus the
 * maximized flag, so a maximized window restores to maximized while un-maximizing
 * returns to the saved normal size.
 */
export type WindowBoundsState = {
  x: number
  y: number
  width: number
  height: number
  /** Whether the window was maximized at capture time. Restored by the consumer
   *  (e.g. MainWindowService) on its own show schedule, not by WindowManager. */
  isMaximized: boolean
  /** Bounds of the display the window was last on — used at restore to put the
   *  window back onto the same display (clamping into it if the saved rect no
   *  longer fits), instead of resetting to the primary display. */
  displayBounds: { x: number; y: number; width: number; height: number }
}

/**
 * Why a mini app's tile carries a dot. Derived by main, identical in every window; an
 * entry exists only while at least one reason does.
 */
export type CacheMiniAppAttention = {
  appId: string
  /** The version the last update check found, or null. */
  updateVersion: string | null
  /** Leaves a Cherry release added under a namespace the app declared, still awaiting the user. */
  pendingPermissions: string[]
  /** An update in flight: the version landing, and how far its download is (`null` = not measurable yet). */
  updating: { version: string; fraction: number | null } | null
}

/** System Doctor run state; see `@shared/types/doctor`. */
export type CacheDoctorState = DoctorState
