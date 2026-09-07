import { useCache, usePersistCache } from '@data/hooks/useCache'
import { QuickPanelProvider } from '@renderer/components/QuickPanel'
import { useCommandHandler } from '@renderer/hooks/command'
import { useTabs } from '@renderer/hooks/tab'
import useMacTransparentWindow from '@renderer/hooks/useMacTransparentWindow'
import { useNativeFullscreen } from '@renderer/hooks/useNativeFullscreen'
import { ipcApi } from '@renderer/ipc'
import { miniAppIdFromTabUrl } from '@renderer/utils/miniAppKeepAlive'
import { isMac } from '@renderer/utils/platform'
import { getDefaultRouteTitle, isPageTitledRoute } from '@renderer/utils/routeTitle'
import { cn } from '@renderer/utils/style'
import { SINGLE_TAB_MODE } from '@renderer/utils/tabMode'
import { DefaultRendererPersistCache } from '@shared/data/cache/cacheSchemas'
import { isSettingsPath } from '@shared/data/types/settingsPath'
import { MIN_WINDOW_HEIGHT, SECOND_MIN_WINDOW_WIDTH } from '@shared/utils/window'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import Sidebar, { SidebarTitleBarIdentity } from '../app/Sidebar'
import { createRecentRouteEntryFromTab, recordGlobalSearchRecentEntry } from '../GlobalSearch/globalSearchGroups'
import GlobalSearchPopup from '../GlobalSearch/GlobalSearchPopup'
import MiniAppTabsPool from '../MiniApp/MiniAppTabsPool'
import { ResourceViewSourceProvider } from '../ResourceViewSourceProvider'
import { getSidebarLayout } from '../Sidebar'
import { AppShellTabBar } from './AppShellTabBar'
import { GlobalSearchButton, SidebarCollapseButton, SidebarExpandButton } from './ShellTabBarActions'
import { TabRouter } from './TabRouter'

// Routes whose pages stay usable below the global minimum window width.
const isCompactMinWidthRoute = (url?: string): boolean =>
  !!url && (url.startsWith('/app/chat') || url.startsWith('/app/agents'))

// Toolbox products open as transient mini apps whose appId carries this prefix
// (see ToolboxPage's openSmartMiniApp call); the remainder names the product.
const TOOLBOX_APP_ID_PREFIX = 'toolbox-'

// Breadcrumb name keys, explicit (template literals in t() are banned by the i18n lint rule).
const TOOLBOX_PRODUCT_NAME_KEYS: Record<string, string> = {
  mdo: 'workspace.toolbox.products.mdo.name',
  metam: 'workspace.toolbox.products.metam.name',
  rto: 'workspace.toolbox.products.rto.name',
  ontology: 'workspace.toolbox.products.ontology.name',
  tuling: 'workspace.toolbox.products.tuling.name',
  'production-control': 'workspace.toolbox.products.productionControl.name',
  pro: 'workspace.toolbox.products.pro.name',
  aiops: 'workspace.toolbox.products.aiops.name'
}

