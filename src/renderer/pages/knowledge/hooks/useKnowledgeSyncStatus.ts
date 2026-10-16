import { useCallback, useEffect, useRef, useState } from 'react'

import { useDataChange } from '@data/hooks/useDataApi'
import { ipcApi, useIpcOn } from '@renderer/ipc'
import type { OrgKnowledgeSyncStatus } from '@shared/data/types/enterpriseKnowledge'
import type { EnterpriseStatus } from '@shared/ipc/schemas/enterprise'

export function useKnowledgeSyncStatus(baseId: string, navigationVersion = 0) {
  const [status, setStatus] = useState<OrgKnowledgeSyncStatus>()
  const [error, setError] = useState<string>()
  const session = useRef<EnterpriseStatus | null>(null)
  const request = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const refresh = useCallback(async () => {
    const id = ++request.current
    setStatus(undefined)
    setError(undefined)
    if (!baseId || session.current?.phase !== 'signed-in') return
    try {
      const next = await ipcApi.request('enterprise.knowledge.sync_status', { baseId })
      if (id === request.current) setStatus(next)
    } catch (cause) {
      if (id === request.current) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [baseId])
  const applySession = useCallback(
    (next: EnterpriseStatus) => {
      const previous = session.current
      if (
        previous &&
        (next.generation < previous.generation ||
          (next.generation === previous.generation && next.phase === previous.phase))
      )
        return
      session.current = next
      void refresh()
    },
    [refresh]
  )
  useIpcOn('enterprise.status_changed', applySession)
  useEffect(() => {
    let active = true
    void ipcApi
      .request('enterprise.status.get')
      .then((next) => {
        if (active) {
          if (session.current?.generation === next.generation && session.current.phase === next.phase) void refresh()
          else applySession(next)
        }
      })
      .catch((cause: unknown) => {
        if (active && !session.current) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      active = false
      request.current += 1
      clearTimeout(timer.current)
    }
  }, [applySession, refresh, navigationVersion])
  useDataChange(
    ['/knowledge-bases', '/knowledge-bases/:id/items'],
    () => {
      request.current += 1
      setStatus(undefined)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => void refresh(), 300)
    },
    { routeParams: { id: baseId } }
  )
  return { status, error, refresh }
}
