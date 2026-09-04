// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import type * as RouteTitle from '@renderer/utils/routeTitle'
import type { Tab } from '@shared/data/cache/cacheValueTypes'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Pin the mode constant explicitly so this suite keeps asserting single-tab
// behavior even if the production constant is ever flipped back.
vi.mock('@renderer/utils/tabMode', () => ({ SINGLE_TAB_MODE: true }))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    })
  }
}))

let pinnedTabsValue: Tab[] = []
const setPinnedTabsMock = vi.fn()
let normalTabsValue: Tab[] = []
const setNormalTabsMock = vi.fn()
let activeTabIdValue = ''
const setActiveTabIdMock = vi.fn()

vi.mock('@renderer/data/hooks/useCache', () => ({
  usePersistCache: (key: string) => {
    if (key === 'ui.tab.normal_tabs') return [normalTabsValue, setNormalTabsMock]
    if (key === 'ui.tab.active_tab_id') return [activeTabIdValue, setActiveTabIdMock]
    return [pinnedTabsValue, setPinnedTabsMock]
  }
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } })
}))

vi.mock('@renderer/utils/routeTitle', async (importOriginal) => {
  const actual = await importOriginal<typeof RouteTitle>()
  return {
    ...actual,
    getDefaultRouteTitle: (url: string) => url
  }
})

vi.mock('@renderer/ipc', () => ({
  ipcApi: { request: vi.fn() },
  useIpcOn: vi.fn()
}))

import { useTabsContext } from '@renderer/hooks/tab'

import { TabsProvider } from '../TabsProvider'

const HOME_TAB: Tab = {
  id: 'home',
  type: 'route',
  url: '/app/chat',
  title: '',
  lastAccessTime: 0,
  isDormant: false
}

function TabSnapshot() {
  const { activeTabId, tabs } = useTabsContext()
  return (
    <div>
      <div data-testid="tab-ids">{tabs.map((tab) => tab.id).join(',')}</div>
      <div data-testid="tab-urls">{tabs.map((tab) => tab.url).join(',')}</div>
      <div data-testid="tab-pinned">{tabs.map((tab) => `${tab.id}:${String(tab.isPinned ?? false)}`).join(',')}</div>
      <div data-testid="active-tab-id">{activeTabId}</div>
    </div>
  )
}

// Mimics the sidebar "open in new tab" path: openTab with forceNew.
function ForceNewOpener({ url, id }: { url: string; id?: string }) {
  const { openTab } = useTabsContext()
  const didOpenRef = useRef(false)

  useEffect(() => {
    if (didOpenRef.current) return
    didOpenRef.current = true
    openTab(url, { id, forceNew: true })
  }, [id, openTab, url])

  return <TabSnapshot />
}

function FilePreviewOpener() {
  const { openTab } = useTabsContext()
  const didOpenRef = useRef(false)

  useEffect(() => {
    if (didOpenRef.current) return
    didOpenRef.current = true
    openTab('/app/files/file/abc', { forceNew: true, title: 'report.pdf' })
  }, [openTab])

  return <TabSnapshot />
}

beforeEach(() => {
  pinnedTabsValue = []
  normalTabsValue = []
  activeTabIdValue = ''
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('TabsProvider (single-tab mode)', () => {
  it('replaces the current tab in place when openTab is called with forceNew', async () => {
    render(
      <TabsProvider initialDefaultTab={HOME_TAB} includePinnedTabs={false}>
        <ForceNewOpener url="/app/agents" id="agents" />
      </TabsProvider>
    )

    await waitFor(() => expect(screen.getByTestId('tab-ids')).toHaveTextContent('home'))
    // The requested tab never stacks: the sole tab keeps its original id and
    // adopts the requested URL instead.
    expect(screen.getByTestId('tab-ids')).toHaveTextContent('home')
    expect(screen.getByTestId('tab-urls')).toHaveTextContent('/app/agents')
    expect(screen.getByTestId('active-tab-id')).toHaveTextContent('home')
  })

  it('routes file previews into the same single tab instead of a new one', async () => {
    render(
      <TabsProvider initialDefaultTab={HOME_TAB} includePinnedTabs={false}>
        <FilePreviewOpener />
      </TabsProvider>
    )

    await waitFor(() => expect(screen.getByTestId('tab-urls')).toHaveTextContent('/app/files/file/abc'))
    expect(screen.getByTestId('tab-ids')).toHaveTextContent('home')
  })

  it('collapses a persisted multi-tab session to just the last-active tab', async () => {
    const persistedNormalTabs: Tab[] = [
      { id: 'chat-1', type: 'route', url: '/app/chat?topicId=1', title: 'Chat 1', lastAccessTime: 1, isDormant: false },
      { id: 'chat-2', type: 'route', url: '/app/chat?topicId=2', title: 'Chat 2', lastAccessTime: 5, isDormant: false }
    ]
    normalTabsValue = persistedNormalTabs
    activeTabIdValue = 'chat-2'

    render(
      <TabsProvider initialDefaultTab={HOME_TAB}>
        <TabSnapshot />
      </TabsProvider>
    )

    await waitFor(() => expect(screen.getByTestId('tab-ids')).toHaveTextContent('chat-2'))
    expect(screen.getByTestId('tab-urls')).toHaveTextContent('/app/chat?topicId=2')
    expect(screen.getByTestId('tab-ids')).not.toHaveTextContent('chat-1')
    expect(screen.getByTestId('active-tab-id')).toHaveTextContent('chat-2')
  })

  it('strips isPinned from the restored survivor so updateTab reaches the normal store', async () => {
    normalTabsValue = [
      {
        id: 'chat-1',
        type: 'route',
        url: '/app/chat?topicId=1',
        title: 'Chat 1',
        lastAccessTime: 1,
        isDormant: false
      }
    ]
    activeTabIdValue = 'chat-1'

    render(
      <TabsProvider initialDefaultTab={HOME_TAB}>
        <TabSnapshot />
      </TabsProvider>
    )

    await waitFor(() => expect(screen.getByTestId('tab-ids')).toHaveTextContent('chat-1'))
    expect(screen.getByTestId('tab-pinned')).toHaveTextContent('chat-1:false')
  })

  it('drops persisted pinned tabs entirely on restore', async () => {
    normalTabsValue = [
      { id: 'chat-1', type: 'route', url: '/app/chat?topicId=1', title: 'Chat 1', lastAccessTime: 1, isDormant: false }
    ]
    pinnedTabsValue = [
      {
        id: 'files',
        type: 'route',
        url: '/app/files',
        title: 'Files',
        lastAccessTime: 0,
        isDormant: false,
        isPinned: true
      }
    ]
    activeTabIdValue = 'chat-1'

    render(
      <TabsProvider initialDefaultTab={HOME_TAB}>
        <TabSnapshot />
      </TabsProvider>
    )

    await waitFor(() => expect(screen.getByTestId('tab-ids')).toHaveTextContent('chat-1'))
    expect(screen.getByTestId('tab-ids')).not.toHaveTextContent('files')
  })

  it('falls back to normal tab creation when no tab exists yet (detached window)', async () => {
    render(
      <TabsProvider initialDefaultTab={null} includePinnedTabs={false}>
        <ForceNewOpener url="/app/chat?topicId=t1" id="detached" />
      </TabsProvider>
    )

    // With zero tabs there is nothing to replace, so the forceNew open must
    // still materialize a tab rather than no-op.
    await waitFor(() => expect(screen.getByTestId('tab-ids')).toHaveTextContent('detached'))
    expect(screen.getByTestId('active-tab-id')).toHaveTextContent('detached')
  })
})
