import { MockUseDataApiUtils } from '@test-mocks/renderer/useDataApi'
import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import type * as MotionReact from 'motion/react'
import type { ComponentProps, PropsWithChildren, ReactNode } from 'react'
import type * as ReactI18next from 'react-i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ChatPrimitives from '@renderer/components/chat/primitives'
import { useActiveSession } from '@renderer/hooks/agent/useSession'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'

import AgentChat from '../AgentChat'
import { useAgentFilePreviewActive } from '../components/AgentRightPane'

vi.mock('../components/AgentRightPane', async (original) => ({
  ...(await original<typeof import('../components/AgentRightPane')>()),
  useAgentFilePreviewActive: vi.fn(() => false)
}))
import { useAgentConversationBootstrap } from '../useAgentConversationBootstrap'

vi.mock('@cherrystudio/ui', async (importOriginal) => ({
  ...(await importOriginal()),
  Badge: ({ children }: PropsWithChildren) => <span>{children}</span>,
  Button: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  HoverCard: ({ children }: PropsWithChildren) => <div>{children}</div>,
  HoverCardContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
  HoverCardTrigger: ({ children }: PropsWithChildren) => <>{children}</>,
  Tabs: ({ children }: PropsWithChildren) => <div>{children}</div>,
  TabsContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
  TabsList: ({ children }: PropsWithChildren) => <div>{children}</div>,
  TabsTrigger: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  Tooltip: ({ children }: PropsWithChildren) => children
}))

vi.mock('@renderer/components/chat/shell/ChatAppShell', () => ({
  ChatAppShell: ({
    pane,
    paneOpen,
    panePosition,
    topBar,
    sidePanel,
    main,
    centerContent,
    bottomComposer,
    overlay,
    centerOverlay
  }: {
    pane?: ReactNode
    paneOpen?: boolean
    panePosition?: string
    topBar?: ReactNode
    sidePanel?: ReactNode
    main?: ReactNode
    centerContent?: ReactNode
    bottomComposer?: ReactNode
    overlay?: ReactNode
    centerOverlay?: ReactNode
  }) => (
    <div data-testid="chat-app-shell" data-pane-open={String(Boolean(paneOpen))} data-pane-position={panePosition}>
      <div>{topBar}</div>
      <div>{pane}</div>
      <div>{sidePanel}</div>
      <div>{centerContent ?? main}</div>
      <div>{bottomComposer}</div>
      <div>{centerOverlay}</div>
      <div>{overlay}</div>
    </div>
  )
}))

vi.mock('@renderer/components/chat/shell/ConversationShell', () => ({
  default: ({
    pane,
    paneOpen,
    panePosition,
    topBar,
    topRightTool,
    sidePanel,
    center,
    overlay,
    centerOverlay,
    rightPane
  }: {
    pane?: ReactNode
    paneOpen?: boolean
    panePosition?: string
    topBar?: ReactNode
    topRightTool?: ReactNode
    sidePanel?: ReactNode
    center?: ReactNode
    overlay?: ReactNode
    centerOverlay?: ReactNode
    rightPane?: ReactNode
  }) => (
    <div data-testid="chat-app-shell" data-pane-open={String(Boolean(paneOpen))} data-pane-position={panePosition}>
      <div>{topBar}</div>
      <div>{topRightTool}</div>
      <div>{pane}</div>
      <div>{sidePanel}</div>
      <div>{center}</div>
      <div>{centerOverlay}</div>
      <div>{overlay}</div>
      {rightPane}
    </div>
  )
}))

vi.mock('@renderer/components/chat/shell/ConversationCenterState', () => ({
  default: ({ state }: { state: string }) => <div data-testid="conversation-center-state" data-state={state} />
}))

vi.mock('@renderer/components/chat/primitives', async (importActual) => ({
  ...(await importActual<typeof ChatPrimitives>()),
  EmptyState: ({ title, description }: { title?: string; description?: string }) => (
    <div>
      {title}
      {description}
    </div>
  ),
  LoadingState: () => <div />
}))

