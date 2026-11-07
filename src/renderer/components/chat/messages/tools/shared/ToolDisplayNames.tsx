import { createContext, use, type ReactNode } from 'react'

import {
  isMeacoworkToolsServerName,
  normalizeMeacoworkToolRuntimeName,
  toMeacoworkToolRuntimeName
} from '@shared/ai/meacoworkTools'

export function getMcpToolRuntimeName(tool: { name: string; serverId: string; serverName: string }): string {
  return isMeacoworkToolsServerName(tool.serverId) || isMeacoworkToolsServerName(tool.serverName)
    ? toMeacoworkToolRuntimeName(tool.name)
    : `mcp__${tool.serverId}__${tool.name}`
}

// 页面可注入展示名，缺省时保持原始工具标题和执行行为。
export const ToolDisplayNamesContext = createContext<Readonly<Record<string, string>>>({})

export const ToolResultAttachmentsContext = createContext<((toolName: string, output: unknown) => ReactNode) | null>(
  null
)

export function useToolResultAttachments() {
  return use(ToolResultAttachmentsContext)
}

export function useToolDisplayName(toolName: string): string | undefined {
  return use(ToolDisplayNamesContext)[normalizeMeacoworkToolRuntimeName(toolName)]
}
