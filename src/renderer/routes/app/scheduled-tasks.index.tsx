import TasksSettings from '@renderer/pages/settings/TasksSettings'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/app/scheduled-tasks/')({
  component: () => <TasksSettings routeBase="/app/scheduled-tasks" />
})