vi.mock('@renderer/components/chat/shell/RightPaneHost', () => ({
  RightPaneHost: ({ children, open }: PropsWithChildren<{ open?: boolean }>) => (
    <section data-testid="agent-right-pane" data-open={String(Boolean(open))}>
      {open ? children : null}
    </section>
  ),
  PersistentRightPaneHost: ({ children, open }: PropsWithChildren<{ open?: boolean }>) => (
    <section data-testid="agent-right-pane" data-open={String(Boolean(open))}>
      {children}
    </section>
  )
}))

vi.mock('@renderer/components/chat/panes/ArtifactPane', () => ({
  ARTIFACT_PANE_WIDTH: 460,
  normalizeArtifactPaneFilePath: (workspacePath: string, rawPath: string) =>
    rawPath.startsWith(`${workspacePath}/`) ? rawPath.slice(workspacePath.length + 1) : rawPath,
  resolveArtifactPaneFileSelection: (workspacePath: string | undefined, rawPath: string) =>
    workspacePath ? { workspacePath, filePath: rawPath.replace(`${workspacePath}/`, '') } : null,
  ArtifactPaneView: () => <div />,
  default: () => <div />
}))

vi.mock('@renderer/components/composer/ComposerContext', () => ({
  ComposerContextProvider: ({ children }: PropsWithChildren) => <>{children}</>
}))

vi.mock('@renderer/components/composer/ComposerCore', () => ({
  default: ({ fallback }: { fallback: ReactNode }) => <>{fallback}</>
}))

vi.mock('@renderer/components/composer/useToolApprovalComposerOverrides', () => ({
  useToolApprovalComposerOverrides: () => []
}))

vi.mock('@renderer/components/composer/ComposerDockTransitionFrame', () => ({
  default: ({ main, composer }: { main: ReactNode; composer: ReactNode }) => (
    <div>
      {main}
      {composer}
    </div>
  )
}))

vi.mock('@renderer/components/composer/variants/AgentComposer', () => ({
  // default: () => <div />,
  default: () => <textarea aria-label="任务消息输入" />,
  AgentHomeComposer: () => <div />,
  MissingAgentHomeComposer: () => <div />
}))

vi.mock('@renderer/components/QuickPanel', () => ({
  QuickPanelProvider: ({ children }: PropsWithChildren) => <>{children}</>
}))

vi.mock('motion/react', async (importOriginal) => ({
  ...(await importOriginal<typeof MotionReact>()),
  AnimatePresence: ({ children }: PropsWithChildren) => <>{children}</>,
  useReducedMotion: () => false
}))

vi.mock('@renderer/components/NavbarIcon', () => ({
  default: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => (
    <button type="button" {...props}>
      {children}
    </button>
  )
}))

vi.mock('@renderer/data/hooks/useCache', async () => {
  const { MockUseCache } = await import('@test-mocks/renderer/useCache')

  return {
    ...MockUseCache,
    useCache: () => [false],
    useSharedCache: () => [null, vi.fn()],
    useSharedCacheValue: () => undefined,
    usePersistCache: () => [undefined, vi.fn()]
  }
})

vi.mock('@renderer/data/hooks/usePreference', () => ({
  usePreference: (key: string) => [key === 'chat.narrow_mode' ? false : 'none', vi.fn()]
}))

vi.mock('@renderer/hooks/agent/useAgent', () => ({
  useAgent: () => ({
    agent: { id: 'agent-1', model: 'provider::model-1' },
    isLoading: false
  }),
  useAgents: () => ({
    agents: [{ id: 'agent-1', model: 'provider::model-1' }],
    isLoading: false
  }),
  useUpdateAgent: () => ({ updateModel: vi.fn() })
}))

vi.mock('@renderer/hooks/useModel', () => ({
  useModelById: (modelId?: string | null) => ({
    model: modelId ? { id: modelId, name: 'Model 1' } : undefined,
    isLoading: false
  })
}))

vi.mock('@renderer/hooks/agent/useAgentWorkspaceWarning', () => ({
  useAgentWorkspaceWarning: () => undefined
}))

