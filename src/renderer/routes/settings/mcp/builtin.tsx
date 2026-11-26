import { createFileRoute, redirect } from '@tanstack/react-router'

export function redirectToMcpCatalog() {
  throw redirect({ to: '/app/skills-connectors', search: { tab: 'connector', connectorView: 'builtin' } })
}

export const Route = createFileRoute('/settings/mcp/builtin')({ beforeLoad: redirectToMcpCatalog })
