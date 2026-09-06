// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { QuickPanelProvider, useQuickPanel } from '@renderer/components/QuickPanel'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type SkillFixture = {
  id: string
  name: string
  description: string
  folderName: string
  isGlobalEnabled: boolean
  isEnabled: boolean
}

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  reuseOrCreateTopic: vi.fn(),
  reuseOrCreateSession: vi.fn(),
  streamOpen: vi.fn(),
  seedChatMessages: vi.fn(),
  seedAgentMessages: vi.fn(),
  invalidateCache: vi.fn(),
  closeConversationTabs: vi.fn(),
  toastError: vi.fn(),
  assistants: [{ id: 'assistant-1' }, { id: 'assistant-2' }],
  agents: [
    { id: 'agent-1', name: 'Custom agent', configuration: {} },
    { id: 'craftsman-agent', name: 'User-renamed builtin', configuration: { builtin_role: 'assistant' } }
  ],
  lastUsedAssistantId: 'assistant-2' as string | null,
  setLastUsedAssistantId: vi.fn(),
  routeSearch: {} as { mode?: 'chat' | 'agent'; skillId?: string },
  globalSkills: [] as SkillFixture[],
  agentSkillsByAgent: {} as Record<string, SkillFixture[]>,
  updateAgent: vi.fn(),
  updateGlobalEnabled: vi.fn(),
  refreshAgentSkills: vi.fn(),
  renderQuickPanelHarness: false,
  chatProps: undefined as Record<string, unknown> | undefined,
  agentProps: undefined as Record<string, unknown> | undefined
}))

vi.mock('@cherrystudio/ui', async () => {
  const React = await import('react')
  return {
    Alert: ({ action, message }: { action?: ReactNode; message?: ReactNode }) =>
      React.createElement('div', { role: 'alert' }, message, action),
    Button: ({
      children,
      loading,
      size,
      variant,
      ...props
    }: ComponentProps<'button'> & { loading?: boolean; size?: string; variant?: string }) => {
      void loading
      void size
      void variant
      return React.createElement('button', props, children)
    },
    Tabs: ({ children, onValueChange }: { children: ReactNode; onValueChange?: () => void }) => {
      void onValueChange
      return React.createElement('div', null, children)
    },
    TabsContent: ({ children }: { children: ReactNode }) => React.createElement('div', null, children),
    TabsList: ({ children }: { children: ReactNode }) => React.createElement('div', null, children),
    TabsTrigger: ({ children }: { children: ReactNode }) => React.createElement('button', null, children)
  }
})

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ error: vi.fn() })
  }
}))

vi.mock('@renderer/assets/images/logo.png', () => ({ default: 'logo.png' }))

vi.mock('@renderer/components/composer/variants/ChatComposer', async () => {
  const React = await import('react')
  const { useQuickPanel } = await import('@renderer/components/QuickPanel')

  return {
    ChatPlacementComposer: (props: Record<string, unknown>) => {
      mocks.chatProps = props
      if (!mocks.renderQuickPanelHarness) return React.createElement('div', { 'aria-label': 'chat-composer' })

      const ChatQuickPanelHarness = () => {
        const quickPanel = useQuickPanel()
        return React.createElement(
          React.Fragment,
          null,
          React.createElement('output', { 'aria-label': 'quick-panel-visible' }, String(quickPanel.isVisible)),
          React.createElement(
            'button',
            {
              onClick: () =>
                quickPanel.open({
                  list: [],
                  symbol: '/',
                  queryAnchor: 0,
                  trackInputQuery: true,
                  triggerInfo: { type: 'input', position: 0, originalText: '/' }
                })
            },
            'Type slash'
          )
        )
      }

      return React.createElement(ChatQuickPanelHarness)
    }
  }
})

