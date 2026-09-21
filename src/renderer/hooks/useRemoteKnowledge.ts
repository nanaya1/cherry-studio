import { useCallback, useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'

import { loggerService } from '@logger'
import { ipcApi } from '@renderer/ipc'
import type {
  CreateRemoteKnowledgeServiceDto,
  RemoteKnowledgeBaseInfo,
  RemoteKnowledgeServiceInfo,
  RemoteTestConnectionResult,
  UpdateRemoteKnowledgeServiceDto
} from '@shared/data/types/remoteKnowledge'

const logger = loggerService.withContext('useRemoteKnowledge')
const SERVICE_LIST_KEY = 'remoteKnowledge.list'
const BASE_LIST_KEY = 'remoteKnowledge.list_bases'
const EMPTY_SERVICES: readonly RemoteKnowledgeServiceInfo[] = Object.freeze([])
const EMPTY_BASES: readonly RemoteKnowledgeBaseInfo[] = Object.freeze([])

async function refreshBestEffort(refresh: () => Promise<unknown>): Promise<void> {
  try {
    await refresh()
  } catch (error) {
    logger.warn('Failed to refresh remote knowledge cache after mutation', { error })
  }
}

export function useRemoteKnowledgeServices() {
  const { mutate: globalMutate } = useSWRConfig()
  const { data, error, isLoading, isValidating, mutate } = useSWR<RemoteKnowledgeServiceInfo[], Error>(
    SERVICE_LIST_KEY,
    () => ipcApi.request('remoteKnowledge.list'),
    { revalidateOnFocus: false, shouldRetryOnError: false, keepPreviousData: true }
  )
  const [pendingAction, setPendingAction] = useState<string | null>(null)

  const refreshBases = useCallback(
    () => globalMutate((key) => Array.isArray(key) && key[0] === BASE_LIST_KEY),
    [globalMutate]
  )
  const refresh = useCallback(() => mutate(), [mutate])

  const createService = useCallback(
    async (draft: CreateRemoteKnowledgeServiceDto): Promise<RemoteKnowledgeServiceInfo> => {
      setPendingAction('create')
      try {
        const created = await ipcApi.request('remoteKnowledge.create', { draft })
        await refreshBestEffort(refresh)
        await refreshBestEffort(refreshBases)
        return created
      } finally {
        setPendingAction(null)
      }
    },
    [refresh, refreshBases]
  )

  const updateService = useCallback(
    async (id: string, patch: UpdateRemoteKnowledgeServiceDto): Promise<RemoteKnowledgeServiceInfo> => {
      setPendingAction(id)
      try {
        const updated = await ipcApi.request('remoteKnowledge.update', { id, patch })
        await refreshBestEffort(refresh)
        await refreshBestEffort(refreshBases)
        return updated
      } finally {
        setPendingAction(null)
      }
    },
    [refresh, refreshBases]
  )

  const deleteService = useCallback(
    async (id: string): Promise<void> => {
      setPendingAction(id)
      try {
        await ipcApi.request('remoteKnowledge.delete', { id })
      } finally {
        await refreshBestEffort(refresh)
        await refreshBestEffort(refreshBases)
        setPendingAction(null)
      }
    },
    [refresh, refreshBases]
  )

  const testConnection = useCallback(
    async (
      input: { id: string } | { config: CreateRemoteKnowledgeServiceDto }
    ): Promise<RemoteTestConnectionResult> => {
      setPendingAction('test')
      try {
        return await ipcApi.request('remoteKnowledge.test_connection', input)
      } finally {
        setPendingAction(null)
      }
    },
    []
  )

  return {
    services: data ?? EMPTY_SERVICES,
    error,
    isLoading,
    isRefreshing: isValidating,
    pendingAction,
    refresh,
    createService,
    updateService,
    deleteService,
    testConnection
  }
}

export function useRemoteKnowledgeBases(serviceId?: string, enabled = true) {
  const input = serviceId ? { id: serviceId } : {}
  const { data, error, isLoading, isValidating, mutate } = useSWR<RemoteKnowledgeBaseInfo[], Error>(
    enabled ? [BASE_LIST_KEY, serviceId ?? null] : null,
    () => ipcApi.request('remoteKnowledge.list_bases', input),
    { revalidateOnFocus: false, shouldRetryOnError: false, keepPreviousData: true }
  )

  return {
    bases: data ?? EMPTY_BASES,
    error,
    isLoading,
    isRefreshing: isValidating,
    refresh: useCallback(() => mutate(), [mutate])
  }
}