const activeSessionMocks = vi.hoisted(() => ({
  result: {
    activeSessionId: 'session-1',
    session: { id: 'session-1', agentId: 'agent-1', workspace: { path: '/tmp/workspace' } },
    isLoading: false,
    setActiveSessionId: vi.fn()
  } as {
    activeSessionId: string | null
    session: { id: string; agentId: string | null; workspace: { path: string } | null } | undefined
    isLoading: boolean
    setActiveSessionId: ReturnType<typeof vi.fn<(...args: any[]) => any>>
  }
}))

const agentSessionPartsMocks = vi.hoisted(() => ({
  loadOlder: vi.fn(),
  locateAgentMessageInList: vi.fn(),
  result: {
    messages: [] as any[],
    isLoading: false,
    hasOlder: false,
    loadOlder: vi.fn(),
    refresh: vi.fn(),
    deleteMessage: vi.fn()
  }
}))

// vi.mock('@renderer/data/hooks/useDataApi', () => ({
//   useInvalidateCache: () => vi.fn()
// }))

// vi.mock('@renderer/hooks/agent/useSession', () => ({
//   useActiveSession: () => activeSessionMocks.result,
//   useUpdateSession: () => ({ updateSession: vi.fn() })
// }))
// MEA:industrial-video 使用真实 session 解析，避免 mock 掩盖详情入口过滤。
vi.mock('../../industrialVideo/IndustrialVideoTaskPanel', () => ({
  default: () => null
}))

vi.mock('@renderer/hooks/useAgentSessionParts', () => ({
  useAgentSessionParts: () => agentSessionPartsMocks.result
}))

vi.mock('@renderer/hooks/useChatWithHistory', () => ({
  useChatWithHistory: () => ({
    activeExecutions: [],
    sendMessage: vi.fn(),
    stop: vi.fn(),
    setMessages: vi.fn()
  })
}))

vi.mock('@renderer/hooks/useExecutionOverlay', () => ({
  useExecutionOverlay: () => ({
    overlay: {},
    liveAssistants: [],
    disposeOverlay: vi.fn(),
    reset: vi.fn()
  })
}))

vi.mock('@renderer/hooks/useTopicStreamStatus', () => ({
  useTopicStreamStatus: () => ({ isPending: false }),
  useTopicOverlayHandoffOnTerminal: () => {}
}))

vi.mock('@renderer/utils/agentSession', () => ({
  buildAgentFileWorkspaceKey: (workspaceId?: string | null, workspacePath?: string) =>
    `${workspaceId ?? ''}\0${workspacePath ?? ''}`,
  buildAgentSessionTopicId: (sessionId: string) => `agent-session:${sessionId}`
}))

// vi.mock('@renderer/components/chat/messages/agentMessageListAdapter', () => ({
vi.mock('../messages/agentMessageListAdapter', () => ({
  locateAgentMessageInList: (...args: unknown[]) => agentSessionPartsMocks.locateAgentMessageInList(...args)
}))

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactI18next>()),
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('../components/AgentChatNavbar', () => ({
  AgentChatNavbar: ({ tools }: { tools?: ReactNode }) => <div data-testid="agent-chat-navbar">{tools}</div>
}))

vi.mock('../components/AgentSessionMessages', () => ({
  // default: ({ sessionId }: { sessionId: string }) => <div data-testid="agent-messages" data-session-id={sessionId} />,
  default: ({ sessionId, messages }: { sessionId: string; messages: Array<{ id: string }> }) => (
    <section aria-label="任务消息" data-testid="agent-messages" data-session-id={sessionId}>
      {messages.map((message) => (
        <article key={message.id}>{message.id}</article>
      ))}
    </section>
  )
}))

vi.mock('@renderer/components/chat/citations/CitationsPanel', () => ({
  default: ({ open }: { open: boolean }) => <div data-testid="citations-panel" data-open={String(open)} />
}))