vi.mock('@renderer/components/composer/variants/AgentComposer', async () => {
  const React = await import('react')
  const { useQuickPanel } = await import('@renderer/components/QuickPanel')

  return {
    AgentHomeComposer: (props: Record<string, unknown>) => {
      mocks.agentProps = props

      const AgentQuickPanelHarness = () => {
        const quickPanel = useQuickPanel()
        React.useEffect(() => {
          if (quickPanel.isVisible && quickPanel.triggerInfo?.type === 'input') {
            quickPanel.close('input_trigger_removed')
          }
        }, [quickPanel])

        return React.createElement(
          'div',
          { 'aria-label': 'agent-composer' },
          React.createElement(
            'button',
            { onClick: () => (props.onAgentChange as (id: string) => void)('agent-1') },
            'Select agent'
          )
        )
      }

      if (mocks.renderQuickPanelHarness) return React.createElement(AgentQuickPanelHarness)
      return React.createElement(
        'div',
        { 'aria-label': 'agent-composer' },
        React.createElement(
          'button',
          { onClick: () => (props.onAgentChange as (id: string) => void)('agent-1') },
          'Select agent'
        )
      )
    }
  }
})

vi.mock('@renderer/data/hooks/useCache', () => ({
  usePersistCache: () => [mocks.lastUsedAssistantId, mocks.setLastUsedAssistantId]
}))

vi.mock('@renderer/data/hooks/useDataApi', () => ({
  useInvalidateCache: () => mocks.invalidateCache,
  useQuery: (path: string) => ({
    data: path === '/agents' ? { items: mocks.agents } : path === '/skills' ? mocks.globalSkills : [],
    isLoading: false,
    isRefreshing: false,
    error: undefined
  })
}))

vi.mock('@renderer/hooks/agent/useAgent', () => ({
  useAgent: (id: string | null) => ({
    agent: id ? { ...mocks.agents.find((agent) => agent.id === id), id, model: 'provider:model' } : undefined,
    isLoading: false
  })
}))

vi.mock('@renderer/hooks/resourceCatalog', () => ({
  useAgentMutationsById: () => ({ updateAgent: mocks.updateAgent }),
  useSkillMutationsById: () => ({ updateGlobalEnabled: mocks.updateGlobalEnabled })
}))

vi.mock('@renderer/hooks/resourceViewSources', () => ({
  useAssistantTopicsSource: () => ({ reuseOrCreateTopic: mocks.reuseOrCreateTopic }),
  useAgentSessionsSource: () => ({ reuseOrCreateSession: mocks.reuseOrCreateSession })
}))

vi.mock('@renderer/hooks/tab', () => ({
  useCurrentTabId: () => 'tab-1',
  useCloseConversationTabs: () => mocks.closeConversationTabs
}))

vi.mock('@renderer/hooks/useAgentSessionParts', () => ({
  useAgentSessionParts: () => ({ seedReservedMessages: mocks.seedAgentMessages })
}))

vi.mock('@renderer/hooks/useAssistant', () => ({
  useAssistant: () => ({ assistant: undefined, model: undefined }),
  useAssistants: () => ({
    assistants: mocks.assistants,
    hasLoaded: true,
    isLoading: false,
    isRefreshing: false
  })
}))

vi.mock('@renderer/hooks/useModel', () => ({
  useModelById: () => ({ model: { id: 'model' }, isLoading: false })
}))

vi.mock('@renderer/hooks/useProvider', () => ({
  useProviders: () => ({ providers: [] })
}))

vi.mock('@renderer/hooks/useSkills', () => ({
  useInstalledSkills: (agentId?: string) => ({
    skills: agentId ? (mocks.agentSkillsByAgent[agentId] ?? []) : [],
    loading: false,
    refreshing: false,
    error: null,
    refresh: mocks.refreshAgentSkills
  })
}))

vi.mock('@renderer/hooks/useTopicMessages', () => ({
  useTopicMessages: () => ({ mutate: vi.fn() })
}))

vi.mock('@renderer/ipc', () => ({
  ipcApi: {
    request: (...args: unknown[]) => mocks.streamOpen(...args)
  }
}))

vi.mock('@renderer/hooks/useTopicMessagesCache', () => ({
  useTopicMessagesCache: () => ({ seedReservedMessages: mocks.seedChatMessages })
}))

vi.mock('@renderer/services/aiTransport', () => ({
  getStreamBlockedMessage: () => 'Blocked'
}))

