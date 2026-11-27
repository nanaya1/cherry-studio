import { Bot, MessageCircle } from 'lucide-react'

import { useQuery } from '@data/hooks/useDataApi'
import type { NotificationRecord } from '@shared/data/types/notification'

import { notificationPreview } from './notificationPresentation'

function NotificationIdentity({ name, icon: Icon }: { name: string; icon: typeof Bot }) {
  return (
    <span
      className="flex min-w-0 max-w-[40%] shrink-0 items-center gap-1 text-xs font-normal text-muted-foreground"
      title={name}>
      <Icon aria-hidden size={14} className="shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  )
}

function AgentNotificationLabel({ sessionId }: { sessionId: string }) {
  const { data: session, error: sessionError } = useQuery('/agent-sessions/:sessionId', {
    params: { sessionId },
    swrOptions: { shouldRetryOnError: false }
  })
  const { data: agent, error: agentError } = useQuery('/agents/:agentId', {
    params: { agentId: session?.agentId ?? '' },
    enabled: !!session?.agentId && !sessionError,
    swrOptions: { shouldRetryOnError: false }
  })
  if (sessionError || agentError || !agent?.name) return null

  return <NotificationIdentity name={agent.name} icon={Bot} />
}

function AssistantNotificationLabel({ topicId }: { topicId: string }) {
  const { data: topic, error: topicError } = useQuery('/topics/:id', {
    params: { id: topicId },
    swrOptions: { shouldRetryOnError: false }
  })
  const { data: assistant, error: assistantError } = useQuery('/assistants/:id', {
    params: { id: topic?.assistantId ?? '' },
    enabled: !!topic?.assistantId && !topicError,
    swrOptions: { shouldRetryOnError: false }
  })
  if (topicError || assistantError || !assistant?.name) return null

  return <NotificationIdentity name={assistant.name} icon={MessageCircle} />
}

export function NotificationTitle({ record }: { record: NotificationRecord }) {
  const result = record.target?.result
  const target =
    (record.kind === 'task-completion' || record.kind === 'queue-completion' || result) &&
    record.target?.kind === 'conversation'
      ? record.target
      : undefined
  if (!target && !result?.actor) return notificationPreview(record.title, true)

  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 truncate">{notificationPreview(record.title, true)}</span>
      {result?.actor ? (
        <NotificationIdentity name={result.actor.name} icon={result.source === 'agent' ? Bot : MessageCircle} />
      ) : target?.conversationType === 'agent' ? (
        <AgentNotificationLabel sessionId={target.conversationId} />
      ) : target ? (
        <AssistantNotificationLabel topicId={target.conversationId} />
      ) : null}
    </span>
  )
}
