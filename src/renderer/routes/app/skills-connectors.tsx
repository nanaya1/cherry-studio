import McpCatalog from '@renderer/pages/settings/McpSettings/McpCatalog'
import SkillsConnectorsPage from '@renderer/pages/workspace/SkillsConnectorsPage'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/app/skills-connectors')({
  component: () => <SkillsConnectorsPage connectorView={<McpCatalog />} />
})
