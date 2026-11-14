import { memo, useEffect, useMemo } from 'react'

import { loggerService } from '@logger'
import MessageList from '@renderer/components/chat/messages/MessageList'
import { MessageListProvider } from '@renderer/components/chat/messages/MessageListProvider'
import { AskUserQuestionOptimisticInputProvider } from '@renderer/components/chat/messages/tools/agent'
import type {
  MessageListActions,
  MessageListSelectAllPagination,
  MessageStreamingLayers
} from '@renderer/components/chat/messages/types'
import { usePreference } from '@renderer/data/hooks/usePreference'
import { useSession } from '@renderer/hooks/agent/useSession'
import { useTopicStreamStatus } from '@renderer/hooks/useTopicStreamStatus'
import { ipcApi } from '@renderer/ipc'
import type { GetAgentResponse } from '@renderer/types/agent'
import { type Topic, TopicType } from '@renderer/types/topic'
import { getAgentAvatarFromConfiguration } from '@renderer/utils/agent'
import { buildAgentSessionTopicId } from '@renderer/utils/agentSession'
import type { CherryMessagePart, CherryUIMessage } from '@shared/data/types/message'

import IndustrialVideoGenerateButton from '../../industrialVideo/IndustrialVideoGenerateButton'
import { IndustrialVideoMessageReview } from '../../industrialVideo/IndustrialVideoTaskPanel'
import { useAgentMessageListProviderValue } from '../messages/agentMessageListAdapter'
import AgentSessionBackgroundTasks from '../messages/AgentSessionBackgroundTasks'

const logger = loggerService.withContext('AgentSessionMessages')

type Props = {
  agentId?: string
  sessionId: string
  messages: CherryUIMessage[]
  activeAgent?: GetAgentResponse
  partsByMessageId: Record<string, CherryMessagePart[]>
  streamingLayers?: MessageStreamingLayers
  optimisticAskUserQuestionInputsByToolCallId?: Record<string, unknown>
  isLoading: boolean
  /** Whether more older messages remain on the server (cursor pagination). */
  hasOlder?: boolean
  /** Trigger fetching the next older page. */
  loadOlder?: () => void
  /** Load-all handle for the multi-select "select all" action. */
  selectAllPagination?: MessageListSelectAllPagination
  onOpenCitationsPanel?: MessageListActions['openCitationsPanel']
  isAgentToolFlowActive?: MessageListActions['isAgentToolFlowActive']
  openAgentToolFlow?: MessageListActions['openAgentToolFlow']
  openArtifactFile?: MessageListActions['openArtifactFile']
  openBrowserUrl?: MessageListActions['openBrowserUrl']
  openExternalUrl?: MessageListActions['openExternalUrl']
  openDiagnosticReport?: MessageListActions['openDiagnosticReport']
  deleteMessage?: MessageListActions['deleteMessage']
  startEditing?: (messageId: string) => Promise<void>
  editBusy?: boolean
  respondToolApproval?: MessageListActions['respondToolApproval']
  sendMessage?: (message: { text: string }) => Promise<boolean>
}

