import type { AgentPermissionMode } from '../../data/api/schemas/agents'
import type { ToolApproval, ToolOrigin } from '../tool'
import { buildMcpWireToolId, buildMcpWireWildcard } from '../tools/mcpSourcePolicy'
import { CHERRY_TOOLS_MCP_SERVER, isBuiltinToolsMcpServer } from '../tools/mcpToolName'

export interface ClaudeToolDescriptor {
  id: string
  name: string
  description?: string
  origin: ToolOrigin
  sourceId?: string
  sourceName?: string
  sourceToolName?: string
  sourceApproval?: ToolApproval
}

export interface ClaudeToolDecision {
  id: string
  approval: ToolApproval
}

export interface ClaudeToolPolicy {
  permissionMode?: AgentPermissionMode
}

const DEFAULT_SAFE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'NotebookRead', 'Task', 'TodoWrite'])
const ACCEPT_EDITS_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit', 'Write'])

export function normalizeClaudeBuiltinName(name: string): string {
  return name.startsWith('builtin_') ? name.slice('builtin_'.length) : name
}

export function buildClaudeMcpToolName(serverName: string, toolName: string): string {
  return buildMcpWireToolId(serverName, toolName)
}

export function buildClaudeMcpWildcard(serverName: string): string {
  return buildMcpWireWildcard(serverName)
}

function rawClaudeMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`
}

export function matchesClaudeToolRule(rule: string, descriptor: ClaudeToolDescriptor): boolean {
  if (rule === descriptor.id) return true

  if (descriptor.origin === 'builtin') {
    return normalizeClaudeBuiltinName(rule) === normalizeClaudeBuiltinName(descriptor.id)
  }

  if (descriptor.origin === 'mcp') {
    if (descriptor.sourceName && rule === buildClaudeMcpWildcard(descriptor.sourceName)) return true
    if (descriptor.sourceName && descriptor.sourceToolName) {
      if (rule === rawClaudeMcpToolName(descriptor.sourceName, descriptor.sourceToolName)) return true
      if (rule === rawClaudeMcpToolName(descriptor.sourceName, '*')) return true
    }
    // The builtin-tools server was renamed; a persisted rule under the legacy server name
    // must still apply to the same tool. Restrict this to the known builtin server so a
    // third-party MCP can never be matched through an unrelated server's rule.
    if (descriptor.sourceName && isBuiltinToolsMcpServer(descriptor.sourceName) && descriptor.sourceToolName) {
      if (rule === rawClaudeMcpToolName(CHERRY_TOOLS_MCP_SERVER, descriptor.sourceToolName)) return true
      if (rule === rawClaudeMcpToolName(CHERRY_TOOLS_MCP_SERVER, '*')) return true
    }
  }

  return false
}

function sourceDecision(descriptor: ClaudeToolDescriptor): ClaudeToolDecision | undefined {
  if (descriptor.sourceApproval === 'prompt') {
    return { id: descriptor.id, approval: 'prompt' }
  }
  return undefined
}

export function resolveClaudeToolAccess(
  descriptor: ClaudeToolDescriptor,
  policy: ClaudeToolPolicy
): ClaudeToolDecision {
  const source = sourceDecision(descriptor)
  if (source) return source

  if (policy.permissionMode === 'bypassPermissions') {
    return { id: descriptor.id, approval: 'auto' }
  }

  if (policy.permissionMode === 'acceptEdits' && ACCEPT_EDITS_TOOLS.has(descriptor.id)) {
    return { id: descriptor.id, approval: 'auto' }
  }

  if (DEFAULT_SAFE_TOOLS.has(descriptor.id)) {
    return { id: descriptor.id, approval: 'auto' }
  }

  return { id: descriptor.id, approval: 'prompt' }
}
