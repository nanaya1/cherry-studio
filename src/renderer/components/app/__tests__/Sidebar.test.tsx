// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import type { CommandContextMenuExtraItem } from '@renderer/components/command'
import type { SidebarAppId } from '@renderer/utils/sidebar'
import type { SidebarFavoriteItem } from '@shared/data/preference/preferenceTypes'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as SidebarModule from '../../Sidebar'
import type { ResolvedSidebarEntry, SidebarProps } from '../../Sidebar'

type FakeTab = {
  id: string
  type: 'route' | 'miniapp'
  url: string
  title: string
  icon?: string
  isPinned?: boolean
  metadata?: Record<string, unknown>
}

type FakeMiniApp = {
  appId: string
  name: string
  logo?: string
  url: string
}

type FakeAgent = {
  id: string
  name: string
}

type FakeAssistant = {
  id: string
  name: string
}

type FakeConversation = {
  id: string
  name: string
}

const mocks = vi.hoisted(() => ({
  emitResourceListReveal: vi.fn(),
  openAgentConversationTab: vi.fn(),
  openAssistantConversationTab: vi.fn(),
  openTab: vi.fn(),
  openSettingsTab: vi.fn(),
  setActiveTab: vi.fn(),
  useAssistantTopicsSource: {
    reuseOrCreateTopic: vi.fn()
  },
  useMiniApps: vi.fn(),
  updateTab: vi.fn(),
  activeTab: {
    id: 'chat',
    type: 'route',
    url: '/app/chat',
    title: 'Chat'
  } as FakeTab | null,
  setSidebarWidth: vi.fn(),
  setSidebarFavorites: vi.fn(() => Promise.resolve()),
  reorderMiniAppsByStatus: vi.fn(() => Promise.resolve()),
  showUserPopup: vi.fn(),
  showSearchPopup: vi.fn(),
  sidebarWidth: 50,
  tabs: [] as FakeTab[],
  sidebarFavorites: [{ type: 'app', id: 'assistants' }] as SidebarFavoriteItem[],
  sidebarMiniAppFavorites: [] as SidebarFavoriteItem[],
  sidebarAgentFavorites: [] as SidebarFavoriteItem[],
  sidebarAssistantFavorites: [] as SidebarFavoriteItem[],
  agents: [] as FakeAgent[],
  assistants: [] as FakeAssistant[],
  topics: [] as FakeConversation[],
  sessions: [] as FakeConversation[],
  allApps: [] as FakeMiniApp[],
  visibleMiniApps: null as FakeMiniApp[] | null,
  pinnedMiniApps: [] as FakeMiniApp[],
  sidebarProps: [] as unknown[]
}))

vi.mock('@data/hooks/useCache', () => ({
  usePersistCache: () => {
    return [
      mocks.sidebarWidth,
      (width: number) => {
        mocks.sidebarWidth = width
        mocks.setSidebarWidth(width)
      }
    ]
  }
}))

vi.mock('@data/hooks/usePreference', () => ({
  usePreference: (key: string) => {
    if (key === 'app.user.name') return ['JD']
    if (key === 'ui.sidebar.favorites')
      return [
        [
          ...mocks.sidebarFavorites,
          ...mocks.sidebarMiniAppFavorites,
          ...mocks.sidebarAgentFavorites,
          ...mocks.sidebarAssistantFavorites
        ],
        mocks.setSidebarFavorites
      ]
    return [undefined]
  }
}))

vi.mock('@renderer/hooks/agent/useAgent', () => ({
  useAgents: () => ({
    agents: mocks.agents
  })
}))

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistantsApi: () => ({
    assistants: mocks.assistants
  })
}))

vi.mock('@renderer/hooks/useAvatar', () => ({
  default: () => undefined
}))

vi.mock('@renderer/hooks/resourceViewSources', () => ({
  useAssistantTopicsSource: () => ({
    topics: mocks.topics,
    rendererTopics: mocks.topics,
    ...mocks.useAssistantTopicsSource
  }),
  useAgentSessionsSource: () => ({ sessions: mocks.sessions })
}))

vi.mock('@renderer/components/chat/resourceList/Topics', () => ({
  Topics: ({
    assistantTopicsSource,
    className,
    setActiveTopic,
    onNewTopic,
    showHeader
  }: {
    assistantTopicsSource: { rendererTopics: FakeConversation[] }
    className?: string
    setActiveTopic: (topic: FakeConversation) => void
    onNewTopic?: (payload?: { assistantId?: string | null }) => void | Promise<void>
    showHeader?: boolean
  }) => (
    <div
      className={className}
      data-testid="conversation-topic-list"
      data-show-header={showHeader}
      data-on-new-topic={onNewTopic ? 'true' : 'false'}>
      {assistantTopicsSource.rendererTopics.map((topic) => (
        <button key={topic.id} type="button" onClick={() => setActiveTopic(topic)}>
          {topic.name}
        </button>
      ))}
      <button type="button" onClick={() => void onNewTopic?.()}>
        new-conversation
      </button>
    </div>
  )
}))

