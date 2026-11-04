import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import { ContentBlockSchema } from '@modelcontextprotocol/sdk/types.js'

import type { McpServer } from '@shared/data/types/mcpServer'

export const BuiltinMcpServerNames = {
  turingQualityInspection: '图零-质检助手',
  turingEnterpriseDrawingSearch: '图零-图纸检索',
  businessDecisionQualityAnalysis: '智能经营决策、质量分析改进',
  equipmentMaintenance: '装备运维',
  productionControl: '生管管控',
  chatbi: '企业业务数据连接助手',
  turingDrawingSearch: '雪浪图零·工程图纸智能检索连接服务',
  hufu: '数据中台查询分析助手',
  flomo: 'flomo',
  qveris: 'qveris',
  mcpAutoInstall: 'mcp-auto-install',
  memory: 'memory',
  sequentialThinking: 'sequentialthinking',
  braveSearch: 'brave-search',
  fetch: 'fetch',
  filesystem: 'filesystem',
  difyKnowledge: 'dify-knowledge',
  python: 'python',
  didiMcp: 'didi-mcp',
  browser: 'browser',
  nowledgeMem: 'nowledge-mem',
  hub: 'hub'
} as const

export type BuiltinMcpServerName = (typeof BuiltinMcpServerNames)[keyof typeof BuiltinMcpServerNames]

export const BuiltinMcpServerNamesArray = Object.values(BuiltinMcpServerNames)

export const isBuiltinMcpServerName = (name: string): name is BuiltinMcpServerName => {
  return BuiltinMcpServerNamesArray.some((n) => n === name)
}

export type BuiltinMcpServer = McpServer & {
  type: 'inMemory' | 'stdio'
  name: BuiltinMcpServerName
}

export const isInMemoryBuiltinMcpServer = (server: McpServer): server is BuiltinMcpServer & { type: 'inMemory' } => {
  return server.type === 'inMemory' && isBuiltinMcpServerName(server.name)
}

export const isBrowserMcpServer = (server: Pick<McpServer, 'type' | 'name'>): boolean =>
  server.type === 'inMemory' && server.name === BuiltinMcpServerNames.browser

/**
 * Spec-aligned guard for a single MCP `CallToolResult` content block
 * (text / image / audio / resource_link / embedded resource).
 */
export const isMcpContentBlock = (value: unknown): value is ContentBlock => {
  return ContentBlockSchema.safeParse(value).success
}
