import { contextBridge, ipcRenderer } from 'electron'

import {
  INDUSTRIAL_VIDEO_WORKBENCH_API_KEY,
  INDUSTRIAL_VIDEO_WORKBENCH_BRIDGE_CHANNEL,
  INDUSTRIAL_VIDEO_WORKBENCH_MESSAGE_TYPE
} from '@shared/utils/industrialVideoWorkbench'

/**
 * 工业工作台专属 preload：仅注入 `industrial-video-workbench:*` 这一专属 partition
 * （见 IndustrialVideoWorkbenchSecurity）。保留 sandbox / contextIsolation / nodeIntegration=false。
 *
 * 网页能拿到的能力严格只有两个：
 *  1. getReviewSnapshot()         —— 读取同版审核快照（用于展示 script/分镜/设置/review_version）
 *  2. requestRegenerateStoryboard(reviewVersion) —— 显式点击“修改动作分镜”
 *
 * 不暴露 ipcRenderer.send / invoke、令牌、assertion、prompt、model 或任何通用能力。
 * 所有请求经 sendToHost 上行、回执经 ipcRenderer.on 下行，以 requestId 关联。
 */

let trustedSession: { sessionId: string; run: string } | null = null

ipcRenderer.on(INDUSTRIAL_VIDEO_WORKBENCH_BRIDGE_CHANNEL, (_event, message: unknown) => {
  if (!message || typeof message !== 'object') return
  const msg = message as { type?: string; sessionId?: string; run?: string }
  if (msg.type === INDUSTRIAL_VIDEO_WORKBENCH_MESSAGE_TYPE.init && typeof msg.sessionId === 'string' && typeof msg.run === 'string') {
    trustedSession = { sessionId: msg.sessionId, run: msg.run }
  }
})

function sendRequest<T>(type: string, extra: Record<string, unknown> = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!trustedSession) {
      reject(new Error('工作台尚未就绪，请稍后重试。'))
      return
    }
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => {
      ipcRenderer.removeListener(INDUSTRIAL_VIDEO_WORKBENCH_BRIDGE_CHANNEL, onResponse)
      reject(new Error('工作台响应超时，请重试。'))
    }, 20000)
    const onResponse = (_event: unknown, payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const response = payload as { requestId?: string; ok?: boolean; data?: T; error?: string; code?: string }
      if (response.requestId !== requestId) return
      clearTimeout(timer)
      ipcRenderer.removeListener(INDUSTRIAL_VIDEO_WORKBENCH_BRIDGE_CHANNEL, onResponse)
      if (response.ok) resolve(response.data as T)
      else reject(new Error(response.error ?? '工作台请求失败'))
    }
    ipcRenderer.on(INDUSTRIAL_VIDEO_WORKBENCH_BRIDGE_CHANNEL, onResponse)
    ipcRenderer.sendToHost(INDUSTRIAL_VIDEO_WORKBENCH_BRIDGE_CHANNEL, {
      requestId,
      type,
      sessionId: trustedSession.sessionId,
      run: trustedSession.run,
      ...extra
    })
  })
}

const api = {
  /** 读取当前展示的审核快照（同版）。 */
  getReviewSnapshot: () =>
    sendRequest<Record<string, unknown>>(INDUSTRIAL_VIDEO_WORKBENCH_MESSAGE_TYPE.getSnapshot),
  /** 显式点击：请求重新生成动作分镜，绑定点击时的 review_version。 */
  requestRegenerateStoryboard: (reviewVersion: string) =>
    sendRequest<Record<string, unknown>>(INDUSTRIAL_VIDEO_WORKBENCH_MESSAGE_TYPE.regenerateStoryboard, {
      reviewVersion
    })
}

contextBridge.exposeInMainWorld(INDUSTRIAL_VIDEO_WORKBENCH_API_KEY, api)