vi.mock('@renderer/components/chat/resourceList/Sessions', () => ({
  default: ({
    agentSessionsSource,
    className,
    setActiveSessionId,
    showHeader
  }: {
    agentSessionsSource: { sessions: FakeConversation[] }
    className?: string
    setActiveSessionId: (id: string, session: FakeConversation) => void
    showHeader?: boolean
  }) => (
    <div className={className} data-testid="agent-session-list" data-show-header={showHeader}>
      {agentSessionsSource.sessions.map((session) => (
        <button key={session.id} type="button" onClick={() => setActiveSessionId(session.id, session)}>
          {session.name}
        </button>
      ))}
    </div>
  )
}))

vi.mock('@renderer/hooks/useMiniApps', () => ({
  useMiniApps: (options?: { enabled?: boolean }) => {
    mocks.useMiniApps(options)
    return {
      allApps: mocks.allApps,
      miniApps: mocks.visibleMiniApps ?? mocks.allApps,
      pinned: mocks.pinnedMiniApps,
      reorderMiniAppsByStatus: mocks.reorderMiniAppsByStatus
    }
  }
}))
vi.mock('@renderer/i18n/label', () => ({
  getSidebarIconLabelKey: (icon: string) =>
    ({
      agents: 'Work',
      assistants: 'Chat',
      translate: 'Translate'
    })[icon] ?? icon
}))

vi.mock('@renderer/utils/routeTitle', () => ({
  getDefaultRouteTitle: (url: string) =>
    ({
      '/app/agents': 'Work',
      '/app/chat': 'Chat',
      '/app/files': 'Files',
      '/app/launchpad': 'Launchpad',
      '/app/translate': 'Translate'
    })[url] ?? 'Chat'
}))

vi.mock('@renderer/services/resourceListRevealEvents', () => ({
  emitResourceListReveal: mocks.emitResourceListReveal
}))

vi.mock('@renderer/hooks/useConversationNavigation', () => ({
  useConversationNavigation: (appId: string) => ({
    openConversationTab: appId === 'assistants' ? mocks.openAssistantConversationTab : mocks.openAgentConversationTab
  })
}))

vi.mock('@renderer/hooks/tab', () => ({
  useTabs: () => ({
    activeTab: mocks.activeTab,
    tabs: mocks.tabs,
    openTab: mocks.openTab,
    updateTab: mocks.updateTab,
    setActiveTab: mocks.setActiveTab
  }),
  useOptionalTabsContext: () => ({
    tabs: mocks.tabs,
    openTab: mocks.openTab,
    setActiveTab: mocks.setActiveTab
  })
}))

vi.mock('@renderer/services/mainWindowNavigation', () => ({
  openSettingsTab: mocks.openSettingsTab
}))

vi.mock('../../UserPopup', () => ({
  default: {
    show: mocks.showUserPopup
  }
}))

vi.mock('../../icons/SvgIcon', () => ({
  OpenClawSidebarIcon: () => null
}))

vi.mock('../../feedback/FeedbackDialog', () => ({
  default: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => (
    <div data-testid="feedback-shell" data-open={open}>
      {open ? <div role="dialog">feedback-dialog</div> : null}
      <button type="button" onClick={() => onOpenChange(false)}>
        close-feedback
      </button>
    </div>
  )
}))

vi.mock('../../layout/ShellTabBarActions', () => ({
  GlobalSearchButton: () => <button type="button" aria-label="Open global search" onClick={mocks.showSearchPopup} />,
  SidebarCollapseButton: ({ onClick }: { onClick: () => void }) => (
    <button type="button" aria-label="Collapse" onClick={onClick} />
  ),
  SidebarShellActions: ({
    layout,
    onFeedbackClick,
    onSettingsClick
  }: {
    layout: string
    onFeedbackClick: () => void
    onSettingsClick: () => void
  }) => (
    <>
      <button type="button" data-testid={`sidebar-shell-actions-${layout}`} onClick={onSettingsClick} />
      <button type="button" data-testid={`sidebar-feedback-${layout}`} onClick={onFeedbackClick} />
    </>
  )
}))

vi.mock('../../Sidebar', async (importOriginal) => {
  const actual = await importOriginal<typeof SidebarModule>()
  return {
    ...actual,
    MiniAppIcon: () => null,
    Sidebar: (props: SidebarProps) => {
      mocks.sidebarProps.push(props)
      return null
    }
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => {
      if (key === 'common.search') return 'Search'
      if (key === 'common.more') return 'More'
      if (key === 'launchpad.manage_sidebar') return 'Manage Sidebar'
      if (key === 'launchpad.favorites') return 'Favorites'
      if (key === 'title.launchpad') return 'Launchpad'
      if (key === 'settings.scheduledTasks.title') return 'Scheduled Tasks'
      if (key === 'workspace.newTask.title') return 'New task'
      if (key === 'workspace.resources.title') return 'Resource Center'
      if (key === 'workspace.skillsConnectors.title') return 'Skills & Connectors'
      if (key === 'workspace.localUser') return 'Local user'
      if (key === 'workspace.favorites') return 'Favorites'
      if (key === 'history.records.shortTitle') return 'History'
      if (key === 'workspace.history.conversations') return 'Conversations'
      if (key === 'workspace.history.agentTasks') return 'Tasks'
      return options?.defaultValue ?? key
    }
  })
}))

