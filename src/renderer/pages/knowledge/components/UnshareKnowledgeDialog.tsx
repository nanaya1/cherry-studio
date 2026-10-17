import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@cherrystudio/ui'
import { ipcApi } from '@renderer/ipc'

export default function UnshareKnowledgeDialog({
  baseId,
  name,
  onClose,
  onUnshared
}: {
  baseId: string
  name?: string
  onClose: () => void
  onUnshared: () => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lock = useRef(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const confirm = async () => {
    if (lock.current) return false
    lock.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await ipcApi.request('enterprise.knowledge.unshare', { baseId })
      if (!active.current) return false
      if (!result.ok) throw new Error(t('knowledge.org.operation_failed'))
      onUnshared()
      onClose()
      return true
    } catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      lock.current = false
      if (active.current) setBusy(false)
    }
  }
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open && !lock.current) onClose()
      }}
      title={t('knowledge.org.unshare')}
      description={t('knowledge.org.unshare_notice')}
      content={
        <div className="space-y-2">
          {name ? <p className="break-words text-sm font-medium">{name}</p> : null}
          {error ? (
            <p role="alert" className="text-sm text-error">
              {error}
            </p>
          ) : null}
        </div>
      }
      confirmText={t('knowledge.org.confirm_unshare')}
      cancelText={t('common.cancel')}
      confirmLoading={busy}
      confirmDisabled={busy}
      cancelDisabled={busy}
      destructive
      onConfirm={confirm}
    />
  )
}
