import { useEffect, useEffectEvent, useRef, useState } from 'react'

import { loggerService } from '@logger'
import { ipcApi } from '@renderer/ipc'
import type { EnterpriseVerificationStatus } from '@shared/ipc/schemas/enterprise'

const logger = loggerService.withContext('EnterpriseVerificationStatus')

// MEA:profile-online-login Subscribe before querying; generations also change for harmless group updates.
export function useEnterpriseVerificationStatus(): EnterpriseVerificationStatus | null {
  const [status, setStatus] = useState<EnterpriseVerificationStatus | null>(null)
  const latest = useRef<EnterpriseVerificationStatus | null>(null)
  const retiredOwners = useRef(new Set<string>())

  useEffect(() => {
    let active = true
    let receivedEvent = false
    const apply = (next: EnterpriseVerificationStatus, initial = false) => {
      if (!active || retiredOwners.current.has(next.owner)) return
      const current = latest.current
      if (current) {
        if (next.owner === current.owner && next.revision <= current.revision) return
        if (next.owner !== current.owner) {
          if (initial && receivedEvent) {
            retiredOwners.current.add(next.owner)
            return
          }
          retiredOwners.current.add(current.owner)
        }
      }
      latest.current = next
      setStatus(next)
    }
    const unsubscribe = ipcApi.on('enterprise.verification_changed', (next) => {
      receivedEvent = true
      apply(next)
    })
    void ipcApi.request('enterprise.verification.get').then(
      (next) => apply(next, true),
      (error) => {
        if (active) logger.warn('Failed to read profile verification status', { error })
      }
    )
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return status
}

/** Refresh mounted readers once after the same account recovers, not on every healthy poll. */
export function useEnterpriseVerificationRecovery(onRecovery: () => void, enabled = true): void {
  const status = useEnterpriseVerificationStatus()
  const previous = useRef<EnterpriseVerificationStatus | null>(null)
  const pendingOwner = useRef<string | null>(null)
  const recover = useEffectEvent(onRecovery)

  useEffect(() => {
    if (!status) return
    const last = previous.current
    previous.current = status
    if (last?.owner !== status.owner || status.state === 'blocked' || status.state === 'switching') {
      pendingOwner.current = null
    }
    if (last?.owner === status.owner && last.state === 'unavailable' && status.state === 'verified') {
      pendingOwner.current = status.owner
    }
    if (enabled && status.state === 'verified' && pendingOwner.current === status.owner) {
      pendingOwner.current = null
      recover()
    }
  }, [enabled, status])
}
