import { createFileRoute } from '@tanstack/react-router'

import ResourceCenterPage from '@renderer/pages/workspace/ResourceCenterPage'

export const Route = createFileRoute('/app/resources')({
  component: ResourceCenterPage
})
