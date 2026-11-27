import { createFileRoute, Outlet } from '@tanstack/react-router'

export const Route = createFileRoute('/app/scheduled-tasks')({
  validateSearch: (search: Record<string, unknown>): { taskId?: string; runId?: string; notificationId?: string } => ({
    ...(typeof search.taskId === 'string' && search.taskId.trim() ? { taskId: search.taskId } : {}),
    ...(typeof search.notificationId === 'string' && search.notificationId.trim()
      ? { notificationId: search.notificationId }
      : {}),
    ...(typeof search.runId === 'string' && search.runId.trim() ? { runId: search.runId } : {})
  }),
  component: Outlet
})
