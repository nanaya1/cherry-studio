export const MEACOWORK_TOOLS_SERVER_NAME = 'meacowork-tools'
export const LEGACY_MEACOWORK_TOOLS_SERVER_NAME = 'cherry-tools'

const CURRENT_RUNTIME_PREFIX = `mcp__${MEACOWORK_TOOLS_SERVER_NAME}`
const LEGACY_RUNTIME_PREFIX = `mcp__${LEGACY_MEACOWORK_TOOLS_SERVER_NAME}`

export function toMeacoworkToolRuntimeName(toolName: string): string {
  return `${CURRENT_RUNTIME_PREFIX}__${toolName}`
}

export function isMeacoworkToolsServerName(serverName: string | undefined): boolean {
  return serverName === MEACOWORK_TOOLS_SERVER_NAME || serverName === LEGACY_MEACOWORK_TOOLS_SERVER_NAME
}

export function isMeacoworkToolRuntimeName(runtimeName: string | undefined): boolean {
  return (
    runtimeName === CURRENT_RUNTIME_PREFIX ||
    runtimeName?.startsWith(`${CURRENT_RUNTIME_PREFIX}__`) === true ||
    runtimeName === LEGACY_RUNTIME_PREFIX ||
    runtimeName?.startsWith(`${LEGACY_RUNTIME_PREFIX}__`) === true
  )
}

export function normalizeMeacoworkToolRuntimeName(runtimeName: string): string {
  if (runtimeName === LEGACY_RUNTIME_PREFIX) return CURRENT_RUNTIME_PREFIX
  if (runtimeName.startsWith(`${LEGACY_RUNTIME_PREFIX}__`)) {
    return `${CURRENT_RUNTIME_PREFIX}${runtimeName.slice(LEGACY_RUNTIME_PREFIX.length)}`
  }
  return runtimeName
}

export function migrateLegacyMeacoworkToolRuntimeNames(runtimeNames: readonly string[]): string[] {
  return [...new Set(runtimeNames.map(normalizeMeacoworkToolRuntimeName))]
}
