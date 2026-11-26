import { createFileRoute, redirect } from '@tanstack/react-router'

import ScheduledTasksPage from '@renderer/pages/agents/ScheduledTasksPage'
import TasksSettings from '@renderer/pages/settings/TasksSettings'

export function redirectToScheduledTask({
  search
}: {
  search: { taskId?: string; runId?: string; notificationId?: string; view?: 'result' }
}) {
  if (search.view === 'result') return
  const { taskId, ...context } = search
  if (taskId) {
    throw redirect({ to: '/app/scheduled-tasks/$taskId', params: { taskId }, search: context, replace: true })
  }
}

export const Route = createFileRoute('/app/scheduled-tasks/')({
  beforeLoad: redirectToScheduledTask,
  component: ScheduledTasksIndex
})

function ScheduledTasksIndex() {
  const { view } = Route.useSearch()
  // MEA:scheduled-task-notification-route Keep the sidebar on the existing task layout.
  return view === 'result' ? <ScheduledTasksPage /> : <TasksSettings routeBase="/app/scheduled-tasks" />
}
