import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'

import type { McpToolResponse, NormalToolResponse } from '@renderer/types/mcpTool'
import {
  isMeacoworkToolsServerName,
  normalizeMeacoworkToolRuntimeName,
  toMeacoworkToolRuntimeName
} from '@shared/ai/meacoworkTools'
import { isDeferredToolOutput } from '@shared/ai/transport'
import type { CherryMessagePart } from '@shared/data/types/message'

import { buildToolResponseFromPart } from './toolResponse'

const CONFIG_RUNTIME_TOOL_NAME = toMeacoworkToolRuntimeName('config')

type ChannelConfigToolResponse = McpToolResponse | NormalToolResponse

function isChannelConfigTool(toolResponse: ChannelConfigToolResponse): boolean {
  const { tool } = toolResponse
  const isMeacoworkTools =
    ('serverId' in tool && isMeacoworkToolsServerName(tool.serverId)) ||
    normalizeMeacoworkToolRuntimeName(tool.name) === CONFIG_RUNTIME_TOOL_NAME
  return (
    tool.type === 'mcp' &&
    isMeacoworkTools &&
    (tool.name === 'config' || normalizeMeacoworkToolRuntimeName(tool.name) === CONFIG_RUNTIME_TOOL_NAME)
  )
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
