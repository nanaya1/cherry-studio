import ToolboxPage from '@renderer/pages/workspace/ToolboxPage'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/app/toolbox')({
  component: ToolboxPage
})
