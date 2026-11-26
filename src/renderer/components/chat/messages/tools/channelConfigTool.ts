import { CallToolResultSchema } from '@modelcontextprotocol/core'

import type { McpToolResponse, NormalToolResponse } from '@renderer/types/mcpTool'
import { isBuiltinToolsMcpServer, isBuiltinToolsRuntimeName } from '@shared/ai/tools/mcpToolName'
import { isDeferredToolOutput } from '@shared/ai/transport'
import type { CherryMessagePart } from '@shared/data/types/message'

import { buildToolResponseFromPart } from './toolResponse'

const CONFIG_TOOL_NAMES = new Set([
  'config',
  'mcp__meacowork-tools__config',
  // Legacy wire name from before the builtin server rename.
  'mcp__cherry-tools__config'
])

type ChannelConfigToolResponse = McpToolResponse | NormalToolResponse

function isChannelConfigTool(toolResponse: ChannelConfigToolResponse): boolean {
  const { tool } = toolResponse
  const isCherryTools =
    ('serverId' in tool && isBuiltinToolsMcpServer(tool.serverId)) || isBuiltinToolsRuntimeName(tool.name, 'config')
  return tool.type === 'mcp' && isCherryTools && CONFIG_TOOL_NAMES.has(tool.name)
}

function isChannelAuthQrRequest(toolResponse: ChannelConfigToolResponse): boolean {
  if (!isChannelConfigTool(toolResponse)) return false

  const args = toolResponse.arguments
  if (!args || Array.isArray(args) || typeof args !== 'object') return false
  if (args.action === 'reconnect_channel') return true
  return args.action === 'add_channel' && args.auth_mode === 'qr'
}

export function getChannelAuthQrResult(toolResponse: ChannelConfigToolResponse) {
  if (!isChannelAuthQrRequest(toolResponse) || typeof toolResponse.toolCallId !== 'string') return null

  const result = CallToolResultSchema.safeParse(toolResponse.response)
  if (!result.success) return null

  const images = result.data.content.flatMap((item) =>
    item.type === 'image' && item.data ? [`data:${item.mimeType ?? 'image/png'};base64,${item.data}`] : []
  )
  if (images.length === 0) return null

  return {
    images,
    responseWithoutImages: {
      ...result.data,
      content: result.data.content.filter((item) => item.type !== 'image')
    }
  }
}

export function isChannelAuthQrToolResponse(
  toolResponse: ChannelConfigToolResponse
): toolResponse is NormalToolResponse {
  return getChannelAuthQrResult(toolResponse) !== null
}

export function isChannelAuthQrPart(part: CherryMessagePart): boolean {
  const toolResponse = buildToolResponseFromPart(part)
  if (!toolResponse || !isChannelAuthQrRequest(toolResponse)) return false
  return isDeferredToolOutput(toolResponse.response) || getChannelAuthQrResult(toolResponse) !== null
}
