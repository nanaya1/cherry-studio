import { LOCAL_EMBEDDING_PROVIDER_ID } from '@shared/data/presets/localEmbedding'
import { isManagedXuelangProviderId } from '@shared/data/presets/xuelang'
import type { Provider } from '@shared/data/types/provider'
import { isCherryAIProvider, matchesPreset } from '@shared/utils/provider'

const VISIBLE_PRESET_PROVIDER_IDS = ['xuelang', 'deepseek', 'zhipu']

export function isProviderSettingsListVisibleProvider(provider: Provider): boolean {
  // The local embedding provider is download-managed, so exposing generic
  // edit/disable/delete controls would bypass its weight lifecycle checks.
  if (
    isCherryAIProvider(provider) ||
    isManagedXuelangProviderId(provider.id) ||
    provider.id === LOCAL_EMBEDDING_PROVIDER_ID
  ) {
    return false
  }
  // Xuelang build: only whitelisted presets are listed; user-created
  // providers (no preset linkage) stay visible.
  return provider.presetProviderId == null || VISIBLE_PRESET_PROVIDER_IDS.some((id) => matchesPreset(provider, id))
}