export const AppShell = () => {
  const { t: i18nT } = useTranslation()
  const isMacTransparentWindow = useMacTransparentWindow()
  const { tabs, activeTabId, setActiveTab, closeTab, closeTabs, updateTab, reorderTabs, pinTab, unpinTab, detachTab } =
    useTabs()
  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId), [activeTabId, tabs])
  const canCycleTabs = tabs.length > 1 && !!activeTab
  const isSettingsTabActive = isSettingsPath(activeTab?.url)
  // A toolbox product runs inside a transient mini-app tab (/app/mini-app/toolbox-<id>).
  // That tab is a focused-tab view like settings: breadcrumb back to /app/toolbox.
  const toolboxProductId = useMemo(() => {
    const miniAppId = miniAppIdFromTabUrl(activeTab?.url)
    return miniAppId?.startsWith(TOOLBOX_APP_ID_PREFIX) ? miniAppId.slice(TOOLBOX_APP_ID_PREFIX.length) : null
  }, [activeTab?.url])
  const isFocusedTabView = isSettingsTabActive || toolboxProductId != null
  const hideSidebar = isSettingsTabActive
  // Single-tab mode: entering settings rewrites the (only) tab's URL, so the
  // pre-settings workspace URL must be remembered to restore it on "back".
  const previousWorkspaceUrlRef = useRef<string | undefined>(undefined)
  if (SINGLE_TAB_MODE) {
    if (activeTab && !isSettingsTabActive) {
      previousWorkspaceUrlRef.current = activeTab.url
    } else if (isSettingsTabActive && !previousWorkspaceUrlRef.current) {
      previousWorkspaceUrlRef.current = '/app/new-task'
    }
  }
  const previousWorkspaceTabIdRef = useRef<string | undefined>(undefined)
  if (activeTab && !isSettingsTabActive) {
    previousWorkspaceTabIdRef.current = activeTab.id
  } else if (isSettingsTabActive && !previousWorkspaceTabIdRef.current) {
    previousWorkspaceTabIdRef.current = tabs.reduce<(typeof tabs)[number] | undefined>((latest, tab) => {
      if (isSettingsPath(tab.url)) return latest
      return !latest || (tab.lastAccessTime ?? 0) > (latest.lastAccessTime ?? 0) ? tab : latest
    }, undefined)?.id
  }
  // Restore the remembered workspace URL over the settings page. Empty title lets
  // the page-titled/new-task routes relabel the tab naturally.
  const handleSettingsBack = useCallback(() => {
    if (!SINGLE_TAB_MODE || !activeTab) return
    updateTab(activeTab.id, {
      url: previousWorkspaceUrlRef.current ?? '/app/new-task',
      title: '',
      icon: undefined,
      metadata: undefined,
      lastAccessTime: Date.now()
    })
  }, [activeTab, updateTab])

  // Toolbox breadcrumb back: the product tab replaced this tab's URL in place
  // (single-tab mode), so restoring /app/toolbox is enough. Default title is
  // rewritten from the route so the Wrench icon + localized label return.
  const handleToolboxBack = useCallback(() => {
    if (!SINGLE_TAB_MODE || !activeTab) return
    updateTab(activeTab.id, {
      url: '/app/toolbox',
      title: getDefaultRouteTitle('/app/toolbox'),
      icon: undefined,
      metadata: undefined,
      lastAccessTime: Date.now()
    })
  }, [activeTab, updateTab])
  // Single-tab mode hides the tab chips entirely — the header stays as the
  // window drag region / actions bar, with no tab of any kind in it.
  const tabBarTabs = useMemo(() => (SINGLE_TAB_MODE ? [] : tabs), [tabs])
  const isFullscreen = useNativeFullscreen()
  const [splitOpen, setSplitOpen] = useCache('mini_app.split_open')
  const [, setSplitMiniAppId] = useCache('mini_app.split_id')
  const [sidebarWidth, setSidebarWidth] = usePersistCache('ui.sidebar.width')
  const isSidebarHidden = getSidebarLayout(sidebarWidth) === 'hidden'

  // Split state is window-wide and does not follow the last mini-app tab out, so
  // the next mini app would open into a stale split with its app still pooled.
  const clearSplitWithLastMiniAppTab = useCallback(
    (id: string, url: string | undefined) => {
      if (!splitOpen || !miniAppIdFromTabUrl(url)) return
      const hasOtherMiniAppTab = tabs.some(
        (candidate) => candidate.id !== id && miniAppIdFromTabUrl(candidate.url) !== null
      )
      if (hasOtherMiniAppTab) return
      setSplitOpen(false)
      setSplitMiniAppId('')
    },
    [setSplitMiniAppId, setSplitOpen, splitOpen, tabs]
  )

  const handleCloseTab = useCallback(
    (id: string) => {
      const tab = tabs.find((candidate) => candidate.id === id)
      if (isSettingsPath(tab?.url)) {
        closeTabs([id], previousWorkspaceTabIdRef.current)
        return
      }
      clearSplitWithLastMiniAppTab(id, tab?.url)
      closeTab(id)
    },
    [clearSplitWithLastMiniAppTab, closeTab, closeTabs, tabs]
  )

  const handleDetachTab = useCallback(
    (id: string) => {
      const tab = tabs.find((candidate) => candidate.id === id)
      clearSplitWithLastMiniAppTab(id, tab?.url)
      detachTab(id)
      if (isSettingsPath(tab?.url) && previousWorkspaceTabIdRef.current) {
        setActiveTab(previousWorkspaceTabIdRef.current)
      }
    },
    [clearSplitWithLastMiniAppTab, detachTab, setActiveTab, tabs]
  )

  const handleOpenGlobalSearch = useCallback(() => {
    if (isSettingsTabActive) return
    void GlobalSearchPopup.show()
  }, [isSettingsTabActive])

  // Pinned tabs join the same flat cycle, matching Chrome / VS Code Ctrl+Tab.
  const cycleTab = useCallback(
    (direction: 'next' | 'prev') => {
      if (tabs.length <= 1) return
      const currentIndex = tabs.findIndex((t) => t.id === activeTabId)
      if (currentIndex === -1) return

      const offset = direction === 'next' ? 1 : -1
      const nextIndex = (currentIndex + offset + tabs.length) % tabs.length
      setActiveTab(tabs[nextIndex].id)
    },
    [tabs, activeTabId, setActiveTab]
  )

  useCommandHandler('app.search', handleOpenGlobalSearch)
  useCommandHandler('tab.next', () => cycleTab('next'), { enabled: canCycleTabs })
  useCommandHandler('tab.prev', () => cycleTab('prev'), { enabled: canCycleTabs })

  useEffect(() => {
    if (isSettingsTabActive) {
      GlobalSearchPopup.hide()
    }
  }, [isSettingsTabActive])

  // The compact minimum tracks the active tab's route here, at window level.
  // It must not live in the pages themselves: they sit inside <Activity>, whose
  // hide/show re-runs mount effects, so a per-page []-dep effect re-issues this
  // IPC pair on every tab switch.
  const activeTabAllowsCompactWidth = isCompactMinWidthRoute(activeTab?.url)
  useEffect(() => {
    if (!activeTabAllowsCompactWidth) return
    void ipcApi.request('window.main.set_minimum_size', { width: SECOND_MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT })
    return () => {
      void ipcApi.request('window.main.reset_minimum_size')
    }
  }, [activeTabAllowsCompactWidth])

  const recordRouteVisit = useCallback((tab: typeof activeTab, lastAccessTime = tab?.lastAccessTime) => {
    if (!tab) return

    const entry = createRecentRouteEntryFromTab(tab, lastAccessTime)
    if (!entry) return

    recordGlobalSearchRecentEntry(entry)
  }, [])

  useEffect(() => {
    recordRouteVisit(activeTab)
  }, [activeTab, recordRouteVisit])

  // Sync internal navigation back to tab state. For route-titled tabs we also
  // refresh the title and clear the per-entity icon (it was supplied for a
  // specific URL, e.g. a mini-app logo on /app/mini-app/<id>, and no longer
  // applies once the user navigates elsewhere inside the tab). Chat / agent
  // tabs are page-titled — their HomePage/AgentPage owns title + icon (topic /
  // session name + assistant / agent emoji), so we only sync the url and leave
  // title/icon alone, or navigating between topics would wipe them.
  const handleUrlChange = (tabId: string, url: string) => {
    const isPageTitled = isPageTitledRoute(url)
    const tab = tabs.find((candidate) => candidate.id === tabId)
    const patch = isPageTitled
      ? { url, lastAccessTime: Date.now() }
      : {
          url,
          title: getDefaultRouteTitle(url),
          icon: undefined,
          lastAccessTime: Date.now(),
          metadata: undefined
        }
    updateTab(tabId, patch)

    if (tab) {
      recordRouteVisit({ ...tab, ...patch }, Date.now())
    }
  }

  const tabBar = (
    <AppShellTabBar
      tabs={tabBarTabs}
      activeTabId={activeTabId}
      isFullscreen={isFullscreen}
      leadingActions={
        !hideSidebar ? (
          isSidebarHidden ? (
            <div
              data-testid="collapsed-sidebar-title-bar-actions"
              className={cn(
                'z-30 flex h-11 shrink-0 items-center gap-1 [-webkit-app-region:no-drag]',
                isMac && !isFullscreen ? 'ml-[env(titlebar-area-x)]' : 'ml-2'
              )}>
              <SidebarExpandButton onClick={() => setSidebarWidth(DefaultRendererPersistCache['ui.sidebar.width'])} />
              {isMac && <GlobalSearchButton />}
            </div>
          ) : !isMac ? (
            <div
              data-testid="sidebar-title-bar-actions"
              style={{ width: 'var(--sidebar-width)' }}
              className={cn(
                'flex h-11 shrink-0 items-center [-webkit-app-region:no-drag]',
                getSidebarLayout(sidebarWidth) === 'full' ? 'justify-between px-2' : 'justify-center'
              )}>
              {getSidebarLayout(sidebarWidth) === 'full' && <SidebarTitleBarIdentity />}
              <SidebarCollapseButton onClick={() => setSidebarWidth(0)} />
            </div>
          ) : undefined
        ) : undefined
      }
      isFocusedTab={isFocusedTabView}
      onFocusedTabBack={
        SINGLE_TAB_MODE ? (toolboxProductId != null ? handleToolboxBack : handleSettingsBack) : undefined
      }
      focusedTabBreadcrumb={
        toolboxProductId != null
          ? {
              label: i18nT('workspace.toolbox.title'),
              current: i18nT(TOOLBOX_PRODUCT_NAME_KEYS[toolboxProductId] ?? 'workspace.toolbox.title')
            }
          : undefined
      }
      setActiveTab={setActiveTab}
      closeTab={handleCloseTab}
      closeTabs={closeTabs}
      reorderTabs={reorderTabs}
      pinTab={pinTab}
      unpinTab={unpinTab}
      detachTab={handleDetachTab}
    />
  )

  const contentArea = (
    <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col py-2', hideSidebar ? 'px-2' : 'pr-2')}>
      <main
        data-ui="app.content"
        className="relative min-h-0 flex-1 overflow-hidden rounded-[12px] border-[0.5px] border-border bg-background">
        {/* Route Tabs: Only render non-dormant tabs */}
        {tabs
          .filter((t) => t.type === 'route' && !t.isDormant)
          .map((tab) => (
            <TabRouter
              key={tab.id}
              tab={tab}
              isActive={tab.id === activeTabId}
              onUrlChange={(url) => handleUrlChange(tab.id, url)}
            />
          ))}

        {/* MiniApp keep-alive WebView pool — global, shared across modes */}
        <MiniAppTabsPool />
      </main>
    </div>
  )

  const showTabBar = !isMac || isFocusedTabView || isSidebarHidden
  const contentColumn = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {showTabBar ? tabBar : null}
      {contentArea}
    </div>
  )

  if (!isMac) {
    return (
      <ResourceViewSourceProvider>
        <QuickPanelProvider>
          <div
            className={cn(
              'flex h-screen w-screen flex-col overflow-hidden text-foreground',
              isMacTransparentWindow ? 'bg-transparent' : 'bg-sidebar'
            )}>
            {tabBar}
            <div data-testid="app-shell-body" className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
              {!hideSidebar &&
                (isSidebarHidden ? (
                  <div data-testid="hidden-sidebar-host" className="absolute inset-y-0 left-0 z-40">
                    <Sidebar />
                  </div>
                ) : (
                  <Sidebar />
                ))}
              {contentArea}
            </div>
          </div>
        </QuickPanelProvider>
      </ResourceViewSourceProvider>
    )
  }

  return (
    <ResourceViewSourceProvider>
      <QuickPanelProvider>
        <div
          className={cn(
            'relative flex h-screen w-screen flex-row overflow-hidden text-foreground',
            isMacTransparentWindow ? 'bg-transparent' : 'bg-sidebar'
          )}>
          {!isFullscreen && (
            <div
              aria-hidden="true"
              data-testid="macos-traffic-light-drag-region"
              className="pointer-events-none absolute top-0 left-0 h-11 w-[env(titlebar-area-x)] [-webkit-app-region:drag]"
            />
          )}
          {!hideSidebar && !isSidebarHidden && (
            <div className="flex h-full min-h-0 shrink-0 flex-col [&>#app-sidebar]:min-h-0 [&>#app-sidebar]:flex-1">
              <Sidebar showTitleBar />
            </div>
          )}
          {contentColumn}
        </div>
      </QuickPanelProvider>
    </ResourceViewSourceProvider>
  )
}
