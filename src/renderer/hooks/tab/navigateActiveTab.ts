import { miniAppIdFromTabUrl } from '@renderer/utils/miniAppKeepAlive'
import type { Tab } from '@shared/data/cache/cacheValueTypes'

export interface NavigateInPlaceOptions {
  title?: string
  icon?: string
}

/** The slice of the tabs context `navigateActiveTab` needs. */
export interface NavigateActiveTabContext {
  activeTab: Tab | undefined
  openTab: (url: string, options?: { forceNew?: boolean; title?: string; icon?: string }) => string
  updateTab: (id: string, updates: Partial<Tab>) => void
}

/**
 * Navigate the currently active tab to `url` in place — the tab bar gains no new
 * chip. Degrades to opening a fresh tab when the active tab cannot be safely
 * rewritten (pinned tabs, no active tab); mini-app owning tabs fall back to a
 * deduped `openTab` so the global WebView pool can preserve the guest.
 */
export function navigateActiveTab(
  tabs: NavigateActiveTabContext,
  url: string,
  options: NavigateInPlaceOptions = {}
): string {
  const { title, icon } = options
  const activeTab = tabs.activeTab

  if (!activeTab || activeTab.isPinned) {
    return tabs.openTab(url, { forceNew: true, title, icon })
  }

  if (miniAppIdFromTabUrl(activeTab.url)) {
    return tabs.openTab(url, { title, icon })
  }

  tabs.updateTab(activeTab.id, {
    url,
    title: title ?? activeTab.title,
    icon: icon ?? activeTab.icon,
    metadata: undefined
  })
  return activeTab.id
}