describe('AgentChat locate pending message', () => {
  const createConversationBootstrap = (
    session: ComponentProps<typeof AgentChat>['conversationBootstrap']['session'] = activeSessionMocks.result
      .session as ComponentProps<typeof AgentChat>['conversationBootstrap']['session'],
    sessionLoading = activeSessionMocks.result.isLoading,
    sessionSource: ComponentProps<typeof AgentChat>['conversationBootstrap']['sessionSource'] = session
      ? 'query'
      : 'none'
  ): ComponentProps<typeof AgentChat>['conversationBootstrap'] => ({
    session,
    sessionLoading,
    sessionSource,
    resources: {
      agent: session?.agentId ? ({ id: session.agentId, model: 'provider::model-1' } as any) : undefined,
      agentLoading: false,
      model: session?.agentId ? ({ id: 'provider::model-1', name: 'Model 1' } as any) : undefined,
      modelLoading: false
    }
  })
  const activeSessionProps = (): Pick<ComponentProps<typeof AgentChat>, 'conversationBootstrap'> => ({
    conversationBootstrap: createConversationBootstrap()
  })

  beforeEach(() => {
    activeSessionMocks.result = {
      activeSessionId: 'session-1',
      session: { id: 'session-1', agentId: 'agent-1', workspace: { path: '/tmp/workspace' } },
      isLoading: false,
      setActiveSessionId: vi.fn()
    }
    agentSessionPartsMocks.loadOlder = vi.fn()
    agentSessionPartsMocks.locateAgentMessageInList = vi.fn()
    agentSessionPartsMocks.result = {
      messages: [],
      isLoading: false,
      hasOlder: false,
      loadOlder: agentSessionPartsMocks.loadOlder,
      refresh: vi.fn(),
      deleteMessage: vi.fn()
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ai: {
          toolApproval: {
            respond: vi.fn()
          }
        },
        file: {
          getMetadata: vi.fn().mockResolvedValue({ kind: 'file', size: 1024 })
        },
        // Replacing `window.api` wholesale drops the setup's IpcApi bridge, which `useIpcOn`
        // subscribers in the tree call on mount.
        ipcApi: {
          request: vi.fn().mockResolvedValue(undefined),
          on: vi.fn(() => () => {})
        }
      }
    })
  })

  // 最小复现：按视频 sessionId 打开详情；修复前 session 被过滤，消息区和 composer 同时消失。
  it('工业视频 session 按精确 ID 加载后保留普通消息区和 composer', () => {
    const video: AgentSessionEntity = {
      id: 'video-session-1',
      agentId: 'agent-1',
      featureKind: 'industrial-video',
      name: '工业视频任务',
      workspaceId: 'workspace-video',
      workspace: {
        id: 'workspace-video',
        name: '视频工作区',
        path: '/tmp/video-workspace',
        type: 'system',
        orderKey: 'a0',
        createdAt: '2026-11-06T00:00:00Z',
        updatedAt: '2026-11-06T00:00:00Z'
      },
      orderKey: 'a0',
      isNameManuallyEdited: false,
      lastActivityAt: '2026-11-06T00:00:00Z',
      createdAt: '2026-11-06T00:00:00Z',
      updatedAt: '2026-11-06T00:00:00Z'
    }
    MockUseDataApiUtils.mockQueryResult('/agent-sessions/:sessionId', { data: video, isLoading: false })
    agentSessionPartsMocks.result.messages = [{ id: 'video-request', role: 'user', parts: [] }]

    function VideoSessionDetail() {
      const { session, isLoading, sessionSource } = useActiveSession({
        activeSessionId: video.id,
        setActiveSessionId: activeSessionMocks.result.setActiveSessionId
      })
      const bootstrap = useAgentConversationBootstrap({
        session: session ?? null,
        sessionLoading: isLoading,
        sessionSource
      })
      return <AgentChat conversationBootstrap={bootstrap} />
    }

    render(<VideoSessionDetail />)

    expect(screen.getByRole('region', { name: '任务消息' })).toHaveAttribute('data-session-id', video.id)
    expect(screen.getByText('video-request')).toBeVisible()
    expect(screen.getByRole('textbox', { name: '任务消息输入' })).toBeVisible()
    expect(screen.queryByRole('region', { name: '工业视频修改' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('conversation-center-state')).not.toBeInTheDocument()
  })

  it('keeps pending locate requests while session history is still loading', () => {
    const onLocateMessageHandled = vi.fn()
    agentSessionPartsMocks.result = {
      ...agentSessionPartsMocks.result,
      messages: [{ id: 'session-message-old', role: 'user', parts: [] }],
      isLoading: true,
      hasOlder: true,
      loadOlder: agentSessionPartsMocks.loadOlder
    }

    render(
      <AgentChat
        {...activeSessionProps()}
        pane={<aside data-testid="session-pane" />}
        paneOpen={true}
        panePosition="left"
        locateMessageId="session-message-target"
        onLocateMessageHandled={onLocateMessageHandled}
      />
    )

    expect(agentSessionPartsMocks.loadOlder).not.toHaveBeenCalled()
    expect(agentSessionPartsMocks.locateAgentMessageInList).not.toHaveBeenCalled()
    expect(onLocateMessageHandled).not.toHaveBeenCalled()
  })

  it('renders the navbar and loading center while the active session is resolving', () => {
    render(
      <AgentChat conversationBootstrap={createConversationBootstrap(null, true, 'pending')} showResourceListControls />
    )

    expect(screen.getByTestId('agent-chat-navbar')).toBeInTheDocument()
    expect(screen.getByTestId('conversation-center-state')).toHaveAttribute('data-state', 'loading')
  })

  it('loads older session history for pending locate and clears it only after the target appears', async () => {
    const onLocateMessageHandled = vi.fn()
    agentSessionPartsMocks.result = {
      ...agentSessionPartsMocks.result,
      messages: [{ id: 'session-message-old', role: 'user', parts: [] }],
      isLoading: false,
      hasOlder: true,
      loadOlder: agentSessionPartsMocks.loadOlder
    }

    const { rerender } = render(
      <AgentChat
        {...activeSessionProps()}
        pane={<aside data-testid="session-pane" />}
        paneOpen={true}
        panePosition="left"
        locateMessageId="session-message-target"
        onLocateMessageHandled={onLocateMessageHandled}
      />
    )

    await waitFor(() => expect(agentSessionPartsMocks.loadOlder).toHaveBeenCalledTimes(1))
    expect(onLocateMessageHandled).not.toHaveBeenCalled()

    agentSessionPartsMocks.result = {
      ...agentSessionPartsMocks.result,
      messages: [
        { id: 'session-message-old', role: 'user', parts: [] },
        { id: 'session-message-target', role: 'assistant', parts: [] }
      ],
      isLoading: false,
      hasOlder: false,
      loadOlder: agentSessionPartsMocks.loadOlder
    }
    rerender(
      <AgentChat
        {...activeSessionProps()}
        pane={<aside data-testid="session-pane" />}
        paneOpen={true}
        panePosition="left"
        locateMessageId="session-message-target"
        onLocateMessageHandled={onLocateMessageHandled}
      />
    )

    await waitFor(() => {
      expect(agentSessionPartsMocks.locateAgentMessageInList).toHaveBeenCalledWith(
        'agent-session:session-1',
        'session-message-target',
        true
      )
      expect(onLocateMessageHandled).toHaveBeenCalledTimes(1)
    })
  })

  it('opens the classic-layout resource pane when a locate reveal request arrives on the same session branch', async () => {
    const resourcePane = { node: <div data-testid="session-resource-list">Sessions</div>, label: 'title.work' }
    const baseProps = {
      ...activeSessionProps(),
      pane: <aside data-testid="session-pane" />,
      paneOpen: true,
      panePosition: 'left' as const,
      resourcePane,
      sessionPaneOpen: false,
      onSessionPaneOpenChange: vi.fn()
    }

    const { rerender } = render(<AgentChat {...baseProps} />)

    expect(screen.getByTestId('agent-right-pane')).toHaveAttribute('data-open', 'false')

    rerender(
      <AgentChat
        {...baseProps}
        resourcePaneRevealRequest={{ itemId: 'session-2', requestId: 1, clearFilters: true, clearQuery: true }}
      />
    )

    await waitFor(() => expect(screen.getByTestId('agent-right-pane')).toHaveAttribute('data-open', 'true'))
    expect(screen.getByTestId('session-resource-list')).toBeInTheDocument()
  })

  it('seeds the classic-layout resource pane open on the first frame when the session pane is persisted open', () => {
    const resourcePane = { node: <div data-testid="session-resource-list">Sessions</div>, label: 'title.work' }

    render(
      <AgentChat
        {...activeSessionProps()}
        pane={<aside data-testid="session-pane" />}
        paneOpen={true}
        panePosition="left"
        resourcePane={resourcePane}
        sessionPaneOpen={true}
        onSessionPaneOpenChange={vi.fn()}
      />
    )

    // No reveal request: the stable AgentChat shell seeds `open` directly from sessionPaneOpen.
    expect(screen.getByTestId('agent-right-pane')).toHaveAttribute('data-open', 'true')
  })

  it('keeps the classic-layout resource pane open across missing-agent selection → persistent session handoff', async () => {
    const resourcePane = { node: <div data-testid="session-resource-list">Sessions</div>, label: 'title.work' }

    const { rerender } = render(
      <AgentChat
        conversationBootstrap={createConversationBootstrap(null, false, 'none')}
        missingAgentSelection={true}
        pane={<aside data-testid="session-pane" />}
        paneOpen={true}
        panePosition="left"
        resourcePane={resourcePane}
        sessionPaneOpen={true}
        onSessionPaneOpenChange={vi.fn()}
      />
    )

    // The stable shell is seeded once and survives the capability readiness handoff.
    const rightPane = screen.getByTestId('agent-right-pane')
    expect(rightPane).toHaveAttribute('data-open', 'true')

    // Hand off to the persisted session without replacing the Shell/Viewport owner.
    rerender(
      <AgentChat
        {...activeSessionProps()}
        pane={<aside data-testid="session-pane" />}
        paneOpen={true}
        panePosition="left"
        resourcePane={resourcePane}
        sessionPaneOpen={true}
        onSessionPaneOpenChange={vi.fn()}
      />
    )

    await waitFor(() => expect(screen.getByTestId('agent-right-pane')).toHaveAttribute('data-open', 'true'))
    expect(screen.getByTestId('agent-right-pane')).toBe(rightPane)
  })

  it('工业视频任务详情顶部用成片预览开关替换原资源面板工具栏', async () => {
    const user = userEvent.setup()
    const video: AgentSessionEntity = {
      id: 'video-session-toggle',
      agentId: 'agent-1',
      featureKind: 'industrial-video',
      name: '工业视频任务',
      workspaceId: 'workspace-video',
      workspace: {
        id: 'workspace-video',
        name: '视频工作区',
        path: '/tmp/video-workspace',
        type: 'system',
        orderKey: 'a0',
        createdAt: '2026-11-06T00:00:00Z',
        updatedAt: '2026-11-06T00:00:00Z'
      },
      orderKey: 'a0',
      isNameManuallyEdited: false,
      lastActivityAt: '2026-11-06T00:00:00Z',
      createdAt: '2026-11-06T00:00:00Z',
      updatedAt: '2026-11-06T00:00:00Z'
    }
    MockUseDataApiUtils.mockQueryResult('/agent-sessions/:sessionId', { data: video, isLoading: false })
    const view = render(
      <AgentChat conversationBootstrap={createConversationBootstrap(video)} showResourceListControls />
    )
    const toggle = screen.getByRole('button', { name: 'industrial_video.preview.toggle' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.queryByRole('button', { name: 'agent.right_pane.tabs.files' })).not.toBeInTheDocument()
    vi.mocked(useAgentFilePreviewActive).mockReturnValue(true)
    view.rerender(<AgentChat conversationBootstrap={createConversationBootstrap(video)} showResourceListControls />)
    expect(screen.queryByRole('button', { name: 'industrial_video.preview.toggle' })).not.toBeInTheDocument()
    vi.mocked(useAgentFilePreviewActive).mockReturnValue(false)
    view.rerender(<AgentChat conversationBootstrap={createConversationBootstrap(video)} showResourceListControls />)
    expect(screen.getByRole('button', { name: 'industrial_video.preview.toggle' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  })

  it('普通会话顶部保留原资源面板工具栏（不被成片预览开关替换）', () => {
    render(<AgentChat {...activeSessionProps()} showResourceListControls />)
    expect(screen.queryByRole('button', { name: 'industrial_video.preview.toggle' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'agent.right_pane.tabs.files' })).toBeInTheDocument()
  })
})
