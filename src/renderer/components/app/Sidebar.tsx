import { usePersistCache } from '@data/hooks/useCache'
import { usePreference } from '@data/hooks/usePreference'
import { arrayMove } from '@dnd-kit/sortable'
import { loggerService } from '@logger'
import AppLogo from '@renderer/assets/images/logo.png'
import Sessions from '@renderer/components/chat/resourceList/Sessions'
import { Topics } from '@renderer/components/chat/resourceList/Topics'
import type { AddNewTopicPayload } from '@renderer/components/composer/variants/shared/composerProviderActions'
import { useAgents } from '@renderer/hooks/agent/useAgent'
import { useAgentSessionsSource, useAssistantTopicsSource } from '@renderer/hooks/resourceViewSources'
import { useTabs } from '@renderer/hooks/tab'
import { useAssistantsApi } from '@renderer/hooks/useAssistant'
import useAvatar from '@renderer/hooks/useAvatar'
import { useConversationNavigation } from '@renderer/hooks/useConversationNavigation'
import { useMiniApps } from '@renderer/hooks/useMiniApps'
import { useSidebarFavorites } from '@renderer/hooks/useSidebarFavorites'
import { mapApiTopicToRendererTopic } from '@renderer/hooks/useTopic'
import { openSettingsTab } from '@renderer/services/mainWindowNavigation'
import { toast } from '@renderer/services/toast'
import { formatErrorMessageWithPrefix } from '@renderer/utils/error'
import { MINI_APP_ROUTE_PREFIX, miniAppIdFromTabUrl } from '@renderer/utils/miniAppKeepAlive'
import { isMac } from '@renderer/utils/platform'
import { getDefaultRouteTitle } from '@renderer/utils/routeTitle'
import type { SidebarAppId } from '@renderer/utils/sidebar'
import {
  getSidebarApp,
  getSidebarFavoriteKey,
  getSidebarMenuPath,
  isMessageOnlyConversationUrl,
  resolveSidebarActiveItem,
  tabBelongsToApp
} from '@renderer/utils/sidebar'
import { cn } from '@renderer/utils/style'
import { APP_NAME } from '@shared/utils/constants'
import { CalendarClock, Plus, Puzzle, Shapes, Wrench } from 'lucide-react'
import type { Ref } from 'react'
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { GlobalSearchButton, SidebarCollapseButton, SidebarShellActions } from '../layout/ShellTabBarActions'
import type { ResolvedSidebarEntry } from '../Sidebar'
import {
  getSidebarDisplayWidth,
  getSidebarLayout,
  normalizeSidebarWidth,
  Sidebar as UISidebar,
  type SidebarUser,
  type SidebarVisibleLayout
} from '../Sidebar'
import UserPopup from '../UserPopup'
import { resolveSidebarEntry, type SidebarVariantContext } from './sidebarVariants'

const FeedbackDialog = lazy(() => import('../feedback/FeedbackDialog'))

const logger = loggerService.withContext('app.Sidebar')

export function SidebarTitleBarIdentity() {
  return (
    <div data-testid="sidebar-title-bar-identity" className="flex min-w-0 items-center gap-2">
      <img src={AppLogo} alt="" className="size-6 shrink-0 rounded-lg object-cover" />
      <span className="truncate font-bold text-sidebar-foreground text-sm">{APP_NAME}</span>
    </div>
  )
}

