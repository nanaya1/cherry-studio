import { Alert, Button, Tabs, TabsContent, TabsList, TabsTrigger } from '@cherrystudio/ui'
import { loggerService } from '@logger'
import {
  type AgentComposerLaunchOptions,
  type AgentComposerSendOptions,
  AgentHomeComposer
} from '@renderer/components/composer/variants/AgentComposer'
import { agentSkillToComposerToken } from '@renderer/components/composer/variants/agentComposerTokens'
import { ChatPlacementComposer } from '@renderer/components/composer/variants/ChatComposer'
import { QuickPanelProvider, useQuickPanel } from '@renderer/components/QuickPanel'
import { usePersistCache } from '@renderer/data/hooks/useCache'
import { useInvalidateCache, useQuery } from '@renderer/data/hooks/useDataApi'
import { usePreference } from '@renderer/data/hooks/usePreference'
import { useAgent, useUpdateAgent } from '@renderer/hooks/agent/useAgent'
import { useAgentMutationsById, useSkillMutationsById } from '@renderer/hooks/resourceCatalog'
import { useAgentSessionsSource, useAssistantTopicsSource } from '@renderer/hooks/resourceViewSources'
import { useCloseConversationTabs, useCurrentTabId } from '@renderer/hooks/tab'
import { useAgentSessionParts } from '@renderer/hooks/useAgentSessionParts'
import { useAssistant, useAssistants } from '@renderer/hooks/useAssistant'
import { useModelById } from '@renderer/hooks/useModel'
import { useProviders } from '@renderer/hooks/useProvider'
import { useInstalledSkills } from '@renderer/hooks/useSkills'
import { useTopicMessages } from '@renderer/hooks/useTopicMessages'
import { useTopicMessagesCache } from '@renderer/hooks/useTopicMessagesCache'
import { ipcApi } from '@renderer/ipc'
import { getStreamBlockedMessage } from '@renderer/services/aiTransport'
import { toast } from '@renderer/services/toast'
import { buildAgentSessionTopicId } from '@renderer/utils/agentSession'
import { LAST_USED_ASSISTANT_CACHE_KEY, resolveDefaultAssistant } from '@renderer/utils/assistant'
import { formatErrorMessageWithPrefix } from '@renderer/utils/error'
import { BUILTIN_AGENT_ROLE } from '@shared/ai/builtinAgent'
import type { AiStreamOpenResponse } from '@shared/ai/transport'
import { AGENTS_MAX_LIMIT } from '@shared/data/api/schemas/agents'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'
import {
  AGENT_WORKSPACE_TYPE,
  type AgentSessionWorkspaceSource,
  type AgentWorkspaceEntity
} from '@shared/data/api/schemas/agentWorkspaces'
import { CHERRYAI_DEFAULT_UNIQUE_MODEL_ID } from '@shared/data/presets/cherryai'
import type { UniqueModelId } from '@shared/data/types/model'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Bot, MessageSquare } from 'lucide-react'
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('NewTaskPage')

type ChatSeed = ReturnType<typeof useTopicMessagesCache>['seedReservedMessages']
type AgentSeed = ReturnType<typeof useAgentSessionParts>['seedReservedMessages']
type TaskMode = 'chat' | 'agent'

function NewTaskQuickPanelFill({ children }: { children: ReactNode }) {
  const { setFillToAvailableHeight } = useQuickPanel()

  useLayoutEffect(() => {
    setFillToAvailableHeight(true)
    return () => setFillToAvailableHeight(false)
  }, [setFillToAvailableHeight])

  return children
}