import Sidebar from '../Sidebar'

const appFavorite = (id: SidebarAppId): SidebarFavoriteItem => ({ type: 'app', id })
const miniAppFavorite = (id: string): SidebarFavoriteItem => ({ type: 'mini_app', id })
const agentFavorite = (id: string): SidebarFavoriteItem => ({ type: 'agent', id })
const assistantFavorite = (id: string): SidebarFavoriteItem => ({ type: 'assistant', id })
const calculatorMiniApp: FakeMiniApp = {
  appId: 'calculator',
  name: 'Calculator',
  logo: 'calculator-logo',
  url: 'https://calc.example'
}
const weatherMiniApp: FakeMiniApp = {
  appId: 'weather',
  name: 'Weather',
  logo: 'weather-logo',
  url: 'https://weather.example'
}

function configureMiniApps(favoriteIds: string[], apps: FakeMiniApp[] = [calculatorMiniApp]) {
  mocks.sidebarFavorites = [appFavorite('assistants'), appFavorite('mini_app')]
  mocks.sidebarMiniAppFavorites = favoriteIds.map(miniAppFavorite)
  mocks.allApps = apps
}

function getSidebarProps(index = -1) {
  return mocks.sidebarProps.at(index) as SidebarProps
}

function getEntry(key: string) {
  const entry = getSidebarProps().entries.find((item) => item.key === key)
  expect(entry).toBeDefined()
  return entry as ResolvedSidebarEntry
}

function getNavigationEntry(key: string) {
  const entry = getSidebarProps().navigationEntries?.find((item) => item.key === key)
  expect(entry).toBeDefined()
  return entry as ResolvedSidebarEntry
}

type SidebarMenuItem = Extract<CommandContextMenuExtraItem, { type: 'item' }>

function findMenuItem(entry: ResolvedSidebarEntry, id: string) {
  return entry.contextMenuItems?.find(
    (candidate): candidate is SidebarMenuItem => candidate.type === 'item' && candidate.id === id
  )
}

function selectMenuItem(entry: ResolvedSidebarEntry, id: string) {
  const item = findMenuItem(entry, id)
  expect(item).toBeDefined()
  act(() => item?.onSelect())
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.sidebarFavorites = [appFavorite('assistants')]
  mocks.sidebarMiniAppFavorites = []
  mocks.sidebarAgentFavorites = []
  mocks.sidebarAssistantFavorites = []
  mocks.agents = []
  mocks.assistants = []
  mocks.topics = []
  mocks.sessions = []
  mocks.setSidebarFavorites.mockReset()
  mocks.setSidebarFavorites.mockResolvedValue(undefined)
  mocks.reorderMiniAppsByStatus.mockReset()
  mocks.reorderMiniAppsByStatus.mockResolvedValue(undefined)
  mocks.useMiniApps.mockReset()
  mocks.activeTab = {
    id: 'chat',
    type: 'route',
    url: '/app/chat',
    title: 'Chat'
  }
  mocks.tabs = []
  mocks.allApps = []
  mocks.visibleMiniApps = null
  mocks.pinnedMiniApps = []
  mocks.sidebarWidth = 50
  mocks.sidebarProps = []
  vi.useRealTimers()
  document.documentElement.style.removeProperty('--sidebar-width')
})