const AgentSessionMessages = ({
  agentId,
  sessionId,
  messages,
  activeAgent,
  partsByMessageId,
  streamingLayers,
  optimisticAskUserQuestionInputsByToolCallId = {},
  isLoading,
  hasOlder = false,
  loadOlder,
  selectAllPagination,
  onOpenCitationsPanel,
  isAgentToolFlowActive,
  openAgentToolFlow,
  openArtifactFile,
  openBrowserUrl,
  openExternalUrl,
  openDiagnosticReport,
  deleteMessage,
  startEditing,
  editBusy,
  respondToolApproval,
  sendMessage
}: Props) => {
  const { session } = useSession(sessionId)
  const sessionTopicId = useMemo(() => buildAgentSessionTopicId(sessionId), [sessionId])
  const { isPending: isSessionStreaming } = useTopicStreamStatus(sessionTopicId)
  const [messageNavigation] = usePreference('chat.message.navigation_mode')

  const sessionAssistantId = session?.agentId ?? agentId
  const sessionName = session?.name ?? sessionId
  const sessionCreatedAt = session?.createdAt ?? session?.updatedAt ?? FALLBACK_TIMESTAMP
  const sessionLastActivityAt = session?.lastActivityAt ?? sessionCreatedAt
  const sessionUpdatedAt = session?.updatedAt ?? session?.createdAt ?? FALLBACK_TIMESTAMP
  const assistantProfile = useMemo(
    () =>
      activeAgent
        ? {
            name: activeAgent.name,
            avatar: getAgentAvatarFromConfiguration(activeAgent.configuration)
          }
        : undefined,
    [activeAgent]
  )
  const backgroundTaskAnchorMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role !== 'assistant') continue
      const parts = partsByMessageId[message.id] ?? message.parts ?? []
      if (parts.length > 0) return message.id
    }
    return undefined
  }, [messages, partsByMessageId])
  const showGenerateButton = useMemo(() => {
    if (session?.featureKind !== 'industrial-video' || !sendMessage || !backgroundTaskAnchorMessageId) return false
    const message = messages.find(({ id }) => id === backgroundTaskAnchorMessageId)
    const parts = partsByMessageId[backgroundTaskAnchorMessageId] ?? message?.parts ?? []
    return parts.some((part) => part.type === 'text' && /发送[「“]开始生成视频[」”]/u.test(part.text))
  }, [backgroundTaskAnchorMessageId, messages, partsByMessageId, sendMessage, session?.featureKind])
  const messageTail = useMemo(
    () =>
      backgroundTaskAnchorMessageId
        ? {
            messageId: backgroundTaskAnchorMessageId,
            content: (
              <div className="flex flex-col items-start gap-2">
                {/* 工业审核复用消息尾部附件，不进入折叠执行详情。 */}
                {session?.featureKind === 'industrial-video' ? (
                  <IndustrialVideoMessageReview
                    sessionId={sessionId}
                    // executing={isLoading}
                    executing={isSessionStreaming}
                    resumeStages={
                      sendMessage
                        ? (run) =>
                            sendMessage({
                              text: `继续项目 ${run} 的默认 next 分阶段任务，使用当前会话所选模型完整执行 instructions/context/output_schema；预览保存后读取审核并停止，禁止自动审批、估价或生成视频。`
                            })
                        : undefined
                    }
                    // 确认生成走既有会话链路：审核确认成功后发送「开始生成视频」。
                    sendMessage={sendMessage}
                  />
                ) : (
                  showGenerateButton && sendMessage && <IndustrialVideoGenerateButton sendMessage={sendMessage} />
                )}
                <AgentSessionBackgroundTasks sessionId={sessionId} />
              </div>
            )
          }
        : undefined,
    [
      backgroundTaskAnchorMessageId,
      sendMessage,
      sessionId,
      showGenerateButton,
      session?.featureKind,
      isSessionStreaming
    ]
  )

  const derivedTopic = useMemo<Topic>(
    () => ({
      id: sessionTopicId,
      type: TopicType.Session,
      assistantId: sessionAssistantId,
      name: sessionName,
      lastActivityAt: sessionLastActivityAt,
      createdAt: sessionCreatedAt,
      updatedAt: sessionUpdatedAt,
      messages: []
    }),
    [sessionTopicId, sessionAssistantId, sessionName, sessionLastActivityAt, sessionCreatedAt, sessionUpdatedAt]
  )
  const diagnosticReport = useMemo(() => ({ location: 'agent' }), [])

  const messageList = useAgentMessageListProviderValue({
    featureKind: session?.featureKind,
    topic: derivedTopic,
    messages,
    partsByMessageId,
    streamingLayers,
    assistantProfile,
    assistantId: agentId,
    isLoading,
    hasOlder,
    loadOlder,
    selectAllPagination,
    openCitationsPanel: onOpenCitationsPanel,
    isAgentToolFlowActive,
    openAgentToolFlow,
    openArtifactFile,
    openBrowserUrl,
    openExternalUrl,
    openDiagnosticReport,
    diagnosticReport,
    deleteMessage,
    startEditing,
    editBusy,
    respondToolApproval,
    messageNavigation,
    workspacePath: session?.workspace?.path,
    messageTail
  })

  // Main owns the warm lease per (session × window) and debounces the real teardown, so the
  // <Activity> hide/show of a tab switch costs two cheap IPC messages, not a connection cycle —
  // and a lease held by another window keeps the shared connection alive.
  useEffect(() => {
    void ipcApi.request('ai.agent.session.prewarm', { sessionId }).catch((error) => {
      logger.warn('Failed to acquire agent session warm lease', error as Error)
    })
    return () => {
      void ipcApi.request('ai.agent.session.close_warm', { sessionId }).catch((error) => {
        logger.warn('Failed to release agent session warm lease', error as Error)
      })
    }
  }, [sessionId])

  return (
    <AskUserQuestionOptimisticInputProvider value={optimisticAskUserQuestionInputsByToolCallId}>
      <MessageListProvider value={messageList}>
        <MessageList enableSearch />
      </MessageListProvider>
    </AskUserQuestionOptimisticInputProvider>
  )
}

const FALLBACK_TIMESTAMP = '1970-01-01T00:00:00.000Z'

export default memo(AgentSessionMessages)
