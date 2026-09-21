import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { useProvider } from '@renderer/hooks/useProvider'
import { hasVisibleProviderApiOptions } from '@renderer/pages/settings/ProviderSettings/utils/providerApiOptions'
import {
  getFancyProviderName,
  getVisibleProviderWebsite
} from '@renderer/pages/settings/ProviderSettings/utils/providerDisplay'
import { isAwsBedrockProvider, isAzureOpenAIProvider, isVertexProvider, matchesPreset } from '@shared/utils/provider'

/** Exposes read-only provider presentation metadata used across provider settings. */
export function useProviderMeta(providerId: string) {
  const { provider } = useProvider(providerId)
  const { i18n } = useTranslation()

  return useMemo(() => {
    const hideApiInput = provider ? isAwsBedrockProvider(provider) : false
    const hideApiKeyInput = provider ? matchesPreset(provider, 'copilot') || isVertexProvider(provider) : false
    const isDmxapi = provider ? matchesPreset(provider, 'dmxapi') : false

    return {
      provider,
      fancyProviderName: provider ? getFancyProviderName(provider) : '',
      officialWebsite: getVisibleProviderWebsite(provider?.websites?.official),
      apiKeyWebsite: getVisibleProviderWebsite(provider?.websites?.apiKey),
      docsWebsite: getVisibleProviderWebsite(provider?.websites?.docs),
      modelsWebsite: getVisibleProviderWebsite(provider?.websites?.models),
      isAzureOpenAI: provider ? isAzureOpenAIProvider(provider) : false,
      isCherryIN: provider ? matchesPreset(provider, 'cherryin') : false,
      isDmxapi,
      isChineseUser: i18n.language.startsWith('zh'),
      showApiOptionsButton: provider ? hasVisibleProviderApiOptions(provider) : false,
      isApiKeyFieldVisible: !hideApiInput && !hideApiKeyInput,
      isConnectionFieldVisible: !hideApiInput && !isDmxapi
    }
  }, [i18n.language, provider])
}
