// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  lastUsedAssistantId: 'assistant-2' as string | null,
  setLastUsedAssistantId: vi.fn(),
  chatProps: undefined as Record<string, unknown> | undefined,
  agentProps: undefined as Record<string, unknown> | undefined,
  missingAgentProps: undefined as Record<string, unknown> | undefined
}))

vi.mock('@cherrystudio/ui', async () => {
  const React = await import('react')
  return {
    Tabs: ({ children }: { children: ReactNode }) => React.createElement('div', null, children),
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
  return {
    ChatPlacementComposer: (props: Record<string, unknown>) => {
      mocks.chatProps = props
      return React.createElement('div', { 'aria-label': 'chat-composer' })
    }
  }
})

vi.mock('@renderer/components/composer/variants/AgentComposer', async () => {
  const React = await import('react')
  return {
    AgentHomeComposer: (props: Record<string, unknown>) => {
      mocks.agentProps = props
      return React.createElement('div', { 'aria-label': 'agent-composer' })
    },
    MissingAgentHomeComposer: (props: Record<string, unknown>) => {
      mocks.missingAgentProps = props
      return React.createElement(
        'button',
        { onClick: () => (props.onAgentChange as (id: string) => void)('agent-1') },
        'Select agent'
      )
    }
  }
})

vi.mock('@renderer/data/hooks/useCache', () => ({
  usePersistCache: () => [mocks.lastUsedAssistantId, mocks.setLastUsedAssistantId]
}))

vi.mock('@renderer/data/hooks/useDataApi', () => ({
  useInvalidateCache: () => mocks.invalidateCache,
  useQuery: () => ({ data: [] })
}))

vi.mock('@renderer/hooks/agent/useAgent', () => ({
  useAgent: (id: string | null) => ({
    agent: id ? { id, model: 'provider:model' } : undefined,
    isLoading: false
  })
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
  useNavigate: () => mocks.navigate
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
  expect(screen.getByLabelText('agent-composer')).toBeInTheDocument()
}

beforeEach(() => {
  mocks.assistants = [{ id: 'assistant-1' }, { id: 'assistant-2' }]
  mocks.lastUsedAssistantId = 'assistant-2'
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
  mocks.missingAgentProps = undefined
})

describe('NewTaskPage', () => {
  it('uses the shared default assistant priority for new chat tasks', () => {
    render(<NewTaskPage />)

    expect(mocks.chatProps?.assistantId).toBe('assistant-2')
  })

  it('keeps chat and agent drafts in separate tab-scoped composers', async () => {
    render(<NewTaskPage />)

    expect(mocks.chatProps?.scopeKey).toBe('new-task:tab-1:chat')
    expect(mocks.missingAgentProps?.draftScopeKey).toBe('new-task:tab-1:agent')

    await selectAgent()

    expect(mocks.agentProps?.draftScopeKey).toBe('new-task:tab-1:agent')
    expect(screen.getByLabelText('chat-composer')).toBeInTheDocument()
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

  it('abandons a pending chat send when the assistant changes', async () => {
    let resolveCreation: ((value: { topic: { id: string } }) => void) | undefined
    mocks.reuseOrCreateTopic.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreation = resolve
      })
    )
    render(<NewTaskPage />)

    const send = getChatOnSend()('hello')
    act(() => getChatOnAssistantChange()('assistant-1'))
    await act(async () => resolveCreation?.({ topic: { id: 'stale-topic' } }))

    await expect(send).resolves.toBe(false)
    expect(mocks.streamOpen).not.toHaveBeenCalled()
    expect(mocks.seedChatMessages).not.toHaveBeenCalled()
    getChatOnDraftCleared()()
    expect(mocks.navigate).not.toHaveBeenCalled()
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
  ])('abandons a pending agent send when the %s changes', async (_target, changeTarget) => {
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

    const send = getAgentOnSend()(undefined, {
      body: { userMessageParts: [{ type: 'text', text: 'hello' }] }
    })
    act(changeTarget)
    await act(async () => resolveCreation?.({ session: { id: 'stale-session' }, deletedDuplicateSessionIds: [] }))

    await expect(send).resolves.toBe(false)
    expect(mocks.streamOpen).not.toHaveBeenCalled()
    expect(mocks.seedAgentMessages).not.toHaveBeenCalled()
    getAgentOnDraftCleared()()
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

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
