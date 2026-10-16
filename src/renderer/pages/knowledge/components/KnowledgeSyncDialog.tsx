import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Checkbox, Dialog, DialogContent, DialogDescription, Label } from '@cherrystudio/ui'
import { useDataChange } from '@data/hooks/useDataApi'
import { ipcApi, useIpcOn } from '@renderer/ipc'
import type { OrgKnowledgeSyncApply, OrgKnowledgeSyncPreview } from '@shared/data/types/enterpriseKnowledge'
import type { EnterpriseStatus } from '@shared/ipc/schemas/enterprise'

import { KnowledgeDialogBody, KnowledgeDialogFooter, KnowledgeDialogHeader } from './KnowledgeDialogLayout'

const changeLabels = {
  add: 'knowledge.sync.change.add',
  update: 'knowledge.sync.change.update',
  rename: 'knowledge.sync.change.rename',
  delete: 'knowledge.sync.change.delete'
} as const
const resultLabels = {
  complete: 'knowledge.sync.result.complete',
  partial: 'knowledge.sync.result.partial',
  unknown: 'knowledge.sync.result.unknown'
} as const
const fileLabels = {
  success: 'knowledge.sync.file.success',
  failure: 'knowledge.sync.file.failure',
  unknown: 'knowledge.sync.file.unknown'
} as const

export default function KnowledgeSyncDialog({
  baseId,
  name,
  onClose,
  onSynced
}: {
  baseId: string
  name: string
  onClose: () => void
  onSynced: () => void
}) {
  const { t } = useTranslation()
  const [plan, setPlan] = useState<OrgKnowledgeSyncPreview>()
  const [result, setResult] = useState<OrgKnowledgeSyncApply>()
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const session = useRef<EnterpriseStatus | null>(null)
  const request = useRef(0)
  const locked = useRef(false)
  const sourceVersion = useRef(0)
  const [ready, setReady] = useState(false)

  const applySession = useCallback((next: EnterpriseStatus) => {
    const previous = session.current
    if (
      previous &&
      (next.generation < previous.generation ||
        (next.generation === previous.generation && next.phase === previous.phase))
    )
      return
    session.current = next
    request.current += 1
    locked.current = false
    setPlan(undefined)
    setResult(undefined)
    setConfirmed(false)
    setError(undefined)
    setBusy(false)
    setReady(next.phase === 'signed-in')
  }, [])
  useIpcOn('enterprise.status_changed', applySession)
  useEffect(() => {
    let active = true
    void ipcApi
      .request('enterprise.status.get')
      .then((status) => {
        if (active) applySession(status)
      })
      .catch((cause: unknown) => {
        if (active && !session.current) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      active = false
      request.current += 1
    }
  }, [baseId, applySession])

  useDataChange(
    ['/knowledge-bases', '/knowledge-bases/:id/items'],
    () => {
      sourceVersion.current += 1
      setPlan(undefined)
      setConfirmed(false)
      setError(t('knowledge.sync.source_changed'))
    },
    { routeParams: { id: baseId } }
  )

  const preview = useCallback(async () => {
    if (locked.current || session.current?.phase !== 'signed-in') return
    locked.current = true
    const id = ++request.current
    const version = sourceVersion.current
    setBusy(true)
    setPlan(undefined)
    setResult(undefined)
    setError(undefined)
    setConfirmed(false)
    try {
      const next = await ipcApi.request('enterprise.knowledge.sync_preview', { baseId })
      if (id === request.current && version === sourceVersion.current) setPlan(next)
    } catch (cause) {
      if (id === request.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (id === request.current) {
        locked.current = false
        setBusy(false)
      }
    }
  }, [baseId])
  useEffect(() => {
    if (ready) void preview()
  }, [ready, preview])

  const blocked = !plan || !['pending', 'shared', 'failed'].includes(plan.status)
  const deletes = plan?.changes.some((change) => change.kind === 'delete') ?? false
  const apply = async () => {
    if (locked.current || blocked || !plan.changes.length || (deletes && !confirmed)) return
    locked.current = true
    const id = ++request.current
    const planId = plan.planId
    setBusy(true)
    setError(undefined)
    setPlan(undefined)
    try {
      const next = await ipcApi.request('enterprise.knowledge.sync_apply', {
        baseId,
        planId,
        confirmDeletes: confirmed
      })
      if (id !== request.current) return
      setResult(next)
      onSynced()
    } catch (cause) {
      if (id === request.current) {
        setError(`${cause instanceof Error ? cause.message : String(cause)} · ${t('knowledge.sync.preview_required')}`)
        onSynced()
      }
    } finally {
      if (id === request.current) {
        locked.current = false
        setBusy(false)
        setConfirmed(false)
      }
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}>
      <DialogContent closeLabel={t('common.close')} className="max-h-[85vh] overflow-y-auto">
        <KnowledgeDialogHeader>{t('knowledge.sync.title')}</KnowledgeDialogHeader>
        <DialogDescription>{t('knowledge.sync.description')}</DialogDescription>
        <KnowledgeDialogBody>
          <p className="font-medium">{name}</p>
          <p className="text-sm text-muted-foreground">{t('knowledge.sync.non_atomic')}</p>
          {plan && blocked ? (
            <p role="alert" className="text-warning">
              {t('knowledge.sync.blocked')}
            </p>
          ) : null}
          {plan?.warnings.map((warning, index) => (
            <p key={index} className="text-sm text-warning">
              {warning}
            </p>
          ))}
          {plan?.changes.length === 0 && !blocked ? <p>{t('knowledge.sync.no_changes')}</p> : null}
          {plan ? (
            <ul className="space-y-2">
              {plan.changes.map((change) => (
                <li key={`${change.itemId}-${change.kind}`} className="flex gap-2 text-sm">
                  <span className="shrink-0 text-muted-foreground">{t(changeLabels[change.kind])}</span>
                  <span className="break-all">{change.fileName}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {deletes ? (
            <div className="flex items-start gap-2">
              <Checkbox
                id="sync-deletes"
                checked={confirmed}
                disabled={busy || blocked}
                onCheckedChange={(value) => setConfirmed(value === true)}
              />
              <Label htmlFor="sync-deletes">{t('knowledge.sync.confirm_deletes')}</Label>
            </div>
          ) : null}
          {result ? (
            <div className="space-y-2" role="status">
              <p>{t(resultLabels[result.status])}</p>
              <ul className="space-y-2">
                {result.files.map((file) => (
                  <li key={`${file.itemId}-${file.kind}`} className="text-sm">
                    {file.fileName} · {t(changeLabels[file.kind])} · <span>{t(fileLabels[file.status])}</span>
                    {file.error ? <p className="break-words text-error">{file.error}</p> : null}
                  </li>
                ))}
              </ul>
              <p className="text-sm text-muted-foreground">{t('knowledge.sync.unknown_help')}</p>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="break-words text-error">
              {error}
            </p>
          ) : null}
        </KnowledgeDialogBody>
        <KnowledgeDialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button variant="outline" disabled={busy || !ready} onClick={() => void preview()}>
            {t('knowledge.sync.preview')}
          </Button>
          {!result ? (
            <Button
              disabled={busy || blocked || !plan?.changes.length || (deletes && !confirmed)}
              onClick={() => void apply()}>
              {busy ? t('common.loading') : t('knowledge.sync.apply')}
            </Button>
          ) : null}
        </KnowledgeDialogFooter>
      </DialogContent>
    </Dialog>
  )
}
