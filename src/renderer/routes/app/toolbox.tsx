import { createFileRoute } from '@tanstack/react-router'

import ToolboxPage from '@renderer/pages/workspace/ToolboxPage'

export const Route = createFileRoute('/app/toolbox')({
  component: ToolboxPage
})
