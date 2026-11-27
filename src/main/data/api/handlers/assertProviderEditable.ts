import { isPersonalAccountSpace } from '@main/core/preboot/userDataLocation'
import { DataApiErrorFactory } from '@shared/data/api/errors'
import { XUELANG_PROVIDER_ID } from '@shared/data/presets/xuelang'

export function isCoworkManagedProvider(providerId: string): boolean {
  return providerId === XUELANG_PROVIDER_ID && isPersonalAccountSpace()
}

export function assertProviderEditable(providerId: string): void {
  if (isCoworkManagedProvider(providerId)) {
    throw DataApiErrorFactory.invalidOperation('edit provider configuration', 'Cowork manages this provider')
  }
}
