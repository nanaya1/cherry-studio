/**
 * 工业工作台网页（服务端 `/workbench`）与客户端宿主之间的受限桥接协议。
 *
 * 仅暴露两个能力：`get_review_snapshot`（读取同版审核快照）与 `regenerate_storyboard`
 * （显式点击请求重生成分镜）。网页永远拿不到通用 ipc / 令牌 / assertion / prompt / model。
 *
 * 消息经 `ipcRenderer.sendToHost`（网页→宿主）与 `webview.send`（宿主→网页）往返，
 * 以 `requestId` 关联；宿主侧负责校验来源/会话/run/版本，并去重与防并发。
 *
 * 该模块只放协议常量与类型，供主进程 preload 与渲染端宿主面板共同引用。
 */

/** 受限桥接通道（网页↔宿主），与通用 webview 注解/按键通道严格区分。 */
export const INDUSTRIAL_VIDEO_WORKBENCH_BRIDGE_CHANNEL = 'industrial-video-workbench:bridge'

/** 网页通过 `contextBridge` 暴露的全局对象键名。 */
export const INDUSTRIAL_VIDEO_WORKBENCH_API_KEY = 'industrialVideoWorkbench'

export const INDUSTRIAL_VIDEO_WORKBENCH_MESSAGE_TYPE = {
  /** 宿主→网页：注入可信会话/run，仅此 partition 的专属 preload 会收到。 */
  init: 'init',
  /** 网页→宿主：请求读取当前展示的审核快照。 */
  getSnapshot: 'get_review_snapshot',
  /** 网页→宿主：显式请求 regenerate_storyboard（绑定点击时的 review_version）。 */
  regenerateStoryboard: 'regenerate_storyboard',
  /** 宿主→网页：查询当前活跃工作台的未保存状态，绑定 requestId；每次操作现查。 */
  dirtyQuery: 'dirty_query',
  /** 网页→宿主：dirty 查询响应，绑定同一 requestId。 */
  dirtyQueryResponse: 'dirty_query_response',
  /** 宿主→网页：请求回执。 */
  response: 'response'
} as const

export type IndustrialVideoWorkbenchMessageType =
  (typeof INDUSTRIAL_VIDEO_WORKBENCH_MESSAGE_TYPE)[keyof typeof INDUSTRIAL_VIDEO_WORKBENCH_MESSAGE_TYPE]

export interface IndustrialVideoWorkbenchSnapshot {
  review_version: string
  script: string
  storyboard: unknown
  effective_settings: unknown
  allowed_actions: string[]
  [key: string]: unknown
}

export interface IndustrialVideoWorkbenchConfirmReceipt {
  task_operation?: string
  generation_allowed?: boolean
  remaining_blockers?: unknown[]
  [key: string]: unknown
}

/** 网页发起的受限请求信封（run/sessionId 由宿主 init 后回填，宿主再以自身可信值校验）。 */
export interface IndustrialVideoWorkbenchRequest {
  requestId: string
  type:
    | typeof INDUSTRIAL_VIDEO_WORKBENCH_MESSAGE_TYPE.getSnapshot
    | typeof INDUSTRIAL_VIDEO_WORKBENCH_MESSAGE_TYPE.regenerateStoryboard
  sessionId: string
  run: string
  /** 用户点击时绑定的审核版本；必须与展示版本一致，禁止用新取版本替代。 */
  reviewVersion?: string
}

/** 宿主→网页的 dirty 查询；绑定 requestId 与可信 session/run。 */
export interface IndustrialVideoWorkbenchDirtyQuery {
  requestId: string
  type: typeof INDUSTRIAL_VIDEO_WORKBENCH_MESSAGE_TYPE.dirtyQuery
  sessionId: string
  run: string
}

/** 网页→宿主的 dirty 查询响应；dirty 必须为严格布尔，未知值不得回传。 */
export interface IndustrialVideoWorkbenchDirtyQueryResponse {
  requestId: string
  type: typeof INDUSTRIAL_VIDEO_WORKBENCH_MESSAGE_TYPE.dirtyQueryResponse
  sessionId: string
  run: string
  dirty: boolean
}

/** 宿主→网页的回执信封，以 requestId 关联。 */
export interface IndustrialVideoWorkbenchResponse {
  requestId: string
  type: typeof INDUSTRIAL_VIDEO_WORKBENCH_MESSAGE_TYPE.response
  ok: boolean
  data?: unknown
  error?: string
  code?: string
}

/** 宿主→网页的 init 信封，注入可信会话/run。 */
export interface IndustrialVideoWorkbenchInit {
  type: typeof INDUSTRIAL_VIDEO_WORKBENCH_MESSAGE_TYPE.init
  sessionId: string
  run: string
}
