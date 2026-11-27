import { CHERRY_CLOUD_PROVIDER_ID, CHERRYAI_PROVIDER_ID } from '@shared/data/presets/cherryai'
import { LOCAL_EMBEDDING_PROVIDER_ID } from '@shared/data/presets/localEmbedding'
import type { Provider } from '@shared/data/types/provider'
import { ENABLE_CHERRY_OFFICIAL_SERVICES } from '@shared/utils/constants'
import { isCherryAIProvider, matchesPreset } from '@shared/utils/provider'

const VISIBLE_PRESET_PROVIDER_IDS = ['xuelang', 'deepseek', 'zhipu', 'dashscope']

export function isProviderVisibleInMea(provider: Pick<Provider, 'id' | 'presetProviderId'>): boolean {
  return (
    ENABLE_CHERRY_OFFICIAL_SERVICES ||
    ![CHERRYAI_PROVIDER_ID, CHERRY_CLOUD_PROVIDER_ID, 'cherryin'].some((id) => matchesPreset(provider, id))
  )
}

export function isProviderSettingsListVisibleProvider(provider: Provider): boolean {
  // The local embedding provider is download-managed, so exposing generic
  // edit/disable/delete controls would bypass its weight lifecycle checks.
  if (
    !isProviderVisibleInMea(provider) ||
    isCherryAIProvider(provider) ||
    provider.id === LOCAL_EMBEDDING_PROVIDER_ID
  ) {
    return false
  }
  // Xuelang build: only whitelisted presets are listed; user-created
  // providers (no preset linkage) stay visible.
  return provider.presetProviderId == null || VISIBLE_PRESET_PROVIDER_IDS.some((id) => matchesPreset(provider, id))
}