export default function NewTaskPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const routeSearch = useSearch({ strict: false }) as { mode?: TaskMode; skillId?: string }
  const routeMode = routeSearch.mode ?? (routeSearch.skillId ? 'agent' : 'chat')
  const [taskMode, setTaskMode] = useState<TaskMode>(routeMode)
  const [consumedSkillId, setConsumedSkillId] = useState<string | null>(null)
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
  const {
    data: agentsData,
    isLoading: agentsLoading,
    isRefreshing: agentsRefreshing
  } = useQuery('/agents', { query: { limit: AGENTS_MAX_LIMIT } })
  const {
    data: installedSkills = [],
    isLoading: installedSkillsLoading,
    isRefreshing: installedSkillsRefreshing,
    error: installedSkillsError
  } = useQuery('/skills')
  const defaultAgentId = useMemo(
    () =>
      agentsData?.items.find((candidate) => candidate.configuration?.builtin_role === BUILTIN_AGENT_ROLE.ASSISTANT)
        ?.id ?? null,
    [agentsData]
  )
  const [agentId, setAgentId] = useState<string | null>(null)
  const { agent, isLoading: agentLoading } = useAgent(agentId)
  const { updateModel } = useUpdateAgent()
  const [defaultModelId] = usePreference('chat.default_model_id')
  const { model: agentModel, isLoading: agentModelLoading } = useModelById(agent?.model)
  const {
    skills: agentSkills,
    loading: agentSkillsLoading,
    refreshing: agentSkillsRefreshing,
    error: agentSkillsError,
    refresh: refreshAgentSkills
  } = useInstalledSkills(agentId ?? undefined, { enabled: Boolean(routeSearch.skillId && agentId) })
  const { updateAgent } = useAgentMutationsById(agentId ?? '')
  const { updateGlobalEnabled } = useSkillMutationsById(routeSearch.skillId ?? '')
  const [skillBindingPending, setSkillBindingPending] = useState(false)
  const [skillBindingError, setSkillBindingError] = useState(false)
  const skillBindingRequestRef = useRef(0)
  const [agentWorkspaceId, setAgentWorkspaceId] = useState<string | null>(null)
  const { data: agentWorkspaces = [] } = useQuery('/agent-workspaces')
  const selectedWorkspace = useMemo(
    () => agentWorkspaces.find((workspace) => workspace.id === agentWorkspaceId),
    [agentWorkspaceId, agentWorkspaces]
  )
  const launchSkillId = routeSearch.skillId
  const hasPendingSkillLaunch = Boolean(launchSkillId && consumedSkillId !== launchSkillId)
  const launchSkill = useMemo(
    () => installedSkills.find((candidate) => candidate.id === launchSkillId),
    [installedSkills, launchSkillId]
  )
  const isLaunchSkillUnavailable = Boolean(
    hasPendingSkillLaunch &&
      !installedSkillsLoading &&
      !installedSkillsRefreshing &&
      !installedSkillsError &&
      !launchSkill
  )
  const isSkillBindingLoading = Boolean(
    hasPendingSkillLaunch &&
      (installedSkillsLoading ||
        installedSkillsRefreshing ||
        (agentId && (agentLoading || agentSkillsLoading || agentSkillsRefreshing)))
  )
  const isSkillBound = Boolean(
    launchSkill?.isGlobalEnabled &&
      agentSkills.some((candidate) => candidate.id === launchSkill.id && candidate.isEnabled)
  )
  const requiresSkillBinding = Boolean(
    hasPendingSkillLaunch && launchSkill && agentId && (!isSkillBindingLoading || skillBindingPending) && !isSkillBound
  )
  const canUseLaunchSkill = Boolean(hasPendingSkillLaunch && launchSkill && agentId && isSkillBound)
  const resolvedLaunchSkillId = launchSkill?.id
  const launchSkillName = launchSkill?.name
  const launchSkillDescription = launchSkill?.description
  const launchSkillFolderName = launchSkill?.folderName
  const skillLaunchOptions = useMemo<AgentComposerLaunchOptions | undefined>(() => {
    if (!resolvedLaunchSkillId || !launchSkillName || !launchSkillFolderName || !hasPendingSkillLaunch) return undefined

    const token = agentSkillToComposerToken({
      name: launchSkillName,
      description: launchSkillDescription ?? undefined,
      filename: launchSkillFolderName
    })
    const initialText = token.promptText ?? `Use the ${launchSkillFolderName} skill.`
    return {
      initialDraft: {
        text: initialText,
        tokens: [{ ...token, index: 0, textOffset: 0 }]
      },
      onSent: () => setConsumedSkillId(resolvedLaunchSkillId)
    }
  }, [hasPendingSkillLaunch, launchSkillDescription, launchSkillFolderName, launchSkillName, resolvedLaunchSkillId])

  const handleBindLaunchSkill = useCallback(async () => {
    if (!launchSkill || !agentId || skillBindingPending) return

    const requestId = ++skillBindingRequestRef.current
    setSkillBindingError(false)
    setSkillBindingPending(true)
    try {
      if (!launchSkill.isGlobalEnabled) {
        await updateGlobalEnabled(true)
      }
      await updateAgent({ skillUpdates: [{ skillId: launchSkill.id, isEnabled: true }] })
      await refreshAgentSkills()
    } catch (error) {
      logger.error('Failed to bind launch skill to agent', {
        skillId: launchSkill.id,
        agentId,
        error: error instanceof Error ? error.message : String(error)
      })
      if (skillBindingRequestRef.current === requestId) setSkillBindingError(true)
    } finally {
      if (skillBindingRequestRef.current === requestId) setSkillBindingPending(false)
    }
  }, [agentId, launchSkill, refreshAgentSkills, skillBindingPending, updateAgent, updateGlobalEnabled])

  useEffect(() => {
    setTaskMode(routeMode)
  }, [routeMode])

  useEffect(() => {
    skillBindingRequestRef.current += 1
    setSkillBindingError(false)
    setSkillBindingPending(false)
  }, [agentId, launchSkillId])

  useEffect(() => {
    if (isSkillBound) setSkillBindingError(false)
  }, [isSkillBound])

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
  const agentSelectionInitializedRef = useRef(false)
  const chatPlaceholderRef = useRef<{ target: string; topicId: string } | null>(null)
  const agentPlaceholderRef = useRef<{ target: string; session: AgentSessionEntity } | null>(null)
  const pendingNavigationRef = useRef<{ type: 'chat'; id: string } | { type: 'agent'; id: string } | null>(null)

  useEffect(() => {
    if (!isAssistantListResolved || chatSelectionInitializedRef.current) return
    chatSelectionInitializedRef.current = true
    chatEpochRef.current += 1
    setChatAssistantId(defaultChatAssistantId)
  }, [defaultChatAssistantId, isAssistantListResolved])

  useEffect(() => {
    if (!agentsData || agentsLoading || agentsRefreshing || agentSelectionInitializedRef.current) return
    agentSelectionInitializedRef.current = true
    setAgentId(defaultAgentId)
  }, [agentsData, agentsLoading, agentsRefreshing, defaultAgentId])

  // The builtin craftsman agent is seeded with model: null (the managed CherryAI
  // default cannot drive the agent runtime), so a fresh install lands here with
  // no model. Persist the user's default model onto it — the same write path as
  // picking a model in the composer — so the first send works without a manual
  // model selection. Managed-CherryAI-only installs keep the explicit gap.
  const agentModelProvisionedRef = useRef<string | null>(null)
  useEffect(() => {
    if (agentId !== defaultAgentId || !agentId || agentsLoading) return
    if (agent?.model || agentLoading) return
    const fallbackModelId = (defaultModelId ?? null) as UniqueModelId | null
    if (!fallbackModelId || fallbackModelId === CHERRYAI_DEFAULT_UNIQUE_MODEL_ID) return
    agentModelProvisionedRef.current = agentId
    updateModel({ agentId, modelId: fallbackModelId }, { showSuccessToast: false }).catch(() => {
      if (agentModelProvisionedRef.current === agentId) agentModelProvisionedRef.current = null
    })
  }, [agent, agentId, agentLoading, agentsLoading, defaultAgentId, defaultModelId, updateModel])

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
    agentSelectionInitializedRef.current = true
    agentEpochRef.current += 1
    agentPlaceholderRef.current = null
    pendingNavigationRef.current = null
    skillBindingRequestRef.current += 1
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
      {/* <header className="flex h-(--navbar-height) shrink-0 items-center border-border-subtle border-b px-5">
        <h1 className="font-medium text-sm">{t('workspace.newTask.title')}</h1>
      </header> */}
      <main
        data-composer-dock-layer=""
        className="flex min-h-[520px] flex-1 items-start justify-center px-6 pt-35 pb-12">
        <div className="w-full max-w-2xl">
          <div className="text-center">
            <h2 className="font-semibold text-2xl tracking-tight">{t('workspace.newTask.heading')}</h2>
          </div>
          <Tabs
            value={taskMode}
            onValueChange={(value) => setTaskMode(value as TaskMode)}
            className="mt-5 gap-8 [&_[data-ui~='part:composer-input']]:min-h-20!">
            <TabsList className="mx-auto flex w-fit rounded-lg bg-muted p-1">
              <TabsTrigger value="chat" className="flex h-8 items-center gap-2 rounded-md px-4 text-sm">
                <MessageSquare size={15} />
                {t('workspace.newTask.chat.title')}
              </TabsTrigger>
              <TabsTrigger value="agent" className="flex h-8 items-center gap-2 rounded-md px-4 text-sm">
                <Bot size={15} />
                {t('workspace.newTask.agent.title')}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="chat" forceMount className="mt-4 data-[state=inactive]:hidden">
              <QuickPanelProvider>
                <NewTaskQuickPanelFill>
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
                </NewTaskQuickPanelFill>
              </QuickPanelProvider>
            </TabsContent>
            <TabsContent value="agent" forceMount className="data-[state=inactive]:hidden">
              {hasPendingSkillLaunch && !agentId && !agentsLoading && !agentsRefreshing && (
                <Alert
                  type="info"
                  showIcon
                  message={t('workspace.newTask.skill.selectAgent')}
                  className="mb-3 shadow-none"
                />
              )}
              {isLaunchSkillUnavailable && (
                <Alert
                  type="error"
                  showIcon
                  message={t('workspace.newTask.skill.unavailable')}
                  className="mb-3 shadow-none"
                />
              )}
              {hasPendingSkillLaunch && (installedSkillsError || agentSkillsError || skillBindingError) && (
                <Alert
                  type="error"
                  showIcon
                  message={t('workspace.newTask.skill.bindFailed')}
                  className="mb-3 shadow-none"
                  action={
                    launchSkill && agentId ? (
                      <Button
                        size="sm"
                        variant="outline"
                        loading={skillBindingPending}
                        onClick={() => void handleBindLaunchSkill()}>
                        {t('workspace.newTask.skill.bindAction')}
                      </Button>
                    ) : undefined
                  }
                />
              )}
              {requiresSkillBinding && !installedSkillsError && !agentSkillsError && !skillBindingError && (
                <Alert
                  type="warning"
                  showIcon
                  message={t('workspace.newTask.skill.notBound', {
                    skill: launchSkill?.name,
                    agent: agent?.name ?? ''
                  })}
                  className="mb-3 shadow-none"
                  action={
                    <Button
                      size="sm"
                      variant="outline"
                      loading={skillBindingPending}
                      onClick={() => void handleBindLaunchSkill()}>
                      {t('workspace.newTask.skill.bindAction')}
                    </Button>
                  }
                />
              )}
              <QuickPanelProvider>
                <NewTaskQuickPanelFill>
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
                    sendDisabled={
                      !agentId ||
                      agentModelLoading ||
                      !agentModel ||
                      (hasPendingSkillLaunch &&
                        (isSkillBindingLoading || requiresSkillBinding || isLaunchSkillUnavailable || !canUseLaunchSkill))
                    }
                    launchOptions={canUseLaunchSkill ? skillLaunchOptions : undefined}
                    onDraftCleared={handleDraftCleared}
                  />
                </NewTaskQuickPanelFill>
              </QuickPanelProvider>
            </TabsContent>
          </Tabs>
        </div>
      </main>
    </div>
  )
}
