import { Tabs, TabsContent, TabsList, TabsTrigger } from '@cherrystudio/ui'
import { loggerService } from '@logger'
import { type AgentComposerSendOptions, AgentHomeComposer } from '@renderer/components/composer/variants/AgentComposer'
import { ChatPlacementComposer } from '@renderer/components/composer/variants/ChatComposer'
import { usePersistCache } from '@renderer/data/hooks/useCache'
import { useInvalidateCache, useQuery } from '@renderer/data/hooks/useDataApi'
import { useAgent } from '@renderer/hooks/agent/useAgent'
import { useAgentSessionsSource, useAssistantTopicsSource } from '@renderer/hooks/resourceViewSources'
import { useCloseConversationTabs, useCurrentTabId } from '@renderer/hooks/tab'
import { useAgentSessionParts } from '@renderer/hooks/useAgentSessionParts'
import { useAssistant, useAssistants } from '@renderer/hooks/useAssistant'
import { useModelById } from '@renderer/hooks/useModel'
import { useProviders } from '@renderer/hooks/useProvider'
import { useTopicMessages } from '@renderer/hooks/useTopicMessages'
import { useTopicMessagesCache } from '@renderer/hooks/useTopicMessagesCache'
import { ipcApi } from '@renderer/ipc'
import { getStreamBlockedMessage } from '@renderer/services/aiTransport'
import { toast } from '@renderer/services/toast'
import { buildAgentSessionTopicId } from '@renderer/utils/agentSession'
import { LAST_USED_ASSISTANT_CACHE_KEY, resolveDefaultAssistant } from '@renderer/utils/assistant'
import { formatErrorMessageWithPrefix } from '@renderer/utils/error'
import type { AiStreamOpenResponse } from '@shared/ai/transport'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'
import {
  AGENT_WORKSPACE_TYPE,
  type AgentSessionWorkspaceSource,
  type AgentWorkspaceEntity
} from '@shared/data/api/schemas/agentWorkspaces'
import { useNavigate } from '@tanstack/react-router'
import { Bot, MessageSquare } from 'lucide-react'
import { type ComponentProps, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('NewTaskPage')

type ChatSeed = ReturnType<typeof useTopicMessagesCache>['seedReservedMessages']
type AgentSeed = ReturnType<typeof useAgentSessionParts>['seedReservedMessages']

export default function NewTaskPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const currentTabId = useCurrentTabId()
  const invalidateCache = useInvalidateCache()
  const closeConversationTabs = useCloseConversationTabs()
  const { reuseOrCreateTopic } = useAssistantTopicsSource()
  const { reuseOrCreateSession } = useAgentSessionsSource()
  const ownerKey = currentTabId ?? 'standalone'
  const chatDraftScopeKey = `new-task:${ownerKey}:chat`
  const agentDraftScopeKey = `new-task:${ownerKey}:agent`
  const temporaryAgentSessionId = `${agentDraftScopeKey}:pending`

  const { assistants, hasLoaded, isLoading, isRefreshing } = useAssistants()
  const [lastUsedAssistantId, setLastUsedAssistantId] = usePersistCache(LAST_USED_ASSISTANT_CACHE_KEY)
  const defaultChatAssistantId = useMemo(
    () => resolveDefaultAssistant(assistants, { lastUsedAssistantId }).assistantId ?? null,
    [assistants, lastUsedAssistantId]
  )
  const isAssistantListResolved = hasLoaded && !isLoading && !isRefreshing
  const [chatAssistantId, setChatAssistantId] = useState<string | null>(() => defaultChatAssistantId)
  const chatContext = useAssistant(chatAssistantId, { loadDefaultModel: true })
  const { providers } = useProviders()
  const [agentId, setAgentId] = useState<string | null>(null)
  const { agent, isLoading: agentLoading } = useAgent(agentId)
  const { model: agentModel, isLoading: agentModelLoading } = useModelById(agent?.model)
  const [agentWorkspaceId, setAgentWorkspaceId] = useState<string | null>(null)
  const { data: agentWorkspaces = [] } = useQuery('/agent-workspaces')
  const selectedWorkspace = useMemo(
    () => agentWorkspaces.find((workspace) => workspace.id === agentWorkspaceId),
    [agentWorkspaceId, agentWorkspaces]
  )

  const [chatTopicId, setChatTopicId] = useState('')
  const chatMessages = useTopicMessages(chatTopicId, { enabled: !!chatTopicId, fetchOnMount: false })
  const { seedReservedMessages: seedChatMessages } = useTopicMessagesCache({
    topicId: chatTopicId,
    mutate: chatMessages.mutate
  })
  const [agentSessionId, setAgentSessionId] = useState('')
  const { seedReservedMessages: seedAgentMessages } = useAgentSessionParts(agentSessionId, {
    enabled: !!agentSessionId,
    fetchOnMount: false
  })

  const chatSeedRef = useRef<{ id: string; seed: ChatSeed }>({ id: '', seed: seedChatMessages })
  const agentSeedRef = useRef<{ id: string; seed: AgentSeed }>({ id: '', seed: seedAgentMessages })
  const chatSeedWaiterRef = useRef<((seed: ChatSeed) => void) | null>(null)
  const agentSeedWaiterRef = useRef<((seed: AgentSeed) => void) | null>(null)
  useEffect(() => {
    chatSeedRef.current = { id: chatTopicId, seed: seedChatMessages }
    chatSeedWaiterRef.current?.(seedChatMessages)
    chatSeedWaiterRef.current = null
  }, [chatTopicId, seedChatMessages])
  useEffect(() => {
    agentSeedRef.current = { id: agentSessionId, seed: seedAgentMessages }
    agentSeedWaiterRef.current?.(seedAgentMessages)
    agentSeedWaiterRef.current = null
  }, [agentSessionId, seedAgentMessages])

  const waitForChatSeed = useCallback((topicId: string) => {
    if (chatSeedRef.current.id === topicId) return Promise.resolve(chatSeedRef.current.seed)
    return new Promise<ChatSeed>((resolve) => {
      chatSeedWaiterRef.current = resolve
      setChatTopicId(topicId)
    })
  }, [])
  const waitForAgentSeed = useCallback((sessionId: string) => {
    if (agentSeedRef.current.id === sessionId) return Promise.resolve(agentSeedRef.current.seed)
    return new Promise<AgentSeed>((resolve) => {
      agentSeedWaiterRef.current = resolve
      setAgentSessionId(sessionId)
    })
  }, [])

  const chatInFlightRef = useRef(false)
  const agentInFlightRef = useRef(false)
  const chatEpochRef = useRef(0)
  const agentEpochRef = useRef(0)
  const chatSelectionInitializedRef = useRef(false)
  const chatPlaceholderRef = useRef<{ target: string; topicId: string } | null>(null)
  const agentPlaceholderRef = useRef<{ target: string; session: AgentSessionEntity } | null>(null)
  const pendingNavigationRef = useRef<{ type: 'chat'; id: string } | { type: 'agent'; id: string } | null>(null)

  useEffect(() => {
    if (!isAssistantListResolved || chatSelectionInitializedRef.current) return
    chatSelectionInitializedRef.current = true
    chatEpochRef.current += 1
    setChatAssistantId(defaultChatAssistantId)
  }, [defaultChatAssistantId, isAssistantListResolved])

  useEffect(
    () => () => {
      chatEpochRef.current += 1
      agentEpochRef.current += 1
    },
    []
  )

  const handleDraftCleared = useCallback(() => {
    const destination = pendingNavigationRef.current
    if (!destination) return
    pendingNavigationRef.current = null
    if (destination.type === 'chat') {
      void navigate({ to: '/app/chat', search: { topicId: destination.id }, replace: true })
      return
    }
    void navigate({ to: '/app/agents', search: { sessionId: destination.id }, replace: true })
  }, [navigate])

  const handleChatSend = useCallback(
    async (text: string, options?: Parameters<ComponentProps<typeof ChatPlacementComposer>['onSend']>[1]) => {
      if (chatInFlightRef.current) return false
      chatInFlightRef.current = true
      const epoch = chatEpochRef.current
      const isCurrent = () => chatEpochRef.current === epoch
      const target = chatAssistantId ?? ''
      try {
        let topicId = chatPlaceholderRef.current?.target === target ? chatPlaceholderRef.current.topicId : undefined
        if (!topicId) {
          const result = await reuseOrCreateTopic(chatAssistantId)
          if (!isCurrent()) return false
          topicId = result.topic.id
          chatPlaceholderRef.current = { target, topicId }
        }
        const ack = await ipcApi.request('ai.stream.open', {
          trigger: 'submit-message',
          topicId,
          mentionedModelIds: options?.mentionedModels,
          userMessageParts: options?.userMessageParts ?? [{ type: 'text', text }],
          targetMode: options?.chatTarget?.mode,
          reasoningEffort: options?.reasoningEffort,
          serviceTier: options?.serviceTier,
          ...(options?.fastMode ? { fastMode: true } : {})
        })
        if (!isCurrent()) return false
        if (ack.mode === 'blocked') {
          toast.error(getStreamBlockedMessage(ack))
          chatInFlightRef.current = false
          return false
        }
        pendingNavigationRef.current = { type: 'chat', id: topicId }
        try {
          const seed = await waitForChatSeed(topicId)
          await seed(ack.reservedMessages ?? [], { preserveActiveNode: ack.preserveActiveNode })
          await invalidateCache(['/topics', `/topics/${topicId}`])
        } catch (error) {
          logger.error('Failed to synchronize started chat task', error as Error)
        }
        return true
      } catch (error) {
        if (!isCurrent()) return false
        logger.error('Failed to start chat task', error as Error)
        toast.error(formatErrorMessageWithPrefix(error, t('common.error')))
        chatInFlightRef.current = false
        return false
      }
    },
    [chatAssistantId, invalidateCache, reuseOrCreateTopic, t, waitForChatSeed]
  )

  const workspaceSource = useMemo<AgentSessionWorkspaceSource>(
    () =>
      agentWorkspaceId
        ? { type: AGENT_WORKSPACE_TYPE.USER, workspaceId: agentWorkspaceId }
        : { type: AGENT_WORKSPACE_TYPE.SYSTEM },
    [agentWorkspaceId]
  )
  const workspaceTarget = agentWorkspaceId ?? AGENT_WORKSPACE_TYPE.SYSTEM
  const handleAgentSend = useCallback(
    async (_message?: { text: string }, options?: AgentComposerSendOptions) => {
      if (!agentId || !options?.body || agentInFlightRef.current) return false
      agentInFlightRef.current = true
      const epoch = agentEpochRef.current
      const isCurrent = () => agentEpochRef.current === epoch
      const target = `${agentId}:${workspaceTarget}`
      try {
        let session = agentPlaceholderRef.current?.target === target ? agentPlaceholderRef.current.session : undefined
        if (!session) {
          const result = await reuseOrCreateSession(agentId, workspaceSource)
          if (!isCurrent()) return false
          session = result.session
          agentPlaceholderRef.current = { target, session }
          closeConversationTabs('agents', result.deletedDuplicateSessionIds)
        }
        const ack: AiStreamOpenResponse = await ipcApi.request('ai.stream.open', {
          trigger: 'submit-message',
          topicId: buildAgentSessionTopicId(session.id),
          userMessageParts: options.body.userMessageParts,
          reasoningEffort: options.body.reasoningEffort,
          serviceTier: options.body.serviceTier,
          ...(options.body.fastMode ? { fastMode: true } : {})
        })
        if (!isCurrent()) return false
        if (ack.mode === 'blocked') {
          toast.error(getStreamBlockedMessage(ack))
          agentInFlightRef.current = false
          return false
        }
        pendingNavigationRef.current = { type: 'agent', id: session.id }
        try {
          const seed = await waitForAgentSeed(session.id)
          await seed(ack.reservedMessages ?? [])
          await invalidateCache(['/agent-sessions', `/agent-sessions/${session.id}`, '/agent-workspaces'])
        } catch (error) {
          logger.error('Failed to synchronize started agent task', error as Error)
        }
        return true
      } catch (error) {
        if (!isCurrent()) return false
        logger.error('Failed to start agent task', error as Error)
        toast.error(formatErrorMessageWithPrefix(error, t('agent.session.create.error.failed')))
        agentInFlightRef.current = false
        return false
      }
    },
    [
      agentId,
      closeConversationTabs,
      invalidateCache,
      reuseOrCreateSession,
      t,
      waitForAgentSeed,
      workspaceSource,
      workspaceTarget
    ]
  )

  const handleChatAssistantChange = useCallback(
    (nextAssistantId: string | null) => {
      if (chatInFlightRef.current) return
      chatEpochRef.current += 1
      chatPlaceholderRef.current = null
      pendingNavigationRef.current = null
      setChatAssistantId(nextAssistantId)
      setLastUsedAssistantId(nextAssistantId)
    },
    [setLastUsedAssistantId]
  )
  const handleAgentChange = useCallback((nextAgentId: string | null) => {
    if (agentInFlightRef.current) return
    agentEpochRef.current += 1
    agentPlaceholderRef.current = null
    pendingNavigationRef.current = null
    setAgentId(nextAgentId)
  }, [])
  const handleWorkspaceChange = useCallback((workspaceId: string | null) => {
    if (agentInFlightRef.current) return
    agentEpochRef.current += 1
    agentPlaceholderRef.current = null
    pendingNavigationRef.current = null
    setAgentWorkspaceId(workspaceId)
  }, [])
  const agentWorkspace = selectedWorkspace
    ? selectedWorkspace
    : ({ type: AGENT_WORKSPACE_TYPE.SYSTEM } satisfies Pick<AgentWorkspaceEntity, 'type'>)

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background">
      <header className="flex h-(--navbar-height) shrink-0 items-center border-border-subtle border-b px-5">
        <h1 className="font-medium text-sm">{t('workspace.newTask.title')}</h1>
      </header>
      <main className="flex min-h-[520px] flex-1 items-start justify-center px-6 pt-24 pb-12">
        <div className="w-full max-w-2xl">
          <div className="text-center">
            <h2 className="font-semibold text-2xl tracking-tight">{t('workspace.newTask.heading')}</h2>
          </div>
          <Tabs defaultValue="chat" className="mt-10 gap-4 [&_[data-ui~='part:composer-input']]:min-h-20!">
            <TabsList className="mx-auto flex w-fit rounded-lg bg-muted p-1">
              <TabsTrigger value="chat" className="flex h-8 items-center gap-2 rounded-md px-3 text-sm">
                <MessageSquare size={15} />
                {t('workspace.newTask.chat.title')}
              </TabsTrigger>
              <TabsTrigger value="agent" className="flex h-8 items-center gap-2 rounded-md px-3 text-sm">
                <Bot size={15} />
                {t('workspace.newTask.agent.title')}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="chat" forceMount className="data-[state=inactive]:hidden">
              <ChatPlacementComposer
                placement="home"
                scopeKey={chatDraftScopeKey}
                assistantId={chatAssistantId ?? undefined}
                resolvedContext={chatContext}
                resolvedProviders={providers}
                onDraftAssistantChange={handleChatAssistantChange}
                onSend={handleChatSend}
                onDraftCleared={handleDraftCleared}
              />
            </TabsContent>
            <TabsContent value="agent" forceMount className="data-[state=inactive]:hidden">
              <AgentHomeComposer
                agentId={agentId ?? ''}
                sessionId={temporaryAgentSessionId}
                draftScopeKey={agentDraftScopeKey}
                sessionOverride={{ workspace: agentWorkspace, workspaceId: agentWorkspaceId }}
                resolvedAgent={agent}
                resolvedModel={agentModel}
                resolvedWorkspaceWarning={null}
                sendMessage={handleAgentSend}
                stop={async () => undefined}
                onAgentChange={handleAgentChange}
                agentChanging={agentLoading}
                workspaceId={agentWorkspaceId}
                onWorkspaceChange={handleWorkspaceChange}
                isStreaming={false}
                sendDisabled={!agentId || agentModelLoading || !agentModel}
                onDraftCleared={handleDraftCleared}
              />
            </TabsContent>
          </Tabs>
        </div>
      </main>
    </div>
  )
}
