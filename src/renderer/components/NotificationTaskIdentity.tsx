import { Bot, MessageCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Tooltip } from '@cherrystudio/ui'
import { useQuery } from '@data/hooks/useDataApi'
import type { NotificationRecord } from '@shared/data/types/notification'

import { notificationPreview } from './notificationPresentation'

function NotificationIdentity({ name, icon: Icon }: { name: string; icon?: typeof Bot }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <Tooltip content={name} asChild>
        <span tabIndex={0} className="min-w-0 truncate rounded-sm focus-visible:bg-accent">
          {name}
        </span>
      </Tooltip>
      {Icon && (
        <span className="flex size-5 shrink-0 items-center justify-center">
          <Icon aria-hidden size={18} />
        </span>
      )}
    </span>
  )
}

function AgentNotificationLabel({ sessionId, snapshot }: { sessionId: string; snapshot?: { name: string } }) {
  const { t } = useTranslation()
  const { data: session, error: sessionError } = useQuery('/agent-sessions/:sessionId', {
    params: { sessionId },
    swrOptions: { shouldRetryOnError: false }
  })
  const { data: agent, error: agentError } = useQuery('/agents/:agentId', {
    params: { agentId: session?.agentId ?? '' },
    enabled: !!session?.agentId && !sessionError,
    swrOptions: { shouldRetryOnError: false }
  })
  const current = !sessionError && !agentError ? agent : undefined
  return (
    <NotificationIdentity
      name={current?.name?.trim() || snapshot?.name || t('agent.session.display.agent')}
      icon={Bot}
    />
  )
}

function AssistantNotificationLabel({ topicId, snapshot }: { topicId: string; snapshot?: { name: string } }) {
  const { t } = useTranslation()
  const { data: topic, error: topicError } = useQuery('/topics/:id', {
    params: { id: topicId },
    swrOptions: { shouldRetryOnError: false }
  })
  const { data: assistant, error: assistantError } = useQuery('/assistants/:id', {
    params: { id: topic?.assistantId ?? '' },
    enabled: !!topic?.assistantId && !topicError,
    swrOptions: { shouldRetryOnError: false }
  })
  const current = !topicError && !assistantError ? assistant : undefined
  return (
    <NotificationIdentity
      name={current?.name?.trim() || snapshot?.name || t('chat.topics.display.assistant')}
      icon={MessageCircle}
    />
  )
}

function ScheduledNotificationLabel({ taskId, snapshot }: { taskId: string; snapshot?: string }) {
  const { t } = useTranslation()
  const { data: task, error } = useQuery('/agent-tasks/:taskId', {
    params: { taskId },
    swrOptions: { shouldRetryOnError: false }
  })
  return (
    <NotificationIdentity name={(!error && task?.name?.trim()) || snapshot || t('settings.scheduledTasks.title')} />
  )
}

export function NotificationTaskIdentity({ record }: { record: NotificationRecord }) {
  const target = record.target
  if (target?.kind === 'scheduled-task')
    return <ScheduledNotificationLabel taskId={target.taskId} snapshot={target.result?.name} />
  if (target?.kind !== 'conversation') return notificationPreview(record.title, true)
  return target.conversationType === 'agent' ? (
    <AgentNotificationLabel sessionId={target.conversationId} snapshot={target.result?.actor} />
  ) : (
    <AssistantNotificationLabel topicId={target.conversationId} snapshot={target.result?.actor} />
  )
}