vi.mock('@renderer/services/toast', () => ({
  toast: { error: mocks.toastError }
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useSearch: () => mocks.routeSearch
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

import NewTaskPage from './NewTaskPage'

type ChatOnSend = (text: string, options?: Record<string, unknown>) => Promise<boolean>
type AgentOnSend = (message?: { text: string }, options?: Record<string, unknown>) => Promise<boolean>

const getChatOnSend = () => mocks.chatProps?.onSend as ChatOnSend
const getChatOnDraftCleared = () => mocks.chatProps?.onDraftCleared as () => void
const getChatOnAssistantChange = () => mocks.chatProps?.onDraftAssistantChange as (id: string | null) => void
const getAgentOnSend = () => mocks.agentProps?.sendMessage as AgentOnSend
const getAgentOnDraftCleared = () => mocks.agentProps?.onDraftCleared as () => void
const getAgentOnChange = () => mocks.agentProps?.onAgentChange as (id: string | null) => void
const getAgentOnWorkspaceChange = () => mocks.agentProps?.onWorkspaceChange as (id: string | null) => void

async function selectAgent() {
  await userEvent.click(screen.getByRole('button', { name: 'Select agent' }))
  expect(mocks.agentProps?.agentId).toBe('agent-1')
}

beforeEach(() => {
  mocks.assistants = [{ id: 'assistant-1' }, { id: 'assistant-2' }]
  mocks.agents = [
    { id: 'agent-1', name: 'Custom agent', configuration: {} },
    { id: 'craftsman-agent', name: 'User-renamed builtin', configuration: { builtin_role: 'assistant' } }
  ]
  mocks.lastUsedAssistantId = 'assistant-2'
  mocks.renderQuickPanelHarness = false
  mocks.routeSearch = {}
  mocks.globalSkills = []
  mocks.agentSkillsByAgent = {}
  mocks.updateAgent.mockResolvedValue({})
  mocks.updateGlobalEnabled.mockResolvedValue({})
  mocks.refreshAgentSkills.mockResolvedValue(undefined)
  mocks.reuseOrCreateTopic.mockResolvedValue({ topic: { id: 'topic-1' } })
  mocks.reuseOrCreateSession.mockResolvedValue({
    session: { id: 'session-1' },
    deletedDuplicateSessionIds: []
  })
  mocks.streamOpen.mockResolvedValue({ mode: 'started', reservedMessages: [] })
  mocks.seedChatMessages.mockResolvedValue(undefined)
  mocks.seedAgentMessages.mockResolvedValue(undefined)
  mocks.invalidateCache.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mocks.chatProps = undefined
  mocks.agentProps = undefined
})

describe('NewTaskPage', () => {
  it('keeps the chat slash panel open while the inactive agent composer is mounted', async () => {
    mocks.renderQuickPanelHarness = true
    const user = userEvent.setup()

    render(
      <QuickPanelProvider>
        <NewTaskPage />
      </QuickPanelProvider>
    )

    await user.click(screen.getByRole('button', { name: 'Type slash' }))

    await waitFor(() => expect(screen.getByLabelText('quick-panel-visible')).toHaveTextContent('true'))
  })

  it('uses the shared default assistant priority for new chat tasks', () => {
    render(<NewTaskPage />)

    expect(mocks.chatProps?.assistantId).toBe('assistant-2')
  })

  it('selects the builtin craftsman agent by role for new agent tasks', async () => {
    render(<NewTaskPage />)

    await waitFor(() => expect(mocks.agentProps?.agentId).toBe('craftsman-agent'))
    expect(mocks.agentProps?.sendDisabled).toBe(false)
  })

  it('keeps the same agent composer visible before and after selecting an agent', async () => {
    render(<NewTaskPage />)

    const composer = screen.getByLabelText('agent-composer')
    expect(mocks.chatProps?.scopeKey).toBe('new-task:tab-1:chat')
    expect(mocks.agentProps?.draftScopeKey).toBe('new-task:tab-1:agent')
    await waitFor(() => expect(mocks.agentProps?.agentId).toBe('craftsman-agent'))

    await selectAgent()

    expect(screen.getByLabelText('agent-composer')).toBe(composer)
    expect(mocks.agentProps?.draftScopeKey).toBe('new-task:tab-1:agent')
    expect(mocks.agentProps?.sendDisabled).toBe(false)
    expect(screen.getByLabelText('chat-composer')).toBeInTheDocument()
  })

  it('restores global enablement and binds an unbound launch skill before injecting it', async () => {
    const skill = {
      id: 'skill-1',
      name: 'Review Helper',
      description: 'Review changes',
      folderName: 'review-helper',
      isGlobalEnabled: false,
      isEnabled: false
    }
    mocks.routeSearch = { mode: 'agent', skillId: skill.id }
    mocks.globalSkills = [skill]
    mocks.updateGlobalEnabled.mockImplementation(async () => {
      skill.isGlobalEnabled = true
      return skill
    })
    mocks.updateAgent.mockImplementation(async () => {
      mocks.agentSkillsByAgent['craftsman-agent'] = [{ ...skill, isEnabled: true }]
      return {}
    })
    render(<NewTaskPage />)

    await waitFor(() => expect(mocks.agentProps?.agentId).toBe('craftsman-agent'))
    expect(mocks.agentProps?.sendDisabled).toBe(true)
    expect(mocks.agentProps?.launchOptions).toBeUndefined()

    await userEvent.click(screen.getByRole('button', { name: 'workspace.newTask.skill.bindAction' }))

    await waitFor(() => expect(mocks.agentProps?.sendDisabled).toBe(false))
    expect(mocks.updateGlobalEnabled).toHaveBeenCalledWith(true)
    expect(mocks.updateAgent).toHaveBeenCalledWith({ skillUpdates: [{ skillId: 'skill-1', isEnabled: true }] })
    expect(mocks.updateGlobalEnabled.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateAgent.mock.invocationCallOrder[0]
    )
    expect(mocks.agentProps?.launchOptions).toBeDefined()
  })

  it('rechecks the launch skill when the user switches agents', async () => {
    const skill = {
      id: 'skill-1',
      name: 'Review Helper',
      description: 'Review changes',
      folderName: 'review-helper',
      isGlobalEnabled: true,
      isEnabled: true
    }
    mocks.routeSearch = { mode: 'agent', skillId: skill.id }
    mocks.globalSkills = [skill]
    mocks.agentSkillsByAgent['craftsman-agent'] = [skill]
    render(<NewTaskPage />)

    await waitFor(() => expect(mocks.agentProps?.launchOptions).toBeDefined())
    await selectAgent()

    expect(mocks.agentProps?.sendDisabled).toBe(true)
    expect(mocks.agentProps?.launchOptions).toBeUndefined()
    expect(screen.getByRole('button', { name: 'workspace.newTask.skill.bindAction' })).toBeInTheDocument()
  })

  it('keeps an unavailable launch skill out of the composer', async () => {
    mocks.routeSearch = { mode: 'agent', skillId: 'missing-skill' }
    render(<NewTaskPage />)

    await waitFor(() => expect(mocks.agentProps?.agentId).toBe('craftsman-agent'))
    expect(screen.getByText('workspace.newTask.skill.unavailable')).toBeInTheDocument()
    expect(mocks.agentProps?.sendDisabled).toBe(true)
    expect(mocks.agentProps?.launchOptions).toBeUndefined()
  })

  it('replaces the current tab only after the chat composer clears a successful send', async () => {
    render(<NewTaskPage />)

    const send = getChatOnSend()('hello')

    await waitFor(() => expect(mocks.seedChatMessages).toHaveBeenCalledWith([], { preserveActiveNode: undefined }))
    await expect(send).resolves.toBe(true)
    expect(mocks.streamOpen).toHaveBeenCalledWith('ai.stream.open', {
      trigger: 'submit-message',
      topicId: 'topic-1',
      mentionedModelIds: undefined,
      userMessageParts: [{ type: 'text', text: 'hello' }],
      targetMode: undefined,
      reasoningEffort: undefined,
      serviceTier: undefined
    })
    expect(mocks.navigate).not.toHaveBeenCalled()

    getChatOnDraftCleared()()

    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/app/chat',
      search: { topicId: 'topic-1' },
      replace: true
    })
  })

  it('replaces the current tab only after the agent composer clears a successful send', async () => {
    render(<NewTaskPage />)
    await selectAgent()

    const send = getAgentOnSend()(undefined, {
      body: { userMessageParts: [{ type: 'text', text: 'hello' }] }
    })

    await waitFor(() => expect(mocks.seedAgentMessages).toHaveBeenCalledWith([]))
    await expect(send).resolves.toBe(true)
    expect(mocks.streamOpen).toHaveBeenCalledWith('ai.stream.open', {
      trigger: 'submit-message',
      topicId: 'agent-session:session-1',
      userMessageParts: [{ type: 'text', text: 'hello' }],
      reasoningEffort: undefined,
      serviceTier: undefined
    })
    expect(mocks.navigate).not.toHaveBeenCalled()

    getAgentOnDraftCleared()()

    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/app/agents',
      search: { sessionId: 'session-1' },
      replace: true
    })
  })

  it('finishes a started chat send without reopening the stream when local synchronization fails', async () => {
    mocks.seedChatMessages.mockRejectedValueOnce(new Error('seed failed'))
    render(<NewTaskPage />)

    const first = getChatOnSend()('first')
    await waitFor(() => expect(mocks.seedChatMessages).toHaveBeenCalled())
    await expect(first).resolves.toBe(true)
    await expect(getChatOnSend()('second')).resolves.toBe(false)

    expect(mocks.streamOpen).toHaveBeenCalledTimes(1)
    getChatOnDraftCleared()()
    getChatOnDraftCleared()()
    expect(mocks.navigate).toHaveBeenCalledTimes(1)
  })

  it('finishes a started agent send without reopening the stream when local synchronization fails', async () => {
    mocks.invalidateCache.mockRejectedValueOnce(new Error('invalidate failed'))
    render(<NewTaskPage />)
    await selectAgent()
    const options = { body: { userMessageParts: [{ type: 'text', text: 'hello' }] } }

    const first = getAgentOnSend()(undefined, options)
    await waitFor(() => expect(mocks.seedAgentMessages).toHaveBeenCalled())
    await expect(first).resolves.toBe(true)
    await expect(getAgentOnSend()(undefined, options)).resolves.toBe(false)

    expect(mocks.streamOpen).toHaveBeenCalledTimes(1)
    getAgentOnDraftCleared()()
    getAgentOnDraftCleared()()
    expect(mocks.navigate).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['topic creation fails', () => mocks.reuseOrCreateTopic.mockRejectedValueOnce(new Error('create failed'))],
    ['stream opening fails', () => mocks.streamOpen.mockRejectedValueOnce(new Error('open failed'))],
    ['stream opening is blocked', () => mocks.streamOpen.mockResolvedValueOnce({ mode: 'blocked', message: 'blocked' })]
  ])('keeps the chat draft when %s', async (_name, arrange) => {
    arrange()
    render(<NewTaskPage />)

    await expect(getChatOnSend()('hello')).resolves.toBe(false)

    expect(mocks.seedChatMessages).not.toHaveBeenCalled()
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it.each([
    ['session creation fails', () => mocks.reuseOrCreateSession.mockRejectedValueOnce(new Error('create failed'))],
    ['stream opening fails', () => mocks.streamOpen.mockRejectedValueOnce(new Error('open failed'))],
    ['stream opening is blocked', () => mocks.streamOpen.mockResolvedValueOnce({ mode: 'blocked', message: 'blocked' })]
  ])('keeps the agent draft when %s', async (_name, arrange) => {
    arrange()
    render(<NewTaskPage />)
    await selectAgent()

    await expect(
      getAgentOnSend()(undefined, { body: { userMessageParts: [{ type: 'text', text: 'hello' }] } })
    ).resolves.toBe(false)

    expect(mocks.seedAgentMessages).not.toHaveBeenCalled()
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('prevents duplicate chat creation and stream opening while the first send is pending', async () => {
    let resolveCreation: ((value: { topic: { id: string } }) => void) | undefined
    mocks.reuseOrCreateTopic.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreation = resolve
      })
    )
    render(<NewTaskPage />)

    const first = getChatOnSend()('first')
    const second = getChatOnSend()('second')

    await expect(second).resolves.toBe(false)
    expect(mocks.reuseOrCreateTopic).toHaveBeenCalledTimes(1)

    await act(async () => resolveCreation?.({ topic: { id: 'topic-1' } }))
    await expect(first).resolves.toBe(true)
    expect(mocks.streamOpen).toHaveBeenCalledTimes(1)
  })

  it('ignores assistant changes after chat acknowledgement while seed synchronization is pending', async () => {
    let resolveSeed: (() => void) | undefined
    mocks.seedChatMessages.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveSeed = resolve
      })
    )
    render(<NewTaskPage />)

    const send = getChatOnSend()('hello')
    await waitFor(() => expect(mocks.seedChatMessages).toHaveBeenCalled())
    act(() => getChatOnAssistantChange()('assistant-1'))

    expect(mocks.chatProps?.assistantId).toBe('assistant-2')
    expect(mocks.setLastUsedAssistantId).not.toHaveBeenCalled()

    await act(async () => resolveSeed?.())
    await expect(send).resolves.toBe(true)
    getChatOnDraftCleared()()
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/app/chat',
      search: { topicId: 'topic-1' },
      replace: true
    })
  })

  it('abandons a pending chat send when the page unmounts', async () => {
    let resolveCreation: ((value: { topic: { id: string } }) => void) | undefined
    mocks.reuseOrCreateTopic.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreation = resolve
      })
    )
    const view = render(<NewTaskPage />)

    const send = getChatOnSend()('hello')
    view.unmount()
    await act(async () => resolveCreation?.({ topic: { id: 'stale-topic' } }))

    await expect(send).resolves.toBe(false)
    expect(mocks.streamOpen).not.toHaveBeenCalled()
    expect(mocks.seedChatMessages).not.toHaveBeenCalled()
  })

  it('reuses the created chat topic when stream opening fails and the user retries', async () => {
    mocks.streamOpen.mockRejectedValueOnce(new Error('open failed'))
    render(<NewTaskPage />)

    await expect(getChatOnSend()('first')).resolves.toBe(false)
    const retry = getChatOnSend()('second')
    await waitFor(() => expect(mocks.seedChatMessages).toHaveBeenCalled())
    await expect(retry).resolves.toBe(true)

    expect(mocks.reuseOrCreateTopic).toHaveBeenCalledTimes(1)
    expect(mocks.streamOpen).toHaveBeenCalledTimes(2)
  })

  it('prevents duplicate agent creation and stream opening while the first send is pending', async () => {
    let resolveCreation:
      | ((value: { session: { id: string }; deletedDuplicateSessionIds: string[] }) => void)
      | undefined
    mocks.reuseOrCreateSession.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreation = resolve
      })
    )
    render(<NewTaskPage />)
    await selectAgent()
    const options = { body: { userMessageParts: [{ type: 'text', text: 'hello' }] } }

    const first = getAgentOnSend()(undefined, options)
    const second = getAgentOnSend()(undefined, options)

    await expect(second).resolves.toBe(false)
    expect(mocks.reuseOrCreateSession).toHaveBeenCalledTimes(1)

    await act(async () => resolveCreation?.({ session: { id: 'session-1' }, deletedDuplicateSessionIds: [] }))
    await expect(first).resolves.toBe(true)
    expect(mocks.streamOpen).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['agent', () => getAgentOnChange()('agent-2')],
    ['workspace', () => getAgentOnWorkspaceChange()('workspace-1')]
  ])(
    'ignores %s changes after agent acknowledgement while seed synchronization is pending',
    async (_target, changeTarget) => {
      let resolveSeed: (() => void) | undefined
      mocks.seedAgentMessages.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          resolveSeed = resolve
        })
      )
      render(<NewTaskPage />)
      await selectAgent()

      const send = getAgentOnSend()(undefined, {
        body: { userMessageParts: [{ type: 'text', text: 'hello' }] }
      })
      await waitFor(() => expect(mocks.seedAgentMessages).toHaveBeenCalled())
      act(changeTarget)

      expect(mocks.agentProps?.agentId).toBe('agent-1')
      expect(mocks.agentProps?.workspaceId).toBeNull()

      await act(async () => resolveSeed?.())
      await expect(send).resolves.toBe(true)
      getAgentOnDraftCleared()()
      expect(mocks.navigate).toHaveBeenCalledWith({
        to: '/app/agents',
        search: { sessionId: 'session-1' },
        replace: true
      })
    }
  )

  it('reuses the created agent session after an open failure', async () => {
    render(<NewTaskPage />)
    await selectAgent()
    const options = { body: { userMessageParts: [{ type: 'text', text: 'hello' }] } }
    mocks.streamOpen.mockRejectedValueOnce(new Error('open failed'))

    await expect(getAgentOnSend()(undefined, options)).resolves.toBe(false)
    const retry = getAgentOnSend()(undefined, options)
    await waitFor(() => expect(mocks.seedAgentMessages).toHaveBeenCalled())
    await expect(retry).resolves.toBe(true)

    expect(mocks.reuseOrCreateSession).toHaveBeenCalledTimes(1)
    expect(mocks.streamOpen).toHaveBeenCalledTimes(2)
  })
})
