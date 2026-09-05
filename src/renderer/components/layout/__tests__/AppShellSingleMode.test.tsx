// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { useQuickPanel } from '@renderer/components/QuickPanel'
import { MockUseCacheUtils } from '@test-mocks/renderer/useCache'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { type ReactNode, useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Pin the mode on so this suite keeps asserting single-tab bar behavior even if
// the production constant is ever flipped back.
vi.mock('@renderer/utils/tabMode', () => ({ SINGLE_TAB_MODE: true }))

const mocks = vi.hoisted(() => ({
  closeTab: vi.fn(),
  closeTabs: vi.fn(),
  detachTab: vi.fn(),
  setActiveTab: vi.fn(),
  updateTab: vi.fn(),
  commandHandlers: new Map<string, { handler: () => void; options?: { enabled?: boolean } }>(),
  ipcHandlers: new Map<string, (value: unknown) => void>(),
  ipcRequest: vi.fn(() => Promise.resolve(false)),
  activeTabId: 'home',
  platformState: { isMac: false },
  tabs: [
    {
      id: 'home',
      isDormant: false,
      title: 'Chat',
      type: 'route' as const,
      url: '/app/chat'
    }
  ],
  tabBarProps: undefined as Record<string, unknown> | undefined,
  showSearchPopup: vi.fn(),
  hideSearchPopup: vi.fn(),
  providerMounts: 0,
  providerUnmounts: 0
}))

vi.mock('@renderer/hooks/useMacTransparentWindow', () => ({
  default: () => false
}))

vi.mock('@renderer/utils/platform', () => ({
  get isMac() {
    return mocks.platformState.isMac
  }
}))

vi.mock('@renderer/hooks/command', () => ({
  useCommandHandler: (command: string, handler: () => void, options?: { enabled?: boolean }) => {
    mocks.commandHandlers.set(command, { handler, options })
  }
}))

vi.mock('@renderer/ipc', () => ({
  ipcApi: {
    request: mocks.ipcRequest
  },
  useIpcOn: (event: string, handler: (value: unknown) => void) => {
    mocks.ipcHandlers.set(event, handler)
  }
}))

vi.mock('@renderer/components/GlobalSearch/GlobalSearchPopup', () => ({
  default: {
    show: mocks.showSearchPopup,
    hide: mocks.hideSearchPopup
  }
}))

vi.mock('@renderer/hooks/tab', () => ({
  useMainWindowNavigation: vi.fn(),
  useTabs: () => ({
    activeTabId: mocks.activeTabId,
    closeTab: mocks.closeTab,
    closeTabs: mocks.closeTabs,
    detachTab: mocks.detachTab,
    openTab: vi.fn(),
    pinTab: vi.fn(),
    reorderTabs: vi.fn(),
    setActiveTab: mocks.setActiveTab,
    tabs: mocks.tabs,
    unpinTab: vi.fn(),
    updateTab: mocks.updateTab
  })
}))

vi.mock('../../app/Sidebar', () => ({
  default: function Sidebar() {
    useQuickPanel()
    return <aside data-testid="sidebar" />
  }
}))

vi.mock('../../GlobalSearch/globalSearchGroups', () => ({
  createRecentRouteEntryFromTab: () => null,
  upsertGlobalSearchRecentEntry: (items: unknown[]) => items
}))

vi.mock('../../MiniApp/MiniAppTabsPool', () => ({
  default: () => <div data-testid="mini-app-pool" />
}))

vi.mock('../../ResourceViewSourceProvider', () => ({
  ResourceViewSourceProvider: ({ children }: { children: ReactNode }) => {
    useEffect(() => {
      mocks.providerMounts += 1
      return () => {
        mocks.providerUnmounts += 1
      }
    }, [])
    return <div data-testid="resource-view-source-provider">{children}</div>
  }
}))

vi.mock('../AppShellTabBar', () => ({
  AppShellTabBar: (props: Record<string, unknown>) => {
    mocks.tabBarProps = props
    return <header data-testid="tab-bar" />
  }
}))

vi.mock('../TabRouter', () => ({
  TabRouter: ({ tab }: { tab: { id: string } }) => {
    useQuickPanel()
    return <section data-testid="tab-router" data-tab-id={tab.id} />
  }
}))

import { AppShell } from '../AppShell'

const homeTab = {
  id: 'home',
  isDormant: false,
  title: 'Chat',
  type: 'route' as const,
  url: '/app/chat'
}

const settingsTab = {
  id: 'settings',
  isDormant: false,
  title: 'Settings',
  type: 'route' as const,
  url: '/settings/provider'
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  MockUseCacheUtils.resetMocks()
  mocks.commandHandlers.clear()
  mocks.ipcHandlers.clear()
  mocks.ipcRequest.mockResolvedValue(false)
  mocks.activeTabId = 'home'
  mocks.platformState.isMac = false
  mocks.tabs = [homeTab]
  mocks.tabBarProps = undefined
  mocks.providerMounts = 0
  mocks.providerUnmounts = 0
})

describe('AppShell (single-tab mode tab bar)', () => {
  it('hides tab chips while the header remains mounted for drag/actions', () => {
    mocks.tabs = [homeTab, { id: 'extra', isDormant: false, title: 'Extra', type: 'route' as const, url: '/app/files' }]

    render(<AppShell />)

    expect(screen.getByTestId('tab-bar')).toBeInTheDocument()
    // No tab is listed even though several exist — the strip is empty.
    expect(mocks.tabBarProps?.tabs).toEqual([])
    expect(mocks.tabBarProps).toHaveProperty('onFocusedTabBack', expect.any(Function))
  })

  it('keeps the focused settings state (with back handler) while still passing no chips', async () => {
    // Enter settings from the workspace so the shell remembers the workspace URL.
    const { rerender } = render(<AppShell />)
    expect(mocks.tabBarProps?.tabs).toEqual([])

    mocks.tabs = [homeTab, settingsTab]
    mocks.activeTabId = 'settings'
    rerender(<AppShell />)

    // Focused or not, the strip stays empty — the back affordance lives on the
    // right side of the header, not in any tab-shaped element.
    expect(mocks.tabBarProps?.tabs).toEqual([])
    expect(mocks.tabBarProps).toHaveProperty('isFocusedTab', true)
    const onBack = mocks.tabBarProps?.onFocusedTabBack as (() => void) | undefined
    expect(onBack).toEqual(expect.any(Function))
    // Back restores the workspace tab in place instead of closing it.
    onBack?.()
    await waitFor(() =>
      expect(mocks.updateTab).toHaveBeenCalledWith(settingsTab.id, expect.objectContaining({ url: homeTab.url }))
    )
  })
})
