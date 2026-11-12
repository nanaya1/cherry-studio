import type { HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk'

const HANDOFF_TOOLS = new Set([
  'mcp__meacowork-tools__ivideo_review_snapshot_get',
  'mcp__meacowork-tools__ivideo_start'
])

/** Stop only this SDK turn after a successful industrial workbench handoff. */
export function industrialVideoTurnHandoff(featureKind: string | undefined, input: HookInput): HookJSONOutput {
  if (
    featureKind !== 'industrial-video' ||
    input.hook_event_name !== 'PostToolUse' ||
    input.agent_id ||
    !HANDOFF_TOOLS.has(input.tool_name)
  )
    return {}
  try {
    const response = input.tool_response as { isError?: boolean; content?: { type: string; text?: string }[] }
    if (response?.isError) return {}
    const value = JSON.parse(response?.content?.find((part) => part.type === 'text')?.text ?? 'null')
    if (
      value?.ok !== true ||
      value.end_turn !== true ||
      typeof value.message !== 'string' ||
      !value.message.trim() ||
      typeof value.workbench_url !== 'string'
    )
      return {}
    const url = new URL(value.workbench_url)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return {}
    return { continue: false, stopReason: value.message }
  } catch {
    return {}
  }
}
