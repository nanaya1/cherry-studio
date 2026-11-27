import { type AiPlugin, resolveLanguageModel } from '@cherrystudio/ai-core'
import type { ServingCredentialReceipt } from '@main/ai/provider/credential'
import type { ResolvedEndpoint } from '@main/ai/provider/endpoint'
import { modelService } from '@main/data/services/ModelService'
import { providerService } from '@main/data/services/ProviderService'
import type { CompactionSink } from '@shared/ai/compaction'
import { XUELANG_PROVIDER_ID } from '@shared/data/presets/xuelang'
import type { Assistant } from '@shared/data/types/assistant'
import { type Model, parseUniqueModelId } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'
import { getRawModelId } from '@shared/utils/model'

import type { AiChatRequest, AppProviderSettingsMap } from '../../../types'
import { buildAgentParams } from '../params/buildAgentParams'
import type { RequestFeature } from '../params/feature'
import type { FallbackResolver } from './createRetryableWrap'
import { resolveApiKeyFallbacks } from './resolveApiKeyFallbacks'

export interface BuildApiKeyFallbackModelsArgs {
  request: AiChatRequest & { messageId?: string; compactionSink?: CompactionSink }
  provider: Provider
  model: Model
  assistant: Assistant | undefined
  signal: AbortSignal | undefined
  extraFeatures: readonly RequestFeature[]
  primaryCredentialReceipt: ServingCredentialReceipt
  resolvedEndpoint?: ResolvedEndpoint
  createUsagePlugin: (credentialReceipt: ServingCredentialReceipt) => AiPlugin
}

/** Lazily builds the same provider/model with each remaining enabled key. */
export function buildApiKeyFallbackModels(args: BuildApiKeyFallbackModelsArgs): FallbackResolver[] {
  if (args.request.apiKeyOverride !== undefined || !('id' in args.primaryCredentialReceipt)) return []
  const managed = args.provider.id === XUELANG_PROVIDER_ID
  const endpointType = args.resolvedEndpoint?.endpointType
  const modelId = managed ? getRawModelId(args.model) : undefined
  const candidates = managed
    ? endpointType && modelId
      ? providerService.getXuelangApiKeys(modelId, endpointType)
      : []
    : providerService.getApiKeys(args.provider.id, { enabled: true })
  const keys = resolveApiKeyFallbacks(candidates, args.primaryCredentialReceipt)
  return keys.map((key) => async () => {
    const provider = managed ? providerService.getByProviderId(args.provider.id) : args.provider
    const model = managed ? modelService.getByKey(provider.id, parseUniqueModelId(args.model.id).modelId) : args.model
    if (
      managed &&
      (!provider.isEnabled || !model.isEnabled || model.isDeprecated || getRawModelId(model) !== modelId)
    ) {
      return null
    }
    if (
      managed &&
      endpointType &&
      modelId &&
      !providerService
        .getXuelangApiKeys(modelId, endpointType)
        .some((candidate) => candidate.id === key.id && candidate.key === key.key)
    ) {
      return null
    }
    const repairUsagePlugins: { current?: AiPlugin[] } = {}
    const built = await buildAgentParams({
      request: { ...args.request, apiKeyOverride: key.key },
      resolvedEndpoint: managed ? args.resolvedEndpoint : undefined,
      signal: args.signal,
      provider,
      model,
      assistant: args.assistant,
      extraFeatures: args.extraFeatures,
      getRepairUsagePlugins: () => repairUsagePlugins.current ?? [],
      compactionSink: args.request.compactionSink
    })
    const usagePlugin = args.createUsagePlugin(built.credentialReceipt)
    repairUsagePlugins.current = [usagePlugin]
    const resolved = await resolveLanguageModel<AppProviderSettingsMap>(
      built.sdkConfig.providerId,
      built.sdkConfig.providerSettings,
      built.sdkConfig.modelId,
      [...built.plugins, usagePlugin]
    )
    return { model: resolved, repairToolCall: built.options.repairToolCall }
  })
}
