import NewTaskPage from '@renderer/pages/workspace/NewTaskPage'
import { createFileRoute } from '@tanstack/react-router'
import * as z from 'zod'

export const Route = createFileRoute('/app/new-task')({
  validateSearch: (search) =>
    z
      .object({
        mode: z.enum(['chat', 'agent']).optional(),
        skillId: z.string().min(1).optional()
      })
      .parse(search),
  component: NewTaskPage
})
