// import { Inbox, Link, RefreshCw } from 'lucide-react'
import { Link, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Dialog, DialogContent, DialogDescription } from '@cherrystudio/ui'
import { ipcApi } from '@renderer/ipc'

import { useOrgKnowledgeResource } from '../hooks/useOrgKnowledgeResource'
import { KnowledgeDialogHeader } from './KnowledgeDialogLayout'

export default function KnowledgeInvitations({
  onChanged,
  onAddWithCode
}: {
  onChanged: () => Promise<void>
  onAddWithCode?: () => void
}) {
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
        <DialogContent
          closeLabel={t('common.close')}
          className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto rounded-2xl p-0 sm:max-w-[560px] [&_[data-slot=dialog-close]]:grid [&_[data-slot=dialog-close]]:size-11 [&_[data-slot=dialog-close]]:place-items-center">
          <div className="space-y-3 px-7 pt-8 pb-6">
            <KnowledgeDialogHeader className="[&_[data-slot=dialog-title]]:text-xl">
              {t('knowledge.org.invitations_title')}
            </KnowledgeDialogHeader>
            <div className="flex items-center justify-between gap-3">
              <DialogDescription className="min-w-0 flex-1 text-sm leading-relaxed">
                {loading
                  ? t('common.loading')
                  : t('knowledge.org.invitations_summary', { count: data?.invitations.length ?? 0 })}
              </DialogDescription>
              <Button
                variant="ghost"
                className="min-h-11 shrink-0 text-xs text-muted-foreground"
                disabled={busy || loading}
                onClick={() => {
                  setActionError(null)
                  void refresh()
                }}>
                <RefreshCw className="size-3.5" aria-hidden="true" />
                {t('knowledge.org.refresh')}
              </Button>
            </div>
          </div>
          <div className="space-y-4 px-7 pb-7">
            {loading ? <p role="status">{t('common.loading')}</p> : null}
            {error || actionError ? (
              <p role="alert" className="text-error">
                {error || actionError}
              </p>
            ) : null}
            {!loading && data?.invitations.length === 0 ? (
              <p className="text-muted-foreground">{t('knowledge.org.empty_invitations')}</p>
            ) : null}
            {/* 保留原邀请行，改为信息与操作分层的卡片。
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
          */}
            {data?.invitations.map((invitation) => (
              <article key={invitation.id} className="flex items-center gap-3 rounded-xl border border-border p-4">
                <div className="min-w-0 flex-1 space-y-2">
                  <h3 className="break-words text-base font-semibold">{invitation.name}</h3>
                  <p className="break-words text-xs text-muted-foreground">
                    {t('knowledge.org.invited_by', { name: invitation.inviter })}
                  </p>
                  <p className="text-xs text-muted-foreground">{t('knowledge.org.readonly')}</p>
                  {invitation.expires ? (
                    <p className="text-xs text-muted-foreground">
                      {t('knowledge.org.validity')}: {invitation.expires}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {/* 操作移到文案右侧，原底部标签保留。
                  <span className="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
                    <Inbox className="size-4" aria-hidden="true" />
                    {t('knowledge.org.knowledge_invitation')}
                  </span>
                  */}
                  <Button
                    variant="ghost"
                    className="min-h-11"
                    disabled={busy}
                    onClick={() => void respond(invitation.id, false)}>
                    {t('knowledge.org.decline')}
                  </Button>
                  <Button className="min-h-11" disabled={busy} onClick={() => void respond(invitation.id, true)}>
                    {t('knowledge.org.accept')}
                  </Button>
                </div>
              </article>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-7 py-5">
            <p className="text-xs text-muted-foreground">{t('knowledge.org.invitation_access_hint')}</p>
            {onAddWithCode ? (
              <Button
                variant="outline"
                className="min-h-11"
                disabled={busy}
                onClick={() => {
                  setOpen(false)
                  onAddWithCode()
                }}>
                <Link className="size-4" aria-hidden="true" />
                {t('knowledge.org.add_with_code')}
              </Button>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
