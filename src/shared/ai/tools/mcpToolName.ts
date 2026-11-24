/**
 * Convert a string to camelCase, ensuring it's a valid JavaScript identifier.
 *
 * - Normalizes to lowercase first, then capitalizes word boundaries
 * - Non-alphanumeric characters are treated as word separators
 * - Non-ASCII characters are dropped (ASCII-only output)
 * - If result starts with a digit, prefixes with underscore
 *
 * @example
 * toCamelCase('my-server') // 'myServer'
 * toCamelCase('MY_SERVER') // 'myServer'
 * toCamelCase('123tool')   // '_123tool'
 */
export function toCamelCase(str: string): string {
  let result = str
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+(.)/g, (_, char) => char.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, '')

  if (result && !/^[a-zA-Z_]/.test(result)) {
    result = '_' + result
  }

  return result
}

export type McpToolNameOptions = {
  /** Prefix added before the name (e.g., 'mcp__'). Must be JS-identifier-safe. */
  prefix?: string
  /** Delimiter between server and tool parts (e.g., '_' or '__'). Must be JS-identifier-safe. */
  delimiter?: string
  /** Maximum length of the final name. Suffix numbers for uniqueness are included in this limit. */
  maxLength?: number
  /** Mutable Set for collision detection. The final name will be added to this Set. */
  existingNames?: Set<string>
}

/**
 * Build a valid JavaScript function name from server and tool names.
 * Uses camelCase for both parts.
 *
 * @param serverName - The MCP server name (optional)
 * @param toolName - The tool name
 * @param options - Configuration options
 * @returns A valid JS identifier
 */
export function buildMcpToolName(
  serverName: string | undefined,
  toolName: string,
  options: McpToolNameOptions = {}
): string {
  const { prefix = '', delimiter = '_', maxLength, existingNames } = options

  const serverPart = serverName ? toCamelCase(serverName) : ''
  const toolPart = toCamelCase(toolName)
  const baseName = serverPart ? `${prefix}${serverPart}${delimiter}${toolPart}` : `${prefix}${toolPart}`

  if (!existingNames) {
    return maxLength ? truncateToLength(baseName, maxLength) : baseName
  }

  let name = maxLength ? truncateToLength(baseName, maxLength) : baseName
  let counter = 1

  while (existingNames.has(name)) {
    const suffix = String(counter)
    const truncatedBase = maxLength ? truncateToLength(baseName, maxLength - suffix.length) : baseName
    name = `${truncatedBase}${suffix}`
    counter++
  }

  existingNames.add(name)
  return name
}

function truncateToLength(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str
  }
  return str.slice(0, maxLength).replace(/_+$/, '')
}

/**
 * Generate a unique function name from server name and tool name.
 * Format: serverName_toolName (camelCase)
 *
 * @example
 * generateMcpToolFunctionName('github', 'search_issues') // 'github_searchIssues'
 */
export function generateMcpToolFunctionName(
  serverName: string | undefined,
  toolName: string,
  existingNames?: Set<string>
): string {
  return buildMcpToolName(serverName, toolName, { existingNames })
}

const FUNCTION_CALL_TOOL_NAME_MAX_LENGTH = 63
/** `_` + a fixed-width base36 hash of the server name, reserved on truncation. */
const SERVER_DISAMBIGUATOR_LENGTH = 7

/**
 * FNV-1a 32-bit hash of the server name as a fixed-width base36 string.
 * Identifier-safe (`[0-9a-z]`) so it can sit inside a JS-identifier tool name.
 */
function hashServerName(serverName: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < serverName.length; i++) {
    h ^= serverName.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36).padStart(SERVER_DISAMBIGUATOR_LENGTH, '0').slice(-SERVER_DISAMBIGUATOR_LENGTH)
}

/**
 * Builds the legacy name-based MCP tool id used by persisted source-policy
 * rules and the Claude Code adapter. AI SDK catalog identities must use the
 * main-process `buildMcpToolWireId`, which includes stable server identity.
 *
 * Format: `mcp__{server}__{tool}` (camelCase), max 63 chars.
 *
 * When the untruncated name exceeds the cap the tail is dropped — and for long
 * server names the `__` delimiter and part of the server segment go with it. A
 * server-derived suffix (`_<hash(serverName)>`) keeps legacy ids deterministic
 * and disambiguates long server display names.
 *
 * @example
 * buildFunctionCallToolName('github', 'search_issues') // 'mcp__github__searchIssues'
 */
export function buildFunctionCallToolName(serverName: string, toolName: string): string {
  const serverPart = serverName ? toCamelCase(serverName) : ''
  const toolPart = toCamelCase(toolName)
  const baseName = serverPart ? `mcp__${serverPart}__${toolPart}` : `mcp__${toolPart}`
  if (baseName.length <= FUNCTION_CALL_TOOL_NAME_MAX_LENGTH) {
    return baseName
  }
  const suffix = `_${hashServerName(serverName)}`
  const body = truncateToLength(baseName, FUNCTION_CALL_TOOL_NAME_MAX_LENGTH - suffix.length)
  return `${body}${suffix}`
}

export type McpFunctionCallToolNameParts = {
  serverPart: string
  toolPart: string
}

