import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Dialog, DialogContent } from '@cherrystudio/ui'
import { ipcApi } from '@renderer/ipc'

import { useOrgKnowledgeResource } from '../hooks/useOrgKnowledgeResource'
import { KnowledgeDialogHeader } from './KnowledgeDialogLayout'

export default function KnowledgeInvitations({ onChanged }: { onChanged: () => Promise<void> }) {
  const { t } = useTranslation()
  const load = useCallback(() => ipcApi.request('enterprise.knowledge.invitations'), [])
  const { data, loading, error, refresh } = useOrgKnowledgeResource(load)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const lock = useRef(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const respond = async (invitationId: string, accept: boolean) => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setActionError(null)
    try {
      if (accept) await ipcApi.request('enterprise.knowledge.accept', { invitationId })
      else {
        const result = await ipcApi.request('enterprise.knowledge.decline', { invitationId })
        if (!result.ok) throw new Error(t('knowledge.org.operation_failed'))
      }
      if (!active.current) return
      await Promise.all([refresh(), onChanged()])
    } catch (cause) {
      if (active.current) setActionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      lock.current = false
      if (active.current) setBusy(false)
    }
  }
  return (
    <>
      <Button variant="outline" className="w-full" onClick={() => setOpen(true)}>
        {t('knowledge.org.invitations')}
        {!loading && !error && data && data.invitations.length > 0 ? ` (${data.invitations.length})` : ''}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[80vh] overflow-y-auto" aria-describedby={undefined}>
          <KnowledgeDialogHeader>{t('knowledge.org.invitations')}</KnowledgeDialogHeader>
          {/* 原内嵌 section 改由独立弹窗承载。 */}
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              disabled={busy || loading}
              onClick={() => {
                setActionError(null)
                void refresh()
              }}>
              {t('knowledge.org.refresh')}
            </Button>
          </div>
          {loading ? <p role="status">{t('common.loading')}</p> : null}
          {error || actionError ? (
            <p role="alert" className="text-error">
              {error || actionError}
            </p>
          ) : null}
          {!loading && data?.invitations.length === 0 ? (
            <p className="text-muted-foreground">{t('knowledge.org.empty_invitations')}</p>
          ) : null}
          {data?.invitations.map((invitation) => (
            <div key={invitation.id} className="flex flex-wrap items-center gap-3 rounded border border-border p-3">
              <div className="min-w-0 flex-1">
                <p>{invitation.name}</p>
                <p className="text-sm text-muted-foreground">
                  {invitation.inviter} · {invitation.role}
                  {invitation.expires ? ` · ${invitation.expires}` : ''}
                </p>
              </div>
              <Button variant="outline" disabled={busy} onClick={() => void respond(invitation.id, false)}>
                {t('knowledge.org.decline')}
              </Button>
              <Button disabled={busy} onClick={() => void respond(invitation.id, true)}>
                {t('knowledge.org.accept')}
              </Button>
            </div>
          ))}
        </DialogContent>
      </Dialog>
    </>
  )
}
