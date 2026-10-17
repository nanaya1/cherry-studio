import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Checkbox, ConfirmDialog } from '@cherrystudio/ui'
import { ipcApi } from '@renderer/ipc'

export default function UnshareKnowledgeDialog({
  baseId,
  name,
  deleteLocal = false,
  activityBlocked = false,
  checkingActivity = false,
  onClose,
  onUnshared
}: {
  baseId: string
  name?: string
  deleteLocal?: boolean
  activityBlocked?: boolean
  checkingActivity?: boolean
  onClose: () => void
  onUnshared: () => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ restored: number; missing: Array<{ id: string; name: string }> }>()
  const [confirmMissing, setConfirmMissing] = useState(false)
  const [confirmDevicesStopped, setConfirmDevicesStopped] = useState(false)
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
      // const result = await ipcApi.request('enterprise.knowledge.unshare', { baseId })
      // if (!preview) {
      if (!deleteLocal && !preview) {
        const prepared = await ipcApi.request('enterprise.knowledge.unshare_preview', { baseId })
        if (active.current) setPreview(prepared)
        return false
      }
      const result = await ipcApi.request('enterprise.knowledge.unshare', {
        baseId,
        confirmMissing,
        confirmDevicesStopped,
        ...(deleteLocal ? { deleteLocal: true } : {})
      })
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
      title={t(deleteLocal ? 'knowledge.context.delete_confirm_title' : 'knowledge.org.unshare')}
      description={t(deleteLocal ? 'knowledge.org.delete_shared_notice' : 'knowledge.org.unshare_notice')}
      content={
        <div className="space-y-2">
          {name ? <p className="break-words text-sm font-medium">{name}</p> : null}
          {checkingActivity ? <p role="status">{t('common.loading')}</p> : null}
          {activityBlocked ? <p role="alert">{t('knowledge.org.unshare_blocked_activity')}</p> : null}
          {preview ? (
            <>
              <p>{t('knowledge.org.recovery_count', { count: preview.restored })}</p>
              {preview.missing.length ? (
                <>
                  <ul>
                    {preview.missing.map((file) => (
                      <li key={file.id}>{file.name}</li>
                    ))}
                  </ul>
                  <label className="flex gap-2">
                    <Checkbox
                      checked={confirmMissing}
                      onCheckedChange={(checked) => setConfirmMissing(checked === true)}
                    />
                    {t('knowledge.org.recovery_missing_confirm')}
                  </label>
                </>
              ) : null}
              <label className="flex gap-2">
                <Checkbox
                  checked={confirmDevicesStopped}
                  onCheckedChange={(checked) => setConfirmDevicesStopped(checked === true)}
                />
                {t('knowledge.org.recovery_devices_confirm')}
              </label>
            </>
          ) : null}
          {deleteLocal ? (
            <label className="flex gap-2">
              <Checkbox
                checked={confirmDevicesStopped}
                onCheckedChange={(checked) => setConfirmDevicesStopped(checked === true)}
              />
              {t('knowledge.org.recovery_devices_confirm')}
            </label>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-error">
              {error}
            </p>
          ) : null}
        </div>
      }
      confirmText={t(
        // preview ? (deleteLocal ? 'common.delete' : 'knowledge.org.confirm_unshare') : 'knowledge.org.recovery_prepare'
        deleteLocal ? 'common.delete' : preview ? 'knowledge.org.confirm_unshare' : 'knowledge.org.recovery_prepare'
      )}
      cancelText={t('common.cancel')}
      confirmLoading={busy}
      confirmDisabled={
        busy ||
        checkingActivity ||
        activityBlocked ||
        // Boolean(preview && (!confirmDevicesStopped || (preview.missing.length && !confirmMissing)))
        (deleteLocal
          ? !confirmDevicesStopped
          : Boolean(preview && (!confirmDevicesStopped || (preview.missing.length && !confirmMissing))))
      }
      cancelDisabled={busy}
      destructive
      onConfirm={confirm}
    />
  )
}