/**
 * Parse MCP tool-call names in the Claude/AI-SDK format:
 * `mcp__{server}__{tool}`.
 *
 * Callers feed this raw provider payloads, where a tool name typed as `string`
 * can still be absent at runtime (see `ClaudeCodeStreamAdapter`), so a missing
 * name parses as "not an MCP name" rather than throwing.
 */
export function parseFunctionCallToolName(toolName: string | undefined): McpFunctionCallToolNameParts | null {
  if (!toolName?.startsWith('mcp__')) return null

  const rest = toolName.slice('mcp__'.length)
  const delimiterIndex = rest.lastIndexOf('__')
  if (delimiterIndex <= 0 || delimiterIndex >= rest.length - 2) return null

  return {
    serverPart: rest.slice(0, delimiterIndex),
    toolPart: rest.slice(delimiterIndex + 2)
  }
}

/**
 * ── Built-in tools MCP server rename (`cherry-tools` → `meacowork-tools`) ──────────
 *
 * 历史：内置工具 server 曾叫 `cherry-tools`，wire name 为 `mcp__cherry-tools__<tool>`；
 * `buildFunctionCallToolName` 还会产出 camelCase 形态 `mcp__cherryTools__<tool>`，长名时
 * 截断并追加 server 派生 hash。这些名字已持久化在 source-policy 的
 * `disabledTools` / `disabledAutoApproveTools`、消息 part 的 tool name 以及
 * `metadata.serverId` / `metadata.serverName` 中。
 *
 * 现在：新写入统一用 `meacowork-tools`；所有读路径（权限、引用、导出、会话恢复）
 * 必须同时识别新旧 server 名与 snake/camel 两种工具段，否则存量数据在升级后会失效。
 * 上面原有的命名/解析函数全部原样保留，继续服务第三方 MCP 与 legacy 策略。
 */

/** 新的 canonical server id —— 新写入的 wire name / metadata 一律用它。 */
export const MEACOWORK_TOOLS_MCP_SERVER = 'meacowork-tools'
/** 旧 server id —— 仅供识别存量数据，不再产出。 */
export const CHERRY_TOOLS_MCP_SERVER = 'cherry-tools'

/**
 * 内置工具 server 的所有已知拼写：新旧 kebab id 与各自 camelCase wire 形态。
 * 顺序无关；用于任何"这个 server 段是不是内置工具 server"的判定。
 */
const BUILTIN_TOOLS_SERVER_IDS: ReadonlySet<string> = new Set([
  MEACOWORK_TOOLS_MCP_SERVER,
  CHERRY_TOOLS_MCP_SERVER,
  toCamelCase(MEACOWORK_TOOLS_MCP_SERVER), // meacoworkTools
  toCamelCase(CHERRY_TOOLS_MCP_SERVER) // cherryTools
])

/**
 * 判定一个 server id / serverName / wire 中的 serverPart 是否属于内置工具 server。
 * 同时接受新旧 id 与 camelCase 形态（后者来自 `buildFunctionCallToolName`）。
 * 非内置 server（agent-memory / skills / 第三方）返回 false，避免误放行。
 */
export function isBuiltinToolsMcpServer(serverName: unknown): boolean {
  if (typeof serverName !== 'string' || !serverName) return false
  const lower = serverName.toLowerCase()
  for (const id of BUILTIN_TOOLS_SERVER_IDS) {
    if (serverName === id || lower === id.toLowerCase()) return true
  }
  return false
}

/**
 * 写入端：构造内置工具的新 wire name `mcp__meacowork-tools__<tool>`。
 * 工具名保留协议原名（snake_case），与既有 `mcp__cherry-tools__<tool>` 形态一致。
 */
export function buildBuiltinToolsRuntimeName(toolName: string): string {
  return `mcp__${MEACOWORK_TOOLS_MCP_SERVER}__${toolName}`
}

/**
 * 读取端：判断一个 wire name 是否指向内置工具的某个工具。
 * 新名与旧名（含 camelCase 工具段）都接受；工具段用 `toCamelCase` 双边归一，
 * 以兼容 `mcp__cherryTools__webSearch` 这类历史拼法。
 */
export function isBuiltinToolsRuntimeName(name: string | undefined, toolName: string): boolean {
  const parsed = parseFunctionCallToolName(name)
  if (!parsed || !isBuiltinToolsMcpServer(parsed.serverPart)) return false
  return toCamelCase(parsed.toolPart) === toCamelCase(toolName)
}

/**
 * 读取端：把新旧内置工具 wire name 归一到唯一的 canonical 新名。
 * 非内置 server（如 `mcp__docs__search`）原样返回；`undefined` 原样返回，
 * 便于调用方直接透传可选的工具名而不额外分支。
 *
 * 注意：带 server-hash 截断的历史 id（`mcp__cherryTools__<tool>_<hash>`）无法反推
 * 原工具名，其归一结果仍带原工具段；这类 id 的权限识别走
 * `isBuiltinToolsMcpServer(parsed.serverPart)`，不要依赖本函数做 ID 相等比较。
 */
export function normalizeBuiltinToolsRuntimeName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined
  const parsed = parseFunctionCallToolName(name)
  if (!parsed || !isBuiltinToolsMcpServer(parsed.serverPart)) return name
  return buildBuiltinToolsRuntimeName(parsed.toolPart)
}
