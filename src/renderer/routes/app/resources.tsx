import ResourceCenterPage from '@renderer/pages/workspace/ResourceCenterPage'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/app/resources')({
  component: ResourceCenterPage
})
