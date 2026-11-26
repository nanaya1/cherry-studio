import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { useCache, usePersistCache } from '@data/hooks/useCache'
import { isMarkdownFilePreview, useOpenFilePreviewTab } from '@renderer/components/FilePreview'
import { QuickPanelProvider } from '@renderer/components/QuickPanel'
import { useCommandHandler, useCommandRuntime } from '@renderer/hooks/command'
import { useTabs } from '@renderer/hooks/tab'
import { useLeadingWindowControlsOverlay } from '@renderer/hooks/useLeadingWindowControlsOverlay'
import useMacTransparentWindow from '@renderer/hooks/useMacTransparentWindow'
import { useNativeFullscreen } from '@renderer/hooks/useNativeFullscreen'
import { useNumberShortcutHints } from '@renderer/hooks/useNumberShortcutHints'
import { ipcApi } from '@renderer/ipc'
import { miniAppIdFromTabUrl } from '@renderer/utils/miniAppKeepAlive'
import { TAB_NUMBER_COMMANDS } from '@renderer/utils/numberShortcuts'
import { isMac } from '@renderer/utils/platform'
import { getDefaultRouteTitle, isPageTitledRoute } from '@renderer/utils/routeTitle'
import { cn } from '@renderer/utils/style'
import { SINGLE_TAB_MODE } from '@renderer/utils/tabMode'
import { DefaultRendererPersistCache } from '@shared/data/cache/cacheSchemas'
import { isSettingsPath } from '@shared/data/types/settingsPath'
import { AbsoluteFilePathSchema } from '@shared/types/file'
import { MIN_WINDOW_HEIGHT, SECOND_MIN_WINDOW_WIDTH } from '@shared/utils/window'

import Sidebar, { SidebarTitleBarIdentity } from '../app/Sidebar'
import { createRecentRouteEntryFromTab, recordGlobalSearchRecentEntry } from '../GlobalSearch/globalSearchGroups'
import GlobalSearchPopup from '../GlobalSearch/GlobalSearchPopup'
import MiniAppTabsPool from '../MiniApp/MiniAppTabsPool'
import { NotificationCenterProvider } from '../NotificationCenter'
import { ResourceViewSourceProvider } from '../ResourceViewSourceProvider'
import { getSidebarLayout } from '../Sidebar'
import { AppShellTabBar } from './AppShellTabBar'
import { GlobalSearchButton, SidebarCollapseButton, SidebarExpandButton } from './ShellTabBarActions'
import { TabRouter } from './TabRouter'

// Routes whose pages stay usable below the global minimum window width.
const isCompactMinWidthRoute = (url?: string): boolean =>
  !!url && (url.startsWith('/app/chat') || url.startsWith('/app/agents') || url.startsWith('/app/scheduled-tasks'))

// Toolbox products open as transient mini apps whose appId carries this prefix
// (see ToolboxPage's openSmartMiniApp call); the remainder names the product.
const TOOLBOX_APP_ID_PREFIX = 'toolbox-'

// Breadcrumb name keys, explicit (template literals in t() are banned by the i18n lint rule).
const TOOLBOX_PRODUCT_NAME_KEYS: Record<string, string> = {
  hufu: 'workspace.toolbox.products.hufu.name',
  gonggong: 'workspace.toolbox.products.gonggong.name',
  suanpan: 'workspace.toolbox.products.suanpan.name',
  ontology: 'workspace.toolbox.products.ontology.name',
  mdo: 'workspace.toolbox.products.mdo.name',
  metam: 'workspace.toolbox.products.metam.name',
  rto: 'workspace.toolbox.products.rto.name',
  aiops: 'workspace.toolbox.products.aiops.name'
}

export const AppShell = () => (
  <NotificationCenterProvider>
    <AppShellContent />
  </NotificationCenterProvider>
)

