import { useCallback, useEffect, useRef, useState } from 'react'

import { ipcApi, useIpcOn } from '@renderer/ipc'
import type { OrgKnowledgeCatalog } from '@shared/data/types/enterpriseKnowledge'
import type { EnterpriseStatus } from '@shared/ipc/schemas/enterprise'

const EMPTY_CATALOG: OrgKnowledgeCatalog = { public: [], shared: [], owned: [] }

export function useOrgKnowledge() {
  const [catalog, setCatalog] = useState<OrgKnowledgeCatalog>(EMPTY_CATALOG)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const statusRef = useRef<EnterpriseStatus | null>(null)
  const requestRef = useRef(0)

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current
    if (statusRef.current?.phase !== 'signed-in') {
      setCatalog(EMPTY_CATALOG)
      setLoading(false)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const next = await ipcApi.request('enterprise.knowledge.catalog')
      if (requestId === requestRef.current) setCatalog(next)
    } catch (cause) {
      if (requestId !== requestRef.current) return
      setCatalog(EMPTY_CATALOG)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (requestId === requestRef.current) setLoading(false)
    }
  }, [])

  const applyStatus = useCallback(
    (next: EnterpriseStatus) => {
      const previous = statusRef.current
      if (previous && next.generation < previous.generation) return
      if (previous?.generation === next.generation && previous.phase === next.phase) return
      statusRef.current = next
      requestRef.current += 1
      setCatalog(EMPTY_CATALOG)
      setError(null)
      setLoading(false)
      void refresh()
    },
    [refresh]
  )

  useIpcOn('enterprise.status_changed', applyStatus)

  useEffect(() => {
    let active = true
    void ipcApi
      .request('enterprise.status.get')
      .then((next) => {
        if (active) applyStatus(next)
      })
      .catch((cause: unknown) => {
        if (!active || statusRef.current) return
        setLoading(false)
        setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      active = false
      requestRef.current += 1
    }
  }, [applyStatus])

  return { catalog, loading, error, refresh }
}
