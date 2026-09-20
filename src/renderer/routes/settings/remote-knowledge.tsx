import { createFileRoute } from '@tanstack/react-router'

import { RemoteKnowledgeSettings } from '@renderer/pages/settings/RemoteKnowledgeSettings'

export const Route = createFileRoute('/settings/remote-knowledge')({
  component: RemoteKnowledgeSettings
})
