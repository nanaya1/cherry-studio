import { createFileRoute } from '@tanstack/react-router'

import ScheduledTasksPage from '@renderer/pages/agents/ScheduledTasksPage'

export const Route = createFileRoute('/app/scheduled-tasks/')({ component: ScheduledTasksPage })
