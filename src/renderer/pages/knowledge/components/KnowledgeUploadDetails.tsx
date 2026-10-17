import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from '@cherrystudio/ui'
import { ipcApi } from '@renderer/ipc'
import {
  OrgKnowledgeUploadProgressSchema,
  type OrgKnowledgeUploadProgress
} from '@shared/data/types/enterpriseKnowledge'

export function useKnowledgeUpload(baseId: string, enabled = true) {
  const [progress, setProgress] = useState<OrgKnowledgeUploadProgress | null>(null)
  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const value = await ipcApi.request('enterprise.knowledge.upload_status', { baseId })
        const parsed = OrgKnowledgeUploadProgressSchema.safeParse(value)
        if (!disposed) setProgress(parsed.success ? parsed.data : null)
      } catch {
        /* 会话失效时不展示其他账号的上传状态。 */
        if (!disposed) setProgress(null)
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 500)
      }
    }
    void poll()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [baseId, enabled])
  return progress
}

export function KnowledgeUploadProgress({ progress }: { progress: OrgKnowledgeUploadProgress }) {
  const { t } = useTranslation()
  const percentage = progress.totalBytes
    ? Math.min(100, Math.floor((progress.uploadedBytes / progress.totalBytes) * 100))
    : 0
  return (
    <section className="space-y-2 text-sm" aria-live="polite">
      <p>
        {
          {
            counting: t('knowledge.org.upload_counting'),
            uploading: t('knowledge.org.upload_uploading'),
            confirming: t('knowledge.org.upload_confirming'),
            paused: t('knowledge.org.upload_paused'),
            completed: t('knowledge.org.upload_completed')
          }[progress.phase]
        }
      </p>
      <p className="break-all">{progress.currentFile}</p>
      <progress className="h-2 w-full" max={100} value={percentage} aria-label={t('knowledge.org.upload_bytes')} />
      <p>
        {progress.uploadedBytes.toLocaleString()} / {progress.totalBytes.toLocaleString()}{' '}
        {t('knowledge.org.upload_bytes')} · {percentage}%
      </p>
      <p>
        {progress.completedFiles} / {progress.totalFiles} {t('knowledge.org.upload_files')}
      </p>
      {progress.error ? (
        <p role="alert" className="text-error">
          {progress.error}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{t('knowledge.org.upload_limitations')}</p>
    </section>
  )
}

export default function KnowledgeUploadDetails({
  baseId,
  name,
  onClose
}: {
  baseId: string
  name: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const progress = useKnowledgeUpload(baseId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const act = async (verify: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await ipcApi.request(verify ? 'enterprise.knowledge.upload_verify' : 'enterprise.knowledge.share', { baseId })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}>
      <DialogContent closeLabel={t('common.close')}>
        <DialogTitle>{t('knowledge.org.upload_details')}</DialogTitle>
        <DialogDescription>{name}</DialogDescription>
        {progress ? <KnowledgeUploadProgress progress={progress} /> : null}
        {error ? (
          <p role="alert" className="text-error">
            {error}
          </p>
        ) : null}
        {progress?.phase === 'paused' ? (
          <div className="flex gap-2">
            <Button variant="outline" disabled={busy} onClick={() => void act(true)}>
              {t('knowledge.org.upload_verify')}
            </Button>
            <Button disabled={busy} onClick={() => void act(false)}>
              {t('knowledge.org.upload_continue')}
            </Button>
          </div>
        ) : null}
        <Button variant="outline" onClick={onClose}>
          {t('common.close')}
        </Button>
      </DialogContent>
    </Dialog>
  )
}
