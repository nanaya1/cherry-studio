import type { McpServer } from '../../data/types/mcpServer'
import { buildFunctionCallToolName, CHERRY_TOOLS_MCP_SERVER, isBuiltinToolsMcpServer, toCamelCase } from './mcpToolName'

export type McpPolicyTool = {
  id?: string
  name: string
}

export type McpSourceToolAccess = {
  enabled: boolean
  approval: 'auto' | 'prompt'
}

export function buildMcpWireToolId(serverName: string, toolName: string): string {
  return buildFunctionCallToolName(serverName, toolName)
}

export function buildMcpWireWildcard(serverName: string): string {
  return `mcp__${toCamelCase(serverName)}__*`
}

export function matchesMcpSourceToolRule(value: string, server: McpServer, tool: McpPolicyTool): boolean {
  if (
    value === tool.name ||
    value === tool.id ||
    value === buildMcpWireToolId(server.name, tool.name) ||
    value === buildMcpWireWildcard(server.name)
  ) {
    return true
  }
  // The in-process builtin server was renamed `cherry-tools` → `meacowork-tools`. Persisted
  // disabledTools / disabledAutoApproveTools rules can still carry the legacy wire id or
  // wildcard; match those against the same tool so upgrades don't silently drop restrictions.
  if (isBuiltinToolsMcpServer(server.name)) {
    return (
      value === buildMcpWireToolId(CHERRY_TOOLS_MCP_SERVER, tool.name) ||
      value === buildMcpWireWildcard(CHERRY_TOOLS_MCP_SERVER)
    )
  }
  return false
}

export function isMcpToolDisabledBySource(server: McpServer, tool: McpPolicyTool): boolean {
  return server.disabledTools?.some((value) => matchesMcpSourceToolRule(value, server, tool)) ?? false
}

export function isMcpToolForcePromptBySource(server: McpServer, tool: McpPolicyTool): boolean {
  return server.disabledAutoApproveTools?.some((value) => matchesMcpSourceToolRule(value, server, tool)) ?? false
}

export function resolveMcpSourceToolAccess(server: McpServer, tool: McpPolicyTool): McpSourceToolAccess {
  if (isMcpToolDisabledBySource(server, tool)) {
    return { enabled: false, approval: 'prompt' }
  }
  if (isMcpToolForcePromptBySource(server, tool)) {
    return { enabled: true, approval: 'prompt' }
  }
  return { enabled: true, approval: 'auto' }
}
