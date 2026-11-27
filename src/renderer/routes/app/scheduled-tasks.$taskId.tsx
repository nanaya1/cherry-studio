import { createFileRoute, redirect } from '@tanstack/react-router'

export function redirectLegacyAppTask({
  params,
  search
}: {
  params: { taskId: string }
  search: { runId?: string; notificationId?: string }
}) {
  throw redirect({ to: '/app/scheduled-tasks', search: { ...search, taskId: params.taskId }, replace: true })
}

export const Route = createFileRoute('/app/scheduled-tasks/$taskId')({ beforeLoad: redirectLegacyAppTask })
