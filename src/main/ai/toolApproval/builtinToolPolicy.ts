import {
  buildBuiltinToolsRuntimeName,
  CHERRY_TOOLS_MCP_SERVER,
  isBuiltinToolsMcpServer,
  MEACOWORK_TOOLS_MCP_SERVER
} from '@shared/ai/tools/mcpToolName'
import type { AgentPermissionMode } from '@shared/data/api/schemas/agents'

import {
  BUILTIN_TOOL_POLICY_ENTRIES,
  // CHERRY_MCP_SERVER,
  type BuiltinToolApproval,
  type BuiltinToolBypassApproval,
  type BuiltinToolPolicyEntry,
  MOUNTED_TOOL_POLICY_PROVIDERS
} from './builtinToolPolicyRegistry'
import type { ToolGuardInteractionState } from './toolGuards'

export type {
  BuiltinToolApproval,
  BuiltinToolBypassApproval,
  BuiltinToolPolicyEntry
} from './builtinToolPolicyRegistry'
export { CHERRY_MCP_SERVER } from './builtinToolPolicyRegistry'

/** Auto-approval never authorizes another unattended delegation hop. */
export function resolveDelegationApproval(
  mode: AgentPermissionMode | undefined,
  interaction: ToolGuardInteractionState
): 'allow' | 'ask' | 'deny' {
  if (interaction.currentTurn === 'headless' || interaction.userResponse === 'unavailable') return 'deny'
  return mode === 'auto' || mode === 'bypassPermissions' ? 'allow' : 'ask'
}

/**
 * Index every builtin entry under both its canonical (new) runtime name and, for the renamed
 * builtin-tools server, the legacy `mcp__cherry-tools__*` name. Persisted source-policy rules,
 * warm-session snapshots and older callers can then resolve the same policy through either
 * spelling. Other servers keep a single identity.
 */
const BUILTIN_TOOL_POLICY_BY_RUNTIME_NAME = new Map<string, BuiltinToolPolicyEntry>(
  BUILTIN_TOOL_POLICY_ENTRIES.flatMap((entry) => {
    const names = [toMcpRuntimeName(entry)]
    if (entry.serverName === MEACOWORK_TOOLS_MCP_SERVER) {
      // Legacy alias of the builtin-tools server — old persisted / in-flight names still resolve.
      names.push(`mcp__${CHERRY_TOOLS_MCP_SERVER}__${entry.toolName}`)
    }
    return names.map((name) => [name, entry] as const)
  })
)

/**
 * Mounted-server check with rename tolerance: a session snapshot or caller may carry either the
 * canonical `meacowork-tools` or the legacy `cherry-tools` id for the same builtin server.
 */
function isServerMounted(mountedServers: ReadonlySet<string>, serverName: string): boolean {
  if (mountedServers.has(serverName)) return true
  if (!isBuiltinToolsMcpServer(serverName)) return false
  for (const mounted of mountedServers) {
    if (isBuiltinToolsMcpServer(mounted)) return true
  }
  return false
}

export interface BuiltinToolPolicyQuery {
  readonly approval?: BuiltinToolApproval
  readonly bypassApproval?: BuiltinToolBypassApproval
  /** Omit for static policies; mounted servers also resolve their live, context-dependent policies. */
  readonly mountedServers?: ReadonlySet<string>
}

/** Query entries without exposing a mutable registry or a maintained name list. */
export function listBuiltinToolPolicies(query: BuiltinToolPolicyQuery = {}): BuiltinToolPolicyEntry[] {
  const entries = [
    ...BUILTIN_TOOL_POLICY_ENTRIES,
    ...Array.from(query.mountedServers ?? []).flatMap((server) => MOUNTED_TOOL_POLICY_PROVIDERS.get(server)?.() ?? [])
  ]
  return entries.filter(
    (entry) =>
      (query.approval === undefined || entry.approval === query.approval) &&
      (query.bypassApproval === undefined || entry.bypassApproval === query.bypassApproval) &&
      (query.mountedServers === undefined || isServerMounted(query.mountedServers, entry.serverName))
  )
}

/** Resolve a Claude-style MCP runtime name against the servers this session actually mounted. */
export function findBuiltinToolPolicy(
  runtimeName: string,
  mountedServers: ReadonlySet<string>
): BuiltinToolPolicyEntry | undefined {
  const entry = BUILTIN_TOOL_POLICY_BY_RUNTIME_NAME.get(runtimeName)
  if (entry && isServerMounted(mountedServers, entry.serverName)) return entry
  for (const server of mountedServers) {
    const policy = MOUNTED_TOOL_POLICY_PROVIDERS.get(server)?.().find(
      (candidate) => toMcpRuntimeName(candidate) === runtimeName
    )
    if (policy) return policy
  }
  return undefined
}

/** Standard MCP runtime name used by Claude Code and legacy bridged identities. */
export function toMcpRuntimeName(ref: Pick<BuiltinToolPolicyEntry, 'serverName' | 'toolName'>): string {
  return `mcp__${ref.serverName}__${ref.toolName}`
}

/**
 * Convenience for the non-policy citation call site.
 * Writes the canonical `mcp__meacowork-tools__<tool>` name (formerly the literal
 * `mcp__cherry-tools__<tool>`); the shared helper owns the new server id.
 */
export function toCherryBuiltinRuntimeName(toolName: string): string {
  return buildBuiltinToolsRuntimeName(toolName)
}