export default function Sidebar({
  ref,
  showTitleBar = false
}: {
  ref?: Ref<HTMLDivElement | null>
  showTitleBar?: boolean
}) {
  const { t } = useTranslation()
  const [userName] = usePreference('app.user.name')
  const {
    favorites,
    appFavorites,
    miniAppFavoriteIds,
    agentFavoriteIds,
    assistantFavoriteIds,
    setAppPinned,
    removeMiniApp,
    removeAgent,
    removeAssistant,
    reorderFavorites
  } = useSidebarFavorites()
  const { activeTab, tabs, updateTab, openTab, setActiveTab } = useTabs()
  const assistantTopicsSource = useAssistantTopicsSource()
  const { rendererTopics } = assistantTopicsSource
  const agentSessionsSource = useAgentSessionsSource()
  const { openConversationTab: openAssistantConversationTab } = useConversationNavigation('assistants')
  const { openConversationTab: openAgentConversationTab } = useConversationNavigation('agents')
  const { miniApps, pinned } = useMiniApps({ enabled: miniAppFavoriteIds.length > 0 })
  const { agents } = useAgents({ enabled: agentFavoriteIds.length > 0 })
  const { assistants } = useAssistantsApi({ enabled: assistantFavoriteIds.length > 0 })
  const [defaultPaintingProvider] = usePreference('feature.paintings.default_provider')
  // Pinned entity rows render through the same icon renderers as their rails, so they
  // follow the same icon-type preferences instead of always showing the emoji.
  const [assistantIconType] = usePreference('assistant.icon_type')
  const [agentIconType] = usePreference('agent.icon_type')
  const [defaultModelId] = usePreference('chat.default_model_id')

  const installedAgents = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const installedAssistants = useMemo(
    () => new Map(assistants.map((assistant) => [assistant.id, assistant])),
    [assistants]
  )

  // Sidebar width — persisted across restarts. Dragging through the
  // intermediate 50-120px range uses a local preview width so the UI can
  // follow the cursor without persisting unstable widths.
  const [sidebarWidth, setSidebarWidth] = usePersistCache('ui.sidebar.width')
  const [previewSidebarWidth, setPreviewSidebarWidth] = useState<number | null>(null)
  const [feedbackDialogMounted, setFeedbackDialogMounted] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const activeSidebarWidth = previewSidebarWidth ?? sidebarWidth

  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--sidebar-width', `${getSidebarDisplayWidth(activeSidebarWidth)}px`)
  }, [activeSidebarWidth])

  // Migration, not dead code: the resize path only persists normalized widths,
  // but older builds (three-state layout, default 65) persisted intermediate
  // values that must be collapsed once on load. Writing derived state back
  // cannot loop — normalizeSidebarWidth is idempotent and the write is guarded
  // by the inequality check. Skip while a drag preview is active so the
  // write-back does not clobber it.
  useEffect(() => {
    if (previewSidebarWidth !== null) return

    const normalizedWidth = normalizeSidebarWidth(sidebarWidth)
    if (normalizedWidth !== sidebarWidth) {
      setSidebarWidth(normalizedWidth)
    }
  }, [previewSidebarWidth, setSidebarWidth, sidebarWidth])

  // User avatar
  const avatar = useAvatar()
  const sidebarUser = useMemo<SidebarUser>(
    () => ({
      name: userName || t('chat.user', { defaultValue: t('export.user', { defaultValue: 'User' }) }),
      description: t('workspace.localUser'),
      avatar: avatar || undefined,
      onClick: () => UserPopup.show(),
      settingsLabel: t('settings.title'),
      onSettingsClick: () => openSettingsTab()
    }),
    [avatar, t, userName]
  )
  const sidebarLogo = useMemo(() => <img src={AppLogo} alt="" className="h-full w-full object-cover" />, [])

  // Floating sidebar (hover reveal when hidden)
  const [hoverVisible, setHoverVisible] = useState(false)
  const layout = getSidebarLayout(activeSidebarWidth)

  // Menu items
  const pathname = activeTab?.url || '/'
  const activeTopicId = getSidebarApp('assistants')?.conversationRoute?.keyFromUrl(pathname)
  const activeTopic = rendererTopics.find((topic) => topic.id === activeTopicId)
  const activeSessionId = getSidebarApp('agents')?.conversationRoute?.keyFromUrl(pathname) ?? null
  const activeMiniAppId = miniAppIdFromTabUrl(activeTab?.url) ?? undefined
  const openableMiniAppById = useMemo(() => {
    const appById = new Map<string, (typeof miniApps)[number]>()
    for (const app of miniApps) {
      appById.set(app.appId, app)
    }
    for (const app of pinned) {
      appById.set(app.appId, app)
    }
    return appById
  }, [miniApps, pinned])

  const handleRemoveSidebarFavorite = useCallback(
    (favorite: SidebarAppId) => {
      setAppPinned(favorite, false)
    },
    [setAppPinned]
  )

  const activeItem = resolveSidebarActiveItem(pathname)

  const navigateRouteTab = useCallback(
    (path: string, title: string, options?: { inNewTab?: boolean; icon?: string }) => {
      if (options?.inNewTab) {
        openTab(path, { forceNew: true, title, icon: options.icon })
        return
      }

      if (activeTab?.url === path) return

      if (activeTab?.isPinned) {
        openTab(path, { forceNew: true, title, icon: options?.icon })
        return
      }

      // Keep a Mini App's owning tab intact when leaving it so the global
      // WebView pool can preserve the guest instead of treating it as closed.
      if (miniAppIdFromTabUrl(activeTab?.url)) {
        openTab(path, { title, icon: options?.icon })
        return
      }

      if (activeTab) {
        updateTab(activeTab.id, {
          url: path,
          title,
          icon: options?.icon,
          metadata: undefined
        })
        return
      }

      openTab(path, { forceNew: true, title, icon: options?.icon })
    },
    [activeTab, openTab, updateTab]
  )

  const handleNavigate = useCallback(
    (menuItemId: string, options?: { inNewTab?: boolean }) => {
      const menuId = menuItemId as SidebarAppId
      const app = getSidebarApp(menuId)
      const path = getSidebarMenuPath(menuId, defaultPaintingProvider)
      if (!app || !path) return

      if (!options?.inNewTab) {
        // Conversation apps: any owned tab is already "there" — its URL carries its own
        // conversation, and re-entering through the route interceptor would just rebind
        // it. Message-only viewers are not an app entry, so they navigate like any
        // foreign tab. Apps without sub-instances keep exact-URL matching.
        const isActiveTarget =
          !!activeTab &&
          (app.conversationRoute
            ? tabBelongsToApp(app, activeTab.url) && !isMessageOnlyConversationUrl(activeTab.url)
            : activeTab.url === path)
        if (isActiveTarget) return
      }

      navigateRouteTab(path, getDefaultRouteTitle(path), options)
    },
    [activeTab, defaultPaintingProvider, navigateRouteTab]
  )

  // The group-header "+" button reuses the assistant's newest empty placeholder conversation
  // (creating one when none qualifies) and opens it, mirroring HomePage's new-topic flow.
  const handleNewTopic = useCallback(
    async (payload?: AddNewTopicPayload) => {
      try {
        const result = await assistantTopicsSource.reuseOrCreateTopic(payload?.assistantId ?? null)
        const topic = mapApiTopicToRendererTopic(result.topic)
        openAssistantConversationTab(topic.id, topic.name || t('chat.conversation.new'))
        if (result.created) {
          void assistantTopicsSource.refetch()
        }
      } catch (err) {
        logger.error('Failed to create conversation from sidebar', err as Error)
        toast.error(formatErrorMessageWithPrefix(err, t('common.error')))
      }
    },
    [assistantTopicsSource, openAssistantConversationTab, t]
  )
  const handleOpenSettingsTab = useCallback(() => {
    openSettingsTab()
  }, [])
  const handleOpenFeedback = useCallback(() => {
    setFeedbackDialogMounted(true)
    setFeedbackOpen(true)
  }, [])

  const handleOpenMiniAppTab = useCallback(
    (appId: string, options?: { inNewTab?: boolean }) => {
      const app = openableMiniAppById.get(appId)
      if (!app) return

      const path = `${MINI_APP_ROUTE_PREFIX}${app.appId}`
      const title = app.nameKey ? t(app.nameKey) : app.name
      // Uploaded logo → main-resolved `logoSrc`; preset key → `logo`.
      const icon = app.logoSrc ?? app.logo
      if (options?.inNewTab) {
        navigateRouteTab(path, title, { ...options, icon })
        return
      }

      if (activeTab?.url === path) return

      const existingTab = tabs.find((tab) => tab.type === 'route' && tab.url === path)
      if (existingTab) {
        setActiveTab(existingTab.id)
        return
      }

      navigateRouteTab(path, title, { ...options, icon })
    },
    [activeTab, navigateRouteTab, openableMiniAppById, setActiveTab, t, tabs]
  )

  // Pinned entities reuse tabs like mini apps do; the route interceptor turns the
  // `agentId` / `assistantId` param into that entity's most recent conversation.
  const handleOpenAgentTab = useCallback(
    (agentId: string, options?: { inNewTab?: boolean }) => {
      const agent = installedAgents.get(agentId)
      if (!agent) return
      navigateRouteTab(`/app/agents?agentId=${encodeURIComponent(agentId)}`, agent.name, options)
    },
    [installedAgents, navigateRouteTab]
  )
  const handleOpenAssistantTab = useCallback(
    (assistantId: string, options?: { inNewTab?: boolean }) => {
      const assistant = installedAssistants.get(assistantId)
      if (!assistant) return
      navigateRouteTab(`/app/chat?assistantId=${encodeURIComponent(assistantId)}`, assistant.name, options)
    },
    [installedAssistants, navigateRouteTab]
  )

  // All per-type sidebar knowledge (icon, label, route, active-match, open, remove)
  // lives in the variant registry; the container only supplies the runtime context.
  const variantContext = useMemo<SidebarVariantContext>(
    () => ({
      t,
      defaultPaintingProvider,
      installedMiniApps: openableMiniAppById,
      installedAgents,
      installedAssistants,
      assistantIconType,
      agentIconType,
      defaultModelId,
      visibleAppCount: appFavorites.length,
      openApp: handleNavigate,
      openMiniApp: handleOpenMiniAppTab,
      openAgent: handleOpenAgentTab,
      openAssistant: handleOpenAssistantTab,
      removeApp: handleRemoveSidebarFavorite,
      removeMiniApp,
      removeAgent,
      removeAssistant
    }),
    [
      t,
      defaultPaintingProvider,
      openableMiniAppById,
      installedAgents,
      installedAssistants,
      assistantIconType,
      agentIconType,
      defaultModelId,
      appFavorites.length,
      handleNavigate,
      handleOpenMiniAppTab,
      handleOpenAgentTab,
      handleOpenAssistantTab,
      handleRemoveSidebarFavorite,
      removeMiniApp,
      removeAgent,
      removeAssistant
    ]
  )

  // One continuous list: built-in apps and mini apps interleaved in their stored
  // favorites order. Unrenderable rows (no route/icon, or an uninstalled mini app)
  // are dropped here but stay in the preference.
  const navigationEntries = useMemo(
    () => [
      {
        key: 'workspace:new-task',
        label: t('workspace.newTask.title'),
        renderIcon: (size: number) => <Plus size={size} />,
        isActive: () => pathname.startsWith('/app/new-task'),
        onOpen: () => navigateRouteTab('/app/new-task', t('workspace.newTask.title'))
      },
      {
        key: 'workspace:toolbox',
        label: t('workspace.toolbox.title'),
        renderIcon: (size: number) => <Wrench size={size} />,
        isActive: () => pathname.startsWith('/app/toolbox'),
        onOpen: () => navigateRouteTab('/app/toolbox', t('workspace.toolbox.title'))
      },
      {
        key: 'workspace:skills-connectors',
        label: t('workspace.skillsConnectors.title'),
        renderIcon: (size: number) => <Puzzle size={size} />,
        isActive: () => pathname.startsWith('/app/skills-connectors'),
        onOpen: () => navigateRouteTab('/app/skills-connectors', t('workspace.skillsConnectors.title'))
      },
      {
        key: 'workspace:scheduled-tasks',
        label: t('settings.scheduledTasks.title'),
        renderIcon: (size: number) => <CalendarClock size={size} />,
        isActive: () => pathname.startsWith('/app/scheduled-tasks'),
        onOpen: () => navigateRouteTab('/app/scheduled-tasks', t('settings.scheduledTasks.title'))
      }
    ],
    [navigateRouteTab, pathname, t]
  )

  const historySections = useMemo(
    () => [
      {
        id: 'conversations',
        label: t('workspace.history.conversations'),
        collapsible: true,
        content: (
          <div className="flex min-h-0 flex-col overflow-hidden [-webkit-app-region:no-drag]">
            <Topics
              activeTopic={activeTopic}
              assistantTopicsSource={assistantTopicsSource}
              className="bg-transparent"
              clearActiveTopic={() => handleNavigate('assistants')}
              setActiveTopic={(topic) =>
                openAssistantConversationTab(topic.id, topic.name || t('chat.conversation.new'))
              }
              onNewTopic={handleNewTopic}
              showHeader={false}
            />
          </div>
        )
      },
      {
        id: 'agent-tasks',
        label: t('workspace.history.agentTasks'),
        collapsible: true,
        content: (
          <div className="flex min-h-0 flex-col overflow-hidden [-webkit-app-region:no-drag]">
            <Sessions
              activeSessionId={activeSessionId}
              agentSessionsSource={agentSessionsSource}
              className="bg-transparent"
              setActiveSessionId={(sessionId, session) => {
                if (sessionId) {
                  openAgentConversationTab(sessionId, session?.name || t('agent.session.new'))
                } else {
                  handleNavigate('agents')
                }
              }}
              showHeader={false}
            />
          </div>
        )
      }
    ],
    [
      activeTopic,
      assistantTopicsSource,
      handleNavigate,
      handleNewTopic,
      activeSessionId,
      agentSessionsSource,
      openAgentConversationTab,
      openAssistantConversationTab,
      t
    ]
  )

  const entries = useMemo(
    () =>
      favorites.flatMap((favorite) => {
        const entry = resolveSidebarEntry(favorite, variantContext)
        if (!entry) return []

        const newTabItem = entry.onOpenNewTab
          ? [
              {
                type: 'item' as const,
                id: `sidebar.open-in-new-tab.${entry.key}`,
                label: t('common.open_in_new_tab'),
                onSelect: entry.onOpenNewTab
              }
            ]
          : []

        return [
          {
            ...entry,
            // "Manage Sidebar" (launchpad entry) temporarily hidden.
            contextMenuItems: [...newTabItem, ...(entry.contextMenuItems ?? [])]
          }
        ]
      }),
    [favorites, t, variantContext]
  )

  // "More" panel entries: Resource Center plus the pinned built-in apps that route
  // to their own pages (translate / paintings / knowledge). Entity favorites
  // (agents / assistants) and mini apps stay in the icon-rail favorites list.
  const moreMenuEntries = useMemo(() => {
    const resourcesEntry: ResolvedSidebarEntry = {
      key: 'workspace:resources',
      label: t('workspace.resources.title'),
      renderIcon: (size: number) => <Shapes size={size} />,
      isActive: () => pathname.startsWith('/app/resources'),
      onOpen: () => navigateRouteTab('/app/resources', t('workspace.resources.title'))
    }
    const byKey = new Map(entries.map((entry) => [entry.key, entry]))
    const pickApp = (id: SidebarAppId) => byKey.get(`app:${id}`) ?? null

    return [resourcesEntry, pickApp('translate'), pickApp('paintings'), pickApp('knowledge')].filter(
      (entry): entry is ResolvedSidebarEntry => entry !== null
    )
  }, [entries, navigateRouteTab, pathname, t])

  // A single drag reorders the whole mixed list. arrayMove yields the new entry
  // order; map each entry back to its favorite by key and persist. The sidebar owns
  // its order entirely through `ui.sidebar.favorites` and never touches order keys.
  const handleReorder = useCallback(
    ({ oldIndex, newIndex }: { oldIndex: number; newIndex: number }) => {
      const byKey = new Map(favorites.map((favorite) => [getSidebarFavoriteKey(favorite), favorite]))
      const nextFavorites = arrayMove(entries, oldIndex, newIndex).flatMap((entry) => {
        const favorite = byKey.get(entry.key)
        return favorite ? [favorite] : []
      })
      reorderFavorites(nextFavorites)
    },
    [entries, favorites, reorderFavorites]
  )

  // Common props shared between normal and floating sidebar
  const sidebarProps = {
    entries,
    navigationEntries,
    moreMenu: { label: t('common.more'), entries: moreMenuEntries },
    sections: historySections,
    entriesLabel: t('workspace.favorites'),
    sectionsLabel: t('history.records.shortTitle'),
    active: { activeItem, activeTabId: activeMiniAppId },
    title: APP_NAME,
    logo: sidebarLogo,
    user: sidebarUser,
    actions: (footerLayout: SidebarVisibleLayout, onOverlayOpenChange?: (open: boolean) => void) => (
      <SidebarShellActions
        layout={footerLayout}
        onFeedbackClick={handleOpenFeedback}
        onSettingsClick={handleOpenSettingsTab}
        onOverlayOpenChange={onOverlayOpenChange}
      />
    ),
    onEntriesReorder: handleReorder
  }

  return (
    <div
      ref={ref}
      id="app-sidebar"
      data-ui="app.sidebar"
      className="relative flex h-full min-h-0 flex-col [-webkit-app-region:no-drag]">
      {showTitleBar && layout !== 'hidden' ? (
        <div
          data-testid="sidebar-title-bar-actions"
          style={{ width: getSidebarDisplayWidth(activeSidebarWidth) }}
          className={cn(
            'flex h-11 shrink-0 items-center gap-1 [-webkit-app-region:drag]',
            layout === 'full' ? 'justify-end pr-2' : 'justify-center'
          )}>
          {(layout === 'full' || !isMac) && (
            <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
              <SidebarCollapseButton onClick={() => setSidebarWidth(0)} />
              {isMac && layout === 'full' && <GlobalSearchButton />}
            </div>
          )}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <UISidebar
          width={activeSidebarWidth}
          setWidth={setSidebarWidth}
          showHeader={isMac}
          onHoverChange={setHoverVisible}
          onResizePreview={setPreviewSidebarWidth}
          {...sidebarProps}
        />
      </div>
      {hoverVisible && layout === 'hidden' && (
        <UISidebar
          width={activeSidebarWidth}
          setWidth={setSidebarWidth}
          isFloating
          onDismiss={() => setHoverVisible(false)}
          {...sidebarProps}
        />
      )}
      {feedbackDialogMounted ? (
        <Suspense fallback={null}>
          <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
        </Suspense>
      ) : null}
    </div>
  )
}
