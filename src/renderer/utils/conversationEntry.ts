import { cacheService } from '@data/CacheService'
import { dataApiService } from '@data/DataApiService'
import { isDataApiNotFoundError } from '@shared/data/api/errors'

/**
 * Entry-target resolution for the conversation routes (`/app/chat`, `/app/agents`),
 * called from their `beforeLoad` interceptors on a bare entry (no explicit
 * topicId / sessionId in the URL).
 *
 * Resolution order: the cross-window "last focused" id, validated by its by-id
 * endpoint, then the globally most-recently-active conversation. `null` means
 * nothing to resume — the route falls through bare and the page decides what to
 * show.
 *
 * `last_used_*` ids are never cleared on delete, so a remembered id may point at
 * a deleted row — that surfaces as NOT_FOUND here and falls through to latest.
 * These are one-shot reads rather than SWR preloads: the routes do not consume
 * the latest keys through hooks, so retaining a preload there would permanently
 * pin the first response.
 */

export async function resolveChatEntryTopicId(): Promise<string | null> {
  const lastUsedTopicId = cacheService.getPersist('ui.chat.last_used_topic_id')
  if (lastUsedTopicId) {
    try {
      await dataApiService.get(`/topics/${lastUsedTopicId}`)
      return lastUsedTopicId
    } catch (error) {
      if (!isDataApiNotFoundError(error)) throw error
    }
  }

  const { topic } = await dataApiService.get('/topics/latest')
  return topic?.id ?? null
}

export async function resolveAgentEntrySessionId(): Promise<string | null> {
  const lastUsedSessionId = cacheService.getPersist('ui.agent.last_used_session_id')
  if (lastUsedSessionId) {
    try {
      // MEA:industrial-video 普通裸入口忽略旧最近键中的视频会话。
      // await dataApiService.get(`/agent-sessions/${lastUsedSessionId}`)
      // return lastUsedSessionId
      const session = await dataApiService.get(`/agent-sessions/${lastUsedSessionId}`)
      if (session.featureKind !== 'industrial-video') return lastUsedSessionId
    } catch (error) {
      if (!isDataApiNotFoundError(error)) throw error
    }
  }

  // MEA:industrial-video 仅普通裸入口限定分类，其他历史入口保持原契约。
  // const { session } = await dataApiService.get('/agent-sessions/latest')
  const { session } = await dataApiService.get('/agent-sessions/latest', { query: { featureKind: 'general' } })
  return session?.id ?? null
}

/**
 * Entity-scoped variants used by the sidebar entries: resolve the most recent
 * conversation of one specific assistant / agent. They intentionally ignore the
 * global last-focused caches — a pinned entity entry is about that entity, not
 * whatever was last focused elsewhere.
 */
export async function resolveChatEntryTopicIdForAssistant(assistantId: string): Promise<string | null> {
  const { topic } = await dataApiService.get('/topics/latest', { query: { assistantId } })
  return topic?.id ?? null
}

export async function resolveAgentEntrySessionIdForAgent(agentId: string): Promise<string | null> {
  // MEA:industrial-video 普通 agentId 入口仅恢复普通任务，显式 sessionId 仍按分类分流。
  // const { session } = await dataApiService.get('/agent-sessions/latest', { query: { agentId } })
  const { session } = await dataApiService.get('/agent-sessions/latest', { query: { agentId, featureKind: 'general' } })
  return session?.id ?? null
}
