import NewTaskPage from '@renderer/pages/workspace/NewTaskPage'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/app/new-task')({
  component: NewTaskPage
})
