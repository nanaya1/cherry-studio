import { createFileRoute, redirect } from '@tanstack/react-router'

export function redirectToMcpSources() {
  throw redirect({ to: '/app/skills-connectors', search: { tab: 'connector', connectorView: 'marketplace' } })
}

export const Route = createFileRoute('/settings/mcp/marketplaces')({ beforeLoad: redirectToMcpSources })
