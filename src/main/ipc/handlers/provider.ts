import { setProviderLogo } from '@main/services/entityLogo'
import { DataApiErrorFactory } from '@shared/data/api/errors'
import { XUELANG_PROVIDER_ID } from '@shared/data/presets/xuelang'
import type { providerRequestSchemas } from '@shared/ipc/schemas/provider'
import type { IpcHandlersFor } from '@shared/ipc/types'

/**
 * Provider imperative command handlers. Thin adapter: `provider.set_logo`
 * delegates the create→bind→compensate orchestration to `setProviderLogo`.
 */
export const providerHandlers: IpcHandlersFor<typeof providerRequestSchemas> = {
  'provider.set_logo': async ({ providerId, image }) => {
    if (providerId === XUELANG_PROVIDER_ID) {
      throw DataApiErrorFactory.invalidOperation('set provider logo', 'managed provider configuration is read-only')
    }
    return setProviderLogo(providerId, image)
  }
}
