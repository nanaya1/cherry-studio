import { navigateActiveTab, type TabsContextValue, useOptionalTabsContext } from '@renderer/hooks/tab'
import { useWindowFrame } from '@renderer/hooks/useWindowFrame'
import { ipcApi } from '@renderer/ipc'
import type { ConversationAppId } from '@renderer/types/conversation'
import { getSidebarApp, type SidebarApp, tabBelongsToApp } from '@renderer/utils/sidebar'
import { useMemo } from 'react'
import { v4 as uuid } from 'uuid'

export interface ConversationNavigation {
  /**
   * Focus the tab already showing conversation `key` and return its id. When none exists,
   * navigate the active tab to the conversation in place (no new tab chip); falls back to
   * a fresh tab when the active tab is pinned or a mini-app owning tab. `forceNew` always
   * opens a fresh duplicate tab. Detached windows return `undefined` instead of creating a
   * hidden internal tab.
   */
  openConversationTab: (key: string, title?: string, options?: { forceNew?: boolean }) => string | undefined
  /**
   * Open conversation `key` in the current tabs context when available; otherwise
   * open it in a detached window. Detached host windows always open elsewhere.
   */
  openConversation: (key: string, title?: string) => string | undefined
  /**
   * Open conversation `key` in a fresh detached window, leaving the current window's
   * tabs untouched. Unlike a tab detach this does not require `key` to be an open tab.
   */
  openConversationWindow: (key: string, title?: string) => void
}

/** Find the tab currently showing conversation `key` of `app` (by URL-bound identity). */
function findConversationTabId(tabs: TabsContextValue | null, app: SidebarApp, key: string): string | undefined {
  if (!tabs) return undefined
  return tabs.tabs.find(
    (tab) => tab.type === 'route' && tabBelongsToApp(app, tab.url) && app.conversationRoute?.keyFromUrl(tab.url) === key
  )?.id
}

function openConversationTabImpl(
  tabs: TabsContextValue | null,
  appId: ConversationAppId,
  key: string,
  title?: string,
  forceNew?: boolean
): string | undefined {
  const app = getSidebarApp(appId)
  if (!tabs || !app?.conversationRoute) return

  if (!forceNew) {
    const existingTabId = findConversationTabId(tabs, app, key)
    if (existingTabId) {
      tabs.setActiveTab(existingTabId)
      return existingTabId
    }
    openConversationTabInPlace(tabs, appId, key, title)
    return
  }

  return tabs.openTab(app.conversationRoute.urlForKey(key), { forceNew: true, title })
}

function openConversationTabInPlace(tabs: TabsContextValue, appId: ConversationAppId, key: string, title?: string) {
  const app = getSidebarApp(appId)
  if (!app?.conversationRoute) return
  navigateActiveTab(tabs, app.conversationRoute.urlForKey(key), { title })
}

function openConversationWindowImpl(appId: ConversationAppId, key: string, title?: string): void {
  const app = getSidebarApp(appId)
  if (!app?.conversationRoute) return
  // Mirrors TabsContext.detachTab's tab.detach payload, but with a fresh tab id and
  // without closing any current-window tab — this is "open elsewhere", not "move".
  void ipcApi.request('tab.detach', {
    id: uuid(),
    url: app.conversationRoute.urlForKey(key),
    title,
    type: 'route'
  })
}

/**
 * Single boundary for "navigate to a conversation tab" intents (chat topic / agent
 * session), bound to one app. Built on the SIDEBAR_APPS registry's key↔URL mapping
 * (`conversationRoute`), so pages and lists stop touching the tabs context, `openTab`, or URL
 * helpers directly.
 *
 * Degrades to no-ops when there is no TabsProvider (tests, detached popups) or when the
 * app has no `conversationRoute`.
 */
export function useConversationNavigation(appId: ConversationAppId): ConversationNavigation {
  const tabs = useOptionalTabsContext()
  const isDetachedWindowFrame = useWindowFrame().mode === 'window'

  return useMemo<ConversationNavigation>(
    () => ({
      openConversationTab: (key, title, options) =>
        isDetachedWindowFrame ? undefined : openConversationTabImpl(tabs, appId, key, title, options?.forceNew),
      openConversation: (key, title) => {
        if (tabs && !isDetachedWindowFrame) return openConversationTabImpl(tabs, appId, key, title)
        openConversationWindowImpl(appId, key, title)
        return undefined
      },
      openConversationWindow: (key, title) => openConversationWindowImpl(appId, key, title)
    }),
    [appId, isDetachedWindowFrame, tabs]
  )
}
