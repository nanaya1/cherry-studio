import { isFunctionCallingModel } from '@renderer/utils/model'
import type { Model } from '@shared/data/types/model'

export const LAST_USED_ASSISTANT_CACHE_KEY = 'ui.chat.last_used_assistant_id'

export type DefaultAssistantSelectionSource =
  | 'explicit'
  | 'preferred'
  | 'last-used'
  | 'first-assistant'
  | 'runtime-fallback'

export type DefaultAssistantSelection = {
  assistantId?: string
  source: DefaultAssistantSelectionSource
}

type AssistantIdentity = {
  id: string
}

type ResolveDefaultAssistantOptions = {
  explicitAssistantId?: string | null
  preferredAssistantId?: string | null
  lastUsedAssistantId?: string | null
  excludedAssistantIds?: readonly string[]
}

export function resolveDefaultAssistant(
  assistants: readonly AssistantIdentity[],
  options: ResolveDefaultAssistantOptions = {}
): DefaultAssistantSelection {
  const assistantIds = new Set(assistants.map((assistant) => assistant.id))
  const excludedAssistantIds = new Set(options.excludedAssistantIds ?? [])
  const isAvailable = (assistantId: string | null | undefined): assistantId is string =>
    !!assistantId && assistantIds.has(assistantId) && !excludedAssistantIds.has(assistantId)

  if (options.explicitAssistantId === null) return { source: 'explicit' }
  if (isAvailable(options.explicitAssistantId)) {
    return { assistantId: options.explicitAssistantId, source: 'explicit' }
  }
  if (isAvailable(options.preferredAssistantId)) {
    return { assistantId: options.preferredAssistantId, source: 'preferred' }
  }
  if (isAvailable(options.lastUsedAssistantId)) {
    return { assistantId: options.lastUsedAssistantId, source: 'last-used' }
  }

  const fallbackAssistantId = assistants.find((assistant) => !excludedAssistantIds.has(assistant.id))?.id
  if (fallbackAssistantId) return { assistantId: fallbackAssistantId, source: 'first-assistant' }
  return { source: 'runtime-fallback' }
}

/**
 * 是否启用工具使用 (function call)。v2 assistant 不再内嵌 model；调用方
 * 从 ToolContext 拿 v2 Model 一起传入。
 */
export function isSupportedToolUse(model: Model | undefined) {
  if (!model) return false
  return isFunctionCallingModel(model)
}