describe('app Sidebar', () => {
  it('supplies main navigation and both history groups without clearing favorites', () => {
    mocks.sidebarWidth = 180
    mocks.sidebarFavorites = [appFavorite('translate'), appFavorite('assistants')]
    mocks.topics = [{ id: 'topic-1', name: 'Release planning' }]
    mocks.sessions = [{ id: 'session-1', name: 'Audit dependencies' }]

    render(<Sidebar />)

    expect(getSidebarProps().navigationEntries?.map((entry) => entry.label)).toEqual([
      'New task',
      'workspace.toolbox.title',
      'Skills & Connectors',
      'Scheduled Tasks'
    ])
    expect(getSidebarProps().sections?.map((section) => section.label)).toEqual(['Conversations', 'Tasks'])
    expect(getSidebarProps().sections?.[0]?.content).toBeDefined()
    expect(getSidebarProps().sections?.[1]?.content).toBeDefined()
    expect(mocks.setSidebarFavorites).not.toHaveBeenCalled()
  })

  it('aggregates Resource Center and translate/paintings/knowledge entries in the More menu', () => {
    mocks.sidebarFavorites = [
      appFavorite('agents'),
      appFavorite('translate'),
      appFavorite('knowledge'),
      appFavorite('assistants'),
      appFavorite('paintings')
    ]

    render(<Sidebar />)

    const moreMenu = getSidebarProps().moreMenu
    expect(moreMenu?.label).toBe('More')
    expect(moreMenu?.entries.map((entry) => entry.key)).toEqual([
      'workspace:resources',
      'app:translate',
      'app:paintings',
      'app:knowledge'
    ])
    act(() => moreMenu?.entries[0].onOpen())
    expect(mocks.updateTab).toHaveBeenCalledWith('chat', {
      url: '/app/resources',
      title: 'Resource Center',
      icon: undefined,
      metadata: undefined
    })
  })

  it('opens scheduled tasks in the active workspace tab', () => {
    render(<Sidebar />)

    act(() => getNavigationEntry('workspace:scheduled-tasks').onOpen())

    expect(mocks.updateTab).toHaveBeenCalledWith('chat', {
      url: '/app/scheduled-tasks',
      title: 'Scheduled Tasks',
      icon: undefined,
      metadata: undefined
    })
    expect(mocks.openSettingsTab).not.toHaveBeenCalled()
  })

  it('reuses or creates a conversation from the conversations + action', async () => {
    const user = userEvent.setup()
    mocks.useAssistantTopicsSource.reuseOrCreateTopic.mockResolvedValue({
      topic: { id: 'topic-new', name: '' },
      created: true
    })

    render(<Sidebar />)

    const conversationContent = getSidebarProps().sections?.find((section) => section.id === 'conversations')?.content
    render(conversationContent)
    expect(screen.getByTestId('conversation-topic-list')).toHaveAttribute('data-on-new-topic', 'true')

    await user.click(screen.getByRole('button', { name: 'new-conversation' }))

    expect(mocks.useAssistantTopicsSource.reuseOrCreateTopic).toHaveBeenCalledWith(null)
    expect(mocks.openAssistantConversationTab).toHaveBeenCalledWith('topic-new', 'chat.conversation.new')
    expect(mocks.updateTab).not.toHaveBeenCalledWith('chat', expect.objectContaining({ url: '/app/new-task' }))
  })

  it('opens conversation and task history entries at their exact routes', async () => {
    const user = userEvent.setup()
    mocks.topics = [{ id: 'topic-1', name: 'Release planning' }]
    mocks.sessions = [{ id: 'session-1', name: 'Audit dependencies' }]

    render(<Sidebar />)

    const conversationContent = getSidebarProps().sections?.find((section) => section.id === 'conversations')?.content
    render(conversationContent)
    const conversationList = screen.getByTestId('conversation-topic-list')
    expect(conversationList).toHaveAttribute('data-show-header', 'false')
    expect(conversationList).toHaveClass('bg-transparent')
    expect(conversationList.parentElement).toHaveClass('[-webkit-app-region:no-drag]')
    await user.click(screen.getByRole('button', { name: 'Release planning' }))
    expect(mocks.openAssistantConversationTab).toHaveBeenLastCalledWith('topic-1', 'Release planning')

    const taskContent = getSidebarProps().sections?.find((section) => section.id === 'agent-tasks')?.content
    render(taskContent)
    const taskList = screen.getByTestId('agent-session-list')
    expect(taskList).toHaveAttribute('data-show-header', 'false')
    expect(taskList).toHaveClass('bg-transparent')
    expect(taskList.parentElement).toHaveClass('[-webkit-app-region:no-drag]')
    await user.click(screen.getByRole('button', { name: 'Audit dependencies' }))
    expect(mocks.openAgentConversationTab).toHaveBeenLastCalledWith('session-1', 'Audit dependencies')
    expect(mocks.updateTab).not.toHaveBeenCalled()
  })

  it('loads mini apps only when the sidebar contains a custom mini-app favorite', () => {
    const view = render(<Sidebar />)
    expect(mocks.useMiniApps).toHaveBeenLastCalledWith({ enabled: false })

    mocks.sidebarMiniAppFavorites = [miniAppFavorite('mini-1')]
    view.rerender(<Sidebar />)

    expect(mocks.useMiniApps).toHaveBeenLastCalledWith({ enabled: true })
  })

  it('supplies product identity, user, and footer actions', () => {
    const { container } = render(<Sidebar />)
    const props = getSidebarProps()

    expect(container.querySelector('#app-sidebar')).toHaveAttribute('data-ui', 'app.sidebar')
    expect(props.title).toBe('MEA Cowork')
    expect(props.logo).toBeDefined()
    expect(props.user).toMatchObject({ name: 'JD', description: 'Local user' })
    expect(props.actions).toEqual(expect.any(Function))
    expect(mocks.showUserPopup).not.toHaveBeenCalled()
  })

  it('moves search and sidebar collapse actions into the macOS sidebar title bar', () => {
    mocks.sidebarWidth = 210
    render(<Sidebar showTitleBar />)

    expect(screen.getByTestId('sidebar-title-bar-actions')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open global search' }))
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))

    expect(mocks.showSearchPopup).toHaveBeenCalledOnce()
    expect(mocks.setSidebarWidth).toHaveBeenCalledWith(0)
  })

  it('opens settings in a main-window tab from the sidebar footer action', () => {
    render(<Sidebar />)
    const actions = getSidebarProps().actions
    const view = render(typeof actions === 'function' ? actions('icon') : actions)

    fireEvent.click(view.getByTestId('sidebar-shell-actions-icon'))

    expect(mocks.openSettingsTab).toHaveBeenCalledWith()
  })

  it('keeps feedback mounted when the floating sidebar closes', async () => {
    const user = userEvent.setup()
    mocks.sidebarWidth = 0
    render(<Sidebar />)

    act(() => getSidebarProps().onHoverChange?.(true))
    const floatingProps = getSidebarProps()
    expect(floatingProps.isFloating).toBe(true)

    const actions = floatingProps.actions
    const view = render(typeof actions === 'function' ? actions('full') : actions)
    await user.click(view.getByTestId('sidebar-feedback-full'))
    expect(await screen.findByRole('dialog')).toHaveTextContent('feedback-dialog')

    act(() => floatingProps.onDismiss?.())
    expect(getSidebarProps().isFloating).toBeFalsy()
    expect(screen.getByRole('dialog')).toHaveTextContent('feedback-dialog')

    await user.click(screen.getByRole('button', { name: 'close-feedback' }))
    expect(screen.getByTestId('feedback-shell')).toHaveAttribute('data-open', 'false')
  })

  it('supplies sidebar entries in visible preference order', () => {
    mocks.sidebarFavorites = [appFavorite('translate'), appFavorite('assistants'), appFavorite('agents')]

    render(<Sidebar />)

    expect(getSidebarProps().entries.map((entry) => entry.label)).toEqual(['Translate', 'Chat', 'Work'])
  })

  it('removes a sidebar app favorite from the context menu', () => {
    mocks.sidebarFavorites = [appFavorite('assistants'), appFavorite('knowledge'), appFavorite('files')]
    render(<Sidebar />)

    const entry = getEntry('app:knowledge')
    expect(findMenuItem(entry, 'sidebar.remove-app.knowledge')?.label).toBe('launchpad.unpin_from_sidebar')
    selectMenuItem(entry, 'sidebar.remove-app.knowledge')

    expect(mocks.setSidebarFavorites).toHaveBeenCalledWith([appFavorite('assistants'), appFavorite('files')])
  })

  it('allows removing the chat assistant when other apps remain', () => {
    mocks.sidebarFavorites = [appFavorite('assistants'), appFavorite('knowledge')]
    render(<Sidebar />)

    const entry = getEntry('app:assistants')
    expect(findMenuItem(entry, 'sidebar.remove-app.assistants')?.enabled).not.toBe(false)
    selectMenuItem(entry, 'sidebar.remove-app.assistants')

    expect(mocks.setSidebarFavorites).toHaveBeenCalledWith([appFavorite('knowledge')])
  })

  it('disables removing the last sidebar app', () => {
    render(<Sidebar />)

    const item = findMenuItem(getEntry('app:assistants'), 'sidebar.remove-app.assistants')
    expect(item?.enabled).toBe(false)
    expect(mocks.setSidebarFavorites).not.toHaveBeenCalled()
  })

  it('hides the manage sidebar action from the context menu', () => {
    mocks.sidebarFavorites = [appFavorite('knowledge')]
    render(<Sidebar />)

    const entry = getEntry('app:knowledge')
    expect(findMenuItem(entry, 'sidebar.manage.app:knowledge')).toBeUndefined()
    expect(mocks.openTab).not.toHaveBeenCalled()
  })

  it('supplies favorite mini apps and their active state', () => {
    configureMiniApps(['calculator', 'weather'], [calculatorMiniApp, weatherMiniApp])
    mocks.activeTab = {
      id: 'calculator-tab',
      type: 'route',
      url: '/app/mini-app/calculator',
      title: 'Calculator'
    }

    render(<Sidebar />)

    expect(getSidebarProps().entries.map((entry) => [entry.key, entry.label])).toEqual([
      ['app:assistants', 'Chat'],
      ['app:mini_app', 'mini_app'],
      ['mini_app:calculator', 'Calculator'],
      ['mini_app:weather', 'Weather']
    ])
    expect(getEntry('mini_app:calculator').isActive(getSidebarProps().active)).toBe(true)
  })

  it('removes a sidebar mini app favorite from the context menu', () => {
    configureMiniApps(['calculator', 'weather'], [calculatorMiniApp, weatherMiniApp])
    render(<Sidebar />)

    selectMenuItem(getEntry('mini_app:calculator'), 'sidebar.remove-mini-app.calculator')

    expect(mocks.setSidebarFavorites).toHaveBeenCalledWith([
      appFavorite('assistants'),
      appFavorite('mini_app'),
      miniAppFavorite('weather')
    ])
  })

  it('does not offer the manage sidebar action for mini app favorites', () => {
    mocks.sidebarFavorites = []
    mocks.sidebarMiniAppFavorites = [miniAppFavorite('calculator')]
    mocks.allApps = [calculatorMiniApp]

    render(<Sidebar />)

    expect(getEntry('mini_app:calculator').contextMenuItems).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'sidebar.manage.mini_app:calculator' })])
    )
  })

  it('reorders sidebar favorites through a single mixed drag', () => {
    mocks.sidebarFavorites = [appFavorite('assistants'), appFavorite('knowledge'), appFavorite('files')]
    mocks.sidebarMiniAppFavorites = [miniAppFavorite('calculator')]
    mocks.allApps = [calculatorMiniApp]
    render(<Sidebar />)

    act(() => getSidebarProps().onEntriesReorder?.({ oldIndex: 2, newIndex: 0 }))

    expect(mocks.setSidebarFavorites).toHaveBeenCalledWith([
      appFavorite('files'),
      appFavorite('assistants'),
      appFavorite('knowledge'),
      miniAppFavorite('calculator')
    ])
  })

  it('reorders mini app favorites without touching the mini app order key', () => {
    configureMiniApps(['calculator', 'weather'], [calculatorMiniApp, weatherMiniApp])
    render(<Sidebar />)

    act(() => getSidebarProps().onEntriesReorder?.({ oldIndex: 3, newIndex: 2 }))

    expect(mocks.setSidebarFavorites).toHaveBeenCalledWith([
      appFavorite('assistants'),
      appFavorite('mini_app'),
      miniAppFavorite('weather'),
      miniAppFavorite('calculator')
    ])
    expect(mocks.reorderMiniAppsByStatus).not.toHaveBeenCalled()
  })

  it('interleaves mini apps and built-in apps when reordering', () => {
    configureMiniApps(['calculator'])
    render(<Sidebar />)

    act(() => getSidebarProps().onEntriesReorder?.({ oldIndex: 2, newIndex: 0 }))

    expect(mocks.setSidebarFavorites).toHaveBeenCalledWith([
      miniAppFavorite('calculator'),
      appFavorite('assistants'),
      appFavorite('mini_app')
    ])
  })

  it('omits mini apps unless they are sidebar favorites', () => {
    configureMiniApps([])
    render(<Sidebar />)

    expect(getSidebarProps().entries.some((entry) => entry.key === 'mini_app:calculator')).toBe(false)
  })

  it('drops stale mini app ids from resolved entries', () => {
    configureMiniApps(['calculator', 'stale'])
    render(<Sidebar />)

    expect(getSidebarProps().entries.map((entry) => entry.key)).toContain('mini_app:calculator')
    expect(getSidebarProps().entries.map((entry) => entry.key)).not.toContain('mini_app:stale')
  })

  it('omits hidden mini apps left in sidebar favorites', () => {
    configureMiniApps(['calculator'])
    mocks.visibleMiniApps = []
    render(<Sidebar />)

    expect(getSidebarProps().entries.some((entry) => entry.key === 'mini_app:calculator')).toBe(false)
  })

  it('reuses the active tab from a sidebar mini app entry', () => {
    configureMiniApps(['calculator'])
    mocks.activeTab = {
      id: 'chat',
      type: 'route',
      url: '/app/chat?topicId=t-1',
      title: 'Topic',
      icon: 'emoji:🍒',
      metadata: { keep: true }
    }
    render(<Sidebar />)

    act(() => getEntry('mini_app:calculator').onOpen())

    expect(mocks.updateTab).toHaveBeenCalledWith('chat', {
      url: '/app/mini-app/calculator',
      title: 'Calculator',
      icon: 'calculator-logo',
      metadata: undefined
    })
    expect(mocks.openTab).not.toHaveBeenCalled()
  })

  it('switches to an existing mini app tab without replacing the active tab', () => {
    configureMiniApps(['calculator'])
    mocks.activeTab = { id: 'chat', type: 'route', url: '/app/chat?topicId=t-1', title: 'Topic' }
    mocks.tabs = [
      mocks.activeTab,
      { id: 'calculator-tab', type: 'route', url: '/app/mini-app/calculator', title: 'Calculator' }
    ]
    render(<Sidebar />)

    act(() => getEntry('mini_app:calculator').onOpen())

    expect(mocks.setActiveTab).toHaveBeenCalledWith('calculator-tab')
    expect(mocks.updateTab).not.toHaveBeenCalled()
    expect(mocks.openTab).not.toHaveBeenCalled()
  })

  it('keeps the active mini app tab alive when opening another mini app', () => {
    configureMiniApps(['calculator', 'weather'], [calculatorMiniApp, weatherMiniApp])
    mocks.activeTab = {
      id: 'calculator-tab',
      type: 'route',
      url: '/app/mini-app/calculator',
      title: 'Calculator'
    }
    mocks.tabs = [mocks.activeTab]
    render(<Sidebar />)

    act(() => getEntry('mini_app:weather').onOpen())

    expect(mocks.openTab).toHaveBeenCalledWith('/app/mini-app/weather', {
      title: 'Weather',
      icon: 'weather-logo'
    })
    expect(mocks.updateTab).not.toHaveBeenCalled()
  })

  it('does nothing when the active tab is already on the target mini app route', () => {
    configureMiniApps(['calculator'])
    mocks.activeTab = {
      id: 'calculator-tab',
      type: 'route',
      url: '/app/mini-app/calculator',
      title: 'Calculator'
    }
    render(<Sidebar />)

    act(() => getEntry('mini_app:calculator').onOpen())

    expect(mocks.updateTab).not.toHaveBeenCalled()
    expect(mocks.openTab).not.toHaveBeenCalled()
  })

  it('opens a forced mini app tab when the active tab is pinned', () => {
    configureMiniApps(['calculator'])
    mocks.activeTab = { id: 'chat', type: 'route', url: '/app/chat', title: 'Chat', isPinned: true }
    render(<Sidebar />)

    act(() => getEntry('mini_app:calculator').onOpen())

    expect(mocks.openTab).toHaveBeenCalledWith('/app/mini-app/calculator', {
      forceNew: true,
      title: 'Calculator',
      icon: 'calculator-logo'
    })
    expect(mocks.updateTab).not.toHaveBeenCalled()
  })

  it('does nothing when the active tab is already on the target app route', () => {
    mocks.sidebarFavorites = [appFavorite('agents')]
    mocks.activeTab = { id: 'agents', type: 'route', url: '/app/agents', title: 'Work' }
    render(<Sidebar />)

    act(() => getEntry('app:agents').onOpen())

    expect(mocks.updateTab).not.toHaveBeenCalled()
    expect(mocks.openTab).not.toHaveBeenCalled()
    expect(mocks.emitResourceListReveal).not.toHaveBeenCalled()
  })

  it('reuses the active tab without revealing its resource list', () => {
    mocks.sidebarFavorites = [appFavorite('agents')]
    mocks.tabs = [{ id: 'agents-1', type: 'route', url: '/app/agents?sessionId=s-1', title: 'Session 1' }]
    render(<Sidebar />)

    act(() => getEntry('app:agents').onOpen())

    expect(mocks.updateTab).toHaveBeenCalledWith('chat', {
      url: '/app/agents',
      title: 'Work',
      icon: undefined,
      metadata: undefined
    })
    expect(mocks.emitResourceListReveal).not.toHaveBeenCalled()
    expect(mocks.setActiveTab).not.toHaveBeenCalled()
    expect(mocks.openTab).not.toHaveBeenCalled()
  })

  it('replaces the active tab with the bare app route', () => {
    mocks.sidebarFavorites = [appFavorite('agents')]
    mocks.activeTab = {
      id: 'chat',
      type: 'route',
      url: '/app/chat?topicId=topic-1',
      title: 'Chat',
      metadata: { keep: true }
    }
    render(<Sidebar />)

    act(() => getEntry('app:agents').onOpen())

    expect(mocks.updateTab).toHaveBeenCalledWith('chat', {
      url: '/app/agents',
      title: 'Work',
      icon: undefined,
      metadata: undefined
    })
    expect(mocks.setActiveTab).not.toHaveBeenCalled()
    expect(mocks.openTab).not.toHaveBeenCalled()
  })

  it('stays put when the active tab holds a conversation of the target app', () => {
    mocks.sidebarFavorites = [appFavorite('agents')]
    mocks.activeTab = {
      id: 'agents-1',
      type: 'route',
      url: '/app/agents?sessionId=session-1',
      title: 'Session 1'
    }
    render(<Sidebar />)

    act(() => getEntry('app:agents').onOpen())

    expect(mocks.updateTab).not.toHaveBeenCalled()
    expect(mocks.openTab).not.toHaveBeenCalled()
  })

  it('navigates a message-only viewer back to the app entry', () => {
    mocks.sidebarFavorites = [appFavorite('agents')]
    mocks.activeTab = {
      id: 'viewer',
      type: 'route',
      url: '/app/agents?sessionId=session-1&view=message',
      title: 'Session 1'
    }
    render(<Sidebar />)

    act(() => getEntry('app:agents').onOpen())

    expect(mocks.updateTab).toHaveBeenCalledWith('viewer', {
      url: '/app/agents',
      title: 'Work',
      icon: undefined,
      metadata: undefined
    })
  })

  it('clears route-specific metadata when reusing the active tab', () => {
    mocks.sidebarFavorites = [appFavorite('translate')]
    mocks.activeTab = {
      id: 'chat',
      type: 'route',
      url: '/app/chat?topicId=t-1',
      title: 'Topic',
      icon: 'emoji:🍒',
      metadata: { keep: true }
    }
    render(<Sidebar />)

    act(() => getEntry('app:translate').onOpen())

    expect(mocks.updateTab).toHaveBeenCalledWith('chat', {
      url: '/app/translate',
      title: 'Translate',
      icon: undefined,
      metadata: undefined
    })
    expect(mocks.openTab).not.toHaveBeenCalled()
    expect(mocks.emitResourceListReveal).not.toHaveBeenCalled()
  })

  it('reuses the active tab for single-policy routes', () => {
    mocks.sidebarFavorites = [appFavorite('translate')]
    render(<Sidebar />)

    act(() => getEntry('app:translate').onOpen())

    expect(mocks.updateTab).toHaveBeenCalledWith('chat', {
      url: '/app/translate',
      title: 'Translate',
      icon: undefined,
      metadata: undefined
    })
    expect(mocks.openTab).not.toHaveBeenCalled()
  })

  it('opens a forced tab when the active tab is pinned', () => {
    mocks.sidebarFavorites = [appFavorite('agents')]
    mocks.activeTab = { id: 'chat', type: 'route', url: '/app/chat', title: 'Chat', isPinned: true }
    render(<Sidebar />)

    act(() => getEntry('app:agents').onOpen())

    expect(mocks.openTab).toHaveBeenCalledWith('/app/agents', {
      forceNew: true,
      title: 'Work'
    })
    expect(mocks.emitResourceListReveal).not.toHaveBeenCalled()
    expect(mocks.updateTab).not.toHaveBeenCalled()
    expect(mocks.setActiveTab).not.toHaveBeenCalled()
  })

  it('opens a forced tab when there is no active tab', () => {
    mocks.sidebarFavorites = [appFavorite('files')]
    mocks.activeTab = null
    render(<Sidebar />)

    act(() => getEntry('app:files').onOpen())

    expect(mocks.openTab).toHaveBeenCalledWith('/app/files', { forceNew: true, title: 'Files' })
    expect(mocks.updateTab).not.toHaveBeenCalled()
    expect(mocks.setActiveTab).not.toHaveBeenCalled()
    expect(mocks.emitResourceListReveal).not.toHaveBeenCalled()
  })

  it('migrates a persisted intermediate sidebar width to icon width and converges', () => {
    mocks.sidebarWidth = 80

    const { rerender } = render(<Sidebar />)

    expect(mocks.sidebarWidth).toBe(50)
    expect(mocks.setSidebarWidth).toHaveBeenCalledTimes(1)

    rerender(<Sidebar />)

    expect(mocks.sidebarWidth).toBe(50)
    expect(mocks.setSidebarWidth).toHaveBeenCalledTimes(1)
  })

  it('uses resize preview width without persisting it', () => {
    render(<Sidebar />)

    expect(getSidebarProps().width).toBe(50)
    expect(document.documentElement.style.getPropertyValue('--sidebar-width')).toBe('50px')

    act(() => getSidebarProps().onResizePreview?.(80))

    expect(getSidebarProps().width).toBe(80)
    expect(document.documentElement.style.getPropertyValue('--sidebar-width')).toBe('80px')
    expect(mocks.sidebarWidth).toBe(50)
    expect(mocks.setSidebarWidth).not.toHaveBeenCalled()

    act(() => getSidebarProps().onResizePreview?.(null))

    expect(getSidebarProps().width).toBe(50)
    expect(document.documentElement.style.getPropertyValue('--sidebar-width')).toBe('50px')
  })

  it('opens app, mini app, agent, and assistant entries in new tabs', () => {
    mocks.sidebarFavorites = [appFavorite('assistants')]
    mocks.sidebarMiniAppFavorites = [miniAppFavorite('mini-1')]
    mocks.sidebarAgentFavorites = [agentFavorite('agent-1')]
    mocks.sidebarAssistantFavorites = [assistantFavorite('assistant-1')]
    mocks.allApps = [{ appId: 'mini-1', name: 'Mini One', logo: 'logo-1.png', url: 'https://example.com/1' }]
    mocks.agents = [{ id: 'agent-1', name: 'Code Reviewer' }]
    mocks.assistants = [{ id: 'assistant-1', name: 'Helper' }]
    render(<Sidebar />)

    act(() => getEntry('app:assistants').onOpenNewTab?.())
    expect(mocks.openTab).toHaveBeenLastCalledWith('/app/chat', { forceNew: true, title: 'Chat' })

    act(() => getEntry('mini_app:mini-1').onOpenNewTab?.())
    expect(mocks.openTab).toHaveBeenLastCalledWith('/app/mini-app/mini-1', {
      forceNew: true,
      title: 'Mini One',
      icon: 'logo-1.png'
    })

    act(() => getEntry('agent:agent-1').onOpenNewTab?.())
    expect(mocks.openTab).toHaveBeenLastCalledWith('/app/agents?agentId=agent-1', {
      forceNew: true,
      title: 'Code Reviewer'
    })

    act(() => getEntry('assistant:assistant-1').onOpenNewTab?.())
    expect(mocks.openTab).toHaveBeenLastCalledWith('/app/chat?assistantId=assistant-1', {
      forceNew: true,
      title: 'Helper'
    })
  })

  it('opens new tabs from entry context menu callbacks', () => {
    mocks.sidebarFavorites = [appFavorite('assistants')]
    mocks.sidebarAgentFavorites = [agentFavorite('agent-1')]
    mocks.sidebarAssistantFavorites = [assistantFavorite('assistant-1')]
    mocks.agents = [{ id: 'agent-1', name: 'Code Reviewer' }]
    mocks.assistants = [{ id: 'assistant-1', name: 'Helper' }]
    render(<Sidebar />)

    selectMenuItem(getEntry('app:assistants'), 'sidebar.open-in-new-tab.app:assistants')
    expect(mocks.openTab).toHaveBeenLastCalledWith('/app/chat', { forceNew: true, title: 'Chat' })

    selectMenuItem(getEntry('agent:agent-1'), 'sidebar.open-in-new-tab.agent:agent-1')
    expect(mocks.openTab).toHaveBeenLastCalledWith('/app/agents?agentId=agent-1', {
      forceNew: true,
      title: 'Code Reviewer'
    })

    selectMenuItem(getEntry('assistant:assistant-1'), 'sidebar.open-in-new-tab.assistant:assistant-1')
    expect(mocks.openTab).toHaveBeenLastCalledWith('/app/chat?assistantId=assistant-1', {
      forceNew: true,
      title: 'Helper'
    })
  })
})
