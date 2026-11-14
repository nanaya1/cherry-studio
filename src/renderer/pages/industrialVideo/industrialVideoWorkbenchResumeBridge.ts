/**
 * 工业专属 resume 注册模块（仅渲染端）。
 *
 * 既有回流（AgentChat 的 IndustrialVideoTaskPanel、AgentSessionMessages 的
 * IndustrialVideoMessageReview）已持有 `resumeStages(run)` 处理器。把它们按
 * `sessionId:run` 注册进来，供工业工作台 webview 宿主面板在受限桥确认成功后回调——
 * 复用既有生命周期，绝不恢复旧的直接 `ai.stream.open` 绕过生命周期的桥。
 *
 * 该模块刻意不向网页（preload）暴露：网页只能通过专属 preload 的受限桥请求，
 * 由宿主面板查表调用这里注册的回调。
 */

export type IndustrialVideoResumeHandler = (run: string) => Promise<unknown>

const handlers = new Map<string, IndustrialVideoResumeHandler>()

const keyOf = (sessionId: string, run: string): string => `${sessionId}:${run}`

export function registerResumeStages(
  sessionId: string,
  run: string,
  handler: IndustrialVideoResumeHandler
): () => void {
  const key = keyOf(sessionId, run)
  handlers.set(key, handler)
  return () => {
    if (handlers.get(key) === handler) handlers.delete(key)
  }
}

export function unregisterResumeStages(sessionId: string, run: string): void {
  handlers.delete(keyOf(sessionId, run))
}

export function getResumeStages(sessionId: string, run: string): IndustrialVideoResumeHandler | undefined {
  return handlers.get(keyOf(sessionId, run))
}
