import SkillsConnectorsPage from '@renderer/pages/workspace/SkillsConnectorsPage'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/app/skills-connectors')({
  component: SkillsConnectorsPage
})
