import type { ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'

import {
  type AgentSessionsSource,
  AgentSessionsSourceContext,
  type AssistantTopicsSource,
  AssistantTopicsSourceContext,
  type AssistantTopicsView,
  deriveAssistantTopicsView,
  useRawAgentSessionsSource,
  useRawAssistantTopicsSource
} from '@renderer/hooks/resourceViewSources'
import { useTabs } from '@renderer/hooks/tab'
// MEA: 宽松门控后 getSidebarApp/tabBelongsToApp 不再被代码引用（见 shouldLoadResourceViewSource 注释），
// 保留注释以便恢复 upstream 门控时取消注释：
// import { getSidebarApp, tabBelongsToApp } from '@renderer/utils/sidebar'
import type { SidebarAppId } from '@renderer/utils/sidebar'
// MEA: 宽松门控依赖 isSettingsPath（见 shouldLoadResourceViewSource 注释）；upstream 无此依赖
import { isSettingsPath } from '@shared/data/types/settingsPath'
import type { Tab } from '@shared/data/cache/cacheValueTypes'

const EMPTY_PIN_IDS = new Map<string, string>()
const EMPTY_TOPICS: ReturnType<typeof useRawAssistantTopicsSource>['topics'] = []
const EMPTY_ASSISTANT_TOPICS_VIEW: AssistantTopicsView = { rendererTopics: [], orderSignature: '' }

type AssistantTopicsSnapshot = Pick<ReturnType<typeof useRawAssistantTopicsSource>, 'pages' | 'topics'>
type AgentSessionsSnapshot = Pick<ReturnType<typeof useRawAgentSessionsSource>, 'pinIdBySessionId' | 'sessions'>

export function shouldLoadResourceViewSource(
  tabs: readonly Tab[],
  activeTabId: string | null | undefined,
  appId: SidebarAppId
): boolean {
  // MEA: Sidebar 收藏里的「对话/任务」列表跨页面常驻渲染（upstream 仅在对应 app 页面内渲染）。
  // upstream 的 app 归属门控会让非 agents/chat 页面（如 home、skills-connectors）上的
  // Sidebar 列表永远等不到 enabled=true → 骨架屏常驻。恢复 meacowork 的宽松门控：
  // 任意非 settings 激活 tab 即加载。原 upstream 判定保留如下（恢复时取消注释并删除上面实现）：
  // const app = getSidebarApp(appId)
  // if (!app) return false
  // const activeTab = tabs.find((tab) => tab.id === activeTabId)
  // return Boolean(activeTab?.type === 'route' && !activeTab.isDormant && tabBelongsToApp(app, activeTab.url))
  void appId
  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  return Boolean(activeTab && !isSettingsPath(activeTab.url))
}

function useCommittedAssistantTopicsSource(enabled: boolean, retainDerivedView: boolean): AssistantTopicsSource {
  const rawSource = useRawAssistantTopicsSource({ enabled })
  const [snapshot, setSnapshot] = useState<AssistantTopicsSnapshot | null>(null)
  const rawSourceReady = enabled && rawSource.isFullyLoaded && !rawSource.isRefreshing && !rawSource.error

  useEffect(() => {
    if (!rawSourceReady) return

    setSnapshot((currentSnapshot) =>
      currentSnapshot?.pages === rawSource.pages && currentSnapshot?.topics === rawSource.topics
        ? currentSnapshot
        : {
            pages: rawSource.pages,
            topics: rawSource.topics
          }
    )
  }, [rawSource.pages, rawSource.topics, rawSourceReady])

  const isColdLoading = enabled && snapshot === null
  const snapshotIsCurrent = snapshot?.pages === rawSource.pages && snapshot?.topics === rawSource.topics
  // A failed background refresh keeps serving the stale snapshot (stale-while-
  // error). While a retry fetch is actually in flight `isRefreshing` stays
  // honest, but once the source is idle with an error, `!isFullyLoaded` alone
  // must not pin consumers in a perpetual refreshing state (e.g. reorder
  // disabled) with no visible cause.
  const isBackgroundRefreshing =
    enabled &&
    snapshot !== null &&
    (rawSource.isRefreshing ||
      (!rawSource.error && (!rawSource.isFullyLoaded || (rawSourceReady && !snapshotIsCurrent))))

  const topics = snapshot?.topics ?? (enabled ? rawSource.topics : EMPTY_TOPICS)
  // Derived once per window here — kept-alive tabs consume this shared view
  // instead of each remapping the full list (see AssistantTopicsView).
  const topicsView = useMemo(
    () => (retainDerivedView ? deriveAssistantTopicsView(topics) : EMPTY_ASSISTANT_TOPICS_VIEW),
    [retainDerivedView, topics]
  )

  return useMemo(
    () => ({
      topics,
      ...topicsView,
      isLoadingAll: isColdLoading && rawSource.isLoadingAll,
      isFullyLoaded: snapshot !== null,
      isRefreshing: isBackgroundRefreshing,
      error: snapshot ? undefined : rawSource.error,
      refreshError: snapshot ? rawSource.error : undefined,
      refetch: rawSource.refetch,
      loadLatestTopic: rawSource.loadLatestTopic,
      reuseOrCreateTopic: rawSource.reuseOrCreateTopic
    }),
    [
      isBackgroundRefreshing,
      isColdLoading,
      rawSource.error,
      rawSource.isLoadingAll,
      rawSource.loadLatestTopic,
      rawSource.reuseOrCreateTopic,
      rawSource.refetch,
      topics,
      topicsView,
      snapshot
    ]
  )
}

function useCommittedAgentSessionsSource(enabled: boolean): AgentSessionsSource {
  const rawSource = useRawAgentSessionsSource({ enabled })
  const [snapshot, setSnapshot] = useState<AgentSessionsSnapshot | null>(null)
  const rawSourceReady =
    enabled &&
    rawSource.isFullyLoaded &&
    !rawSource.isValidating &&
    !rawSource.isPinsLoading &&
    !rawSource.isPinsRefreshing &&
    !rawSource.error

  useEffect(() => {
    if (!rawSourceReady) return

    setSnapshot((currentSnapshot) =>
      currentSnapshot?.pinIdBySessionId === rawSource.pinIdBySessionId &&
      currentSnapshot?.sessions === rawSource.sessions
        ? currentSnapshot
        : {
            pinIdBySessionId: rawSource.pinIdBySessionId,
            sessions: rawSource.sessions
          }
    )
  }, [rawSource.pinIdBySessionId, rawSource.sessions, rawSourceReady])

  const isColdLoading = enabled && snapshot === null
  const snapshotIsCurrent =
    snapshot?.pinIdBySessionId === rawSource.pinIdBySessionId && snapshot?.sessions === rawSource.sessions
  // See useCommittedAssistantTopicsSource: a failed background refresh serves
  // the stale snapshot and reports refreshing only while a fetch is in flight,
  // never as a perpetual error-idle state.
  const isBackgroundRefreshing =
    enabled &&
    snapshot !== null &&
    (rawSource.isValidating ||
      rawSource.isPinsRefreshing ||
      (!rawSource.error && (!rawSource.isFullyLoaded || (rawSourceReady && !snapshotIsCurrent))))

  return useMemo(
    () => ({
      sessions: snapshot?.sessions ?? (enabled ? rawSource.sessions : []),
      // `togglePin` decides pin vs unpin from the raw map, so the rendered pin
      // state has to come from that same map. A snapshot frozen by a failed
      // refresh would otherwise make the button do the opposite of its label.
      // `/pins` is a plain cached key, so reading it directly costs no flicker.
      pinIdBySessionId: enabled ? rawSource.pinIdBySessionId : (snapshot?.pinIdBySessionId ?? EMPTY_PIN_IDS),
      hasMore: snapshot || !enabled ? false : rawSource.hasMore,
      error: snapshot ? undefined : rawSource.error,
      refreshError: snapshot ? rawSource.error : undefined,
      isLoading: isColdLoading && rawSource.isLoading,
      isLoadingMore: snapshot || !enabled ? false : rawSource.isLoadingMore,
      isValidating: isBackgroundRefreshing || (isColdLoading && rawSource.isValidating),
      reload: rawSource.reload,
      deleteSession: rawSource.deleteSession,
      deleteSessionWithOutcome: rawSource.deleteSessionWithOutcome,
      deleteSessions: rawSource.deleteSessions,
      restoreSession: rawSource.restoreSession,
      reorderSession: rawSource.reorderSession,
      togglePin: rawSource.togglePin,
      loadLatestSession: rawSource.loadLatestSession,
      reuseOrCreateSession: rawSource.reuseOrCreateSession,
      isFullyLoaded: snapshot !== null,
      isLoadingAll: isColdLoading && rawSource.isLoadingAll,
      isPinsLoading: isColdLoading && rawSource.isPinsLoading
    }),
    [
      enabled,
      isBackgroundRefreshing,
      isColdLoading,
      rawSource.deleteSession,
      rawSource.deleteSessionWithOutcome,
      rawSource.deleteSessions,
      rawSource.restoreSession,
      rawSource.error,
      rawSource.hasMore,
      rawSource.isLoading,
      rawSource.isLoadingAll,
      rawSource.isLoadingMore,
      rawSource.isPinsLoading,
      rawSource.isValidating,
      rawSource.loadLatestSession,
      rawSource.reuseOrCreateSession,
      rawSource.pinIdBySessionId,
      rawSource.reload,
      rawSource.reorderSession,
      rawSource.sessions,
      rawSource.togglePin,
      snapshot
    ]
  )
}

export function ResourceViewSourceProvider({ children }: { children: ReactNode }) {
  const { activeTabId, tabs } = useTabs()
  const assistantTopicsEnabled = useMemo(
    () => shouldLoadResourceViewSource(tabs, activeTabId, 'assistants'),
    [activeTabId, tabs]
  )
  // MEA: Sidebar 收藏的「对话」列表跨页面常驻，派生视图（rendererTopics）不能随 chat tab
  // 休眠被释放，否则在非 chat 页面上 Sidebar 对话列表为空。恢复 meacowork 行为：数据源
  // 启用即保留派生视图。原 upstream 判定保留如下（恢复时取消注释并删除下面一行）：
  // const app = getSidebarApp('assistants')
  // if (!app) return false
  // return tabs.some((tab) => tab.type === 'route' && !tab.isDormant && tabBelongsToApp(app, tab.url))
  const retainAssistantTopicsView = useMemo(() => assistantTopicsEnabled, [assistantTopicsEnabled])
  const agentSessionsEnabled = useMemo(
    () => shouldLoadResourceViewSource(tabs, activeTabId, 'agents'),
    [activeTabId, tabs]
  )
  const assistantTopicsSource = useCommittedAssistantTopicsSource(assistantTopicsEnabled, retainAssistantTopicsView)
  const agentSessionsSource = useCommittedAgentSessionsSource(agentSessionsEnabled)

  return (
    <AssistantTopicsSourceContext value={assistantTopicsSource}>
      <AgentSessionsSourceContext value={agentSessionsSource}>{children}</AgentSessionsSourceContext>
    </AssistantTopicsSourceContext>
  )
}