const AppShellContent = () => {
  const { t: i18nT } = useTranslation()
  const isMacTransparentWindow = useMacTransparentWindow()
  const openFilePreviewTab = useOpenFilePreviewTab()

  useEffect(() => {
    const handleWindowDragOver = (event: DragEvent): void => {
      if (!event.defaultPrevented && event.dataTransfer?.types.includes('Files')) event.preventDefault()
    }
    const handleWindowDrop = (event: DragEvent): void => {
      const transfer = event.dataTransfer
      if (event.defaultPrevented || !transfer || transfer.files.length !== 1) return
      if (
        Array.from(transfer.items ?? []).some((item) => item.kind === 'file' && item.webkitGetAsEntry?.()?.isDirectory)
      )
        return
      const path = AbsoluteFilePathSchema.safeParse(window.api.file.getPathForFile(transfer.files[0]))
      if (!path.success || !isMarkdownFilePreview(path.data)) return
      event.preventDefault()
      openFilePreviewTab(path.data)
    }
    window.addEventListener('dragover', handleWindowDragOver)
    window.addEventListener('drop', handleWindowDrop)
    return () => {
      window.removeEventListener('dragover', handleWindowDragOver)
      window.removeEventListener('drop', handleWindowDrop)
    }
  }, [openFilePreviewTab])
  const tabsApi = useTabs()
  const { tabs, activeTabId, setActiveTab, closeTab, closeTabs, updateTab, reorderTabs, pinTab, unpinTab, detachTab } =
    tabsApi
  const activeTab = useMemo(() => tabs.find((tab) => tab.id === activeTabId), [activeTabId, tabs])
  const canCloseTab = !!activeTab
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
  const [split, setSplit] = useCache('mini_app.split')
  const [sidebarWidth, setSidebarWidth] = usePersistCache('ui.sidebar.width')
  const isSidebarHidden = getSidebarLayout(sidebarWidth) === 'hidden'

  // Split state is window-wide and does not follow the last mini-app tab out, so
  // the next mini app would open into a stale split with its app still pooled.
  const clearSplitWithLastMiniAppTab = useCallback(
    (id: string, url: string | undefined) => {
      if (!split?.appId || !miniAppIdFromTabUrl(url)) return
      const hasOtherMiniAppTab = tabs.some(
        (candidate) => candidate.id !== id && miniAppIdFromTabUrl(candidate.url) !== null
      )
      if (hasOtherMiniAppTab) return
      setSplit(null)
    },
    [setSplit, split?.appId, tabs]
  )

  const hasLeadingWindowControls = useLeadingWindowControlsOverlay()
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
      detachTab(id, isSettingsPath(tab?.url) ? previousWorkspaceTabIdRef.current : undefined)
    },
    [clearSplitWithLastMiniAppTab, detachTab, tabs]
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

  const handleCloseActiveTab = useCallback(() => {
    if (!activeTabId) return
    if (isMac && tabs.length === 1) {
      void ipcApi.request('window.close')
      return
    }
    handleCloseTab(activeTabId)
  }, [activeTabId, handleCloseTab, tabs.length])

  const commandRuntime = useCommandRuntime()
  const tabCommandHints = useNumberShortcutHints(TAB_NUMBER_COMMANDS)
  const orderedTabs = useMemo(
    () => [...tabs.filter((tab) => tab.isPinned), ...tabs.filter((tab) => !tab.isPinned)],
    [tabs]
  )
  const tabShortcutHints = new Map(
    orderedTabs
      .slice(0, TAB_NUMBER_COMMANDS.length)
      .map((tab, index) => [tab.id, tabCommandHints.get(TAB_NUMBER_COMMANDS[index])])
  )
  useEffect(() => {
    const disposers = TAB_NUMBER_COMMANDS.map((command, index) => {
      const tab = orderedTabs[index]
      return commandRuntime.registerHandler(
        command,
        () => {
          if (tab) setActiveTab(tab.id)
        },
        { enabled: !!tab, allowInKeyboardLayer: true }
      )
    })
    return () => disposers.forEach((dispose) => dispose())
  }, [commandRuntime, setActiveTab, orderedTabs])

  useCommandHandler('app.search', handleOpenGlobalSearch, { allowInKeyboardLayer: true })
  useCommandHandler('tab.close', handleCloseActiveTab, { enabled: canCloseTab, allowInKeyboardLayer: true })
  useCommandHandler('tab.next', () => cycleTab('next'), { enabled: canCycleTabs, allowInKeyboardLayer: true })
  useCommandHandler('tab.prev', () => cycleTab('prev'), { enabled: canCycleTabs, allowInKeyboardLayer: true })

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

  // Chat / agent tabs are page-titled (topic / session name + emoji), so navigation keeps them.
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
      shortcutHints={tabShortcutHints}
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
  useEffect(() => {
    if (isSettingsTabActive) document.documentElement.style.setProperty('--notification-left', '6px')
  }, [isSettingsTabActive])

  const contentColumn = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {showTabBar ? tabBar : null}
      {contentArea}
    </div>
  )

  // Leading Linux WCO controls take the top-left corner like macOS traffic lights do.
  if (!isMac && !hasLeadingWindowControls) {
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
                    <Sidebar isFullscreen={isFullscreen} />
                  </div>
                ) : (
                  <Sidebar isFullscreen={isFullscreen} />
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
              <Sidebar showTitleBar isFullscreen={isFullscreen} />
            </div>
          )}
          {contentColumn}
        </div>
      </QuickPanelProvider>
    </ResourceViewSourceProvider>
  )
}
