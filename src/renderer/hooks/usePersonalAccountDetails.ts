import useSWR from 'swr'

import { ipcApi } from '@renderer/ipc'

export function usePersonalAccountDetails(enabled = true) {
  return useSWR(
    enabled ? 'enterprise.personal.details' : null,
    async () => (await ipcApi.request('enterprise.personal.details')) ?? null,
    { shouldRetryOnError: false }
  )
}
