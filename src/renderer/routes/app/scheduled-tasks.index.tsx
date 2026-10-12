import { createFileRoute } from '@tanstack/react-router'

import TasksSettings from '@renderer/pages/settings/TasksSettings'

export const Route = createFileRoute('/app/scheduled-tasks/')({
  component: () => <TasksSettings routeBase="/app/scheduled-tasks" />
})
