import { endpointImpliedCapability } from '@cherrystudio/provider-registry'
import { ENDPOINT_TYPE, type Model } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'
import { getRawModelId } from '@shared/utils/model'

export { getProviderDisplayName } from '@renderer/utils/naming'

export function hasUsableXuelangChatRoute(model: Model, provider: Provider): boolean {
  if (!provider.isEnabled || !model.isEnabled || model.isDeprecated) return false

  const modelId = getRawModelId(model)
  const endpointTypes = model.endpointTypes?.length ? model.endpointTypes : [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]
  return provider.apiKeys.some(({ isEnabled, managedRoutes }) => {
    if (!isEnabled || !managedRoutes) return false

    return managedRoutes.models.some(
      (route) =>
        route.id === modelId &&
        route.endpointTypes.some(
          (type) =>
            endpointTypes.includes(type) &&
            !endpointImpliedCapability(type) &&
            Boolean(managedRoutes.endpointConfigs[type]?.baseUrl)
        )
    )
  })
}
