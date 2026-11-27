import useSWR from 'swr'

import { ipcApi } from '@renderer/ipc'
import { XUELANG_PROVIDER_ID } from '@shared/data/presets/xuelang'

export function useCoworkManagedProvider(providerId: string): boolean {
  const { data } = useSWR(
    providerId === XUELANG_PROVIDER_ID ? 'enterprise.personal.status' : null,
    () => ipcApi.request('enterprise.personal.status'),
    { shouldRetryOnError: false }
  )
  return providerId === XUELANG_PROVIDER_ID && data?.signedIn !== false
}
