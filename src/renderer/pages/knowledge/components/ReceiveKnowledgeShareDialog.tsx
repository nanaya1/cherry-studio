import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Dialog, DialogContent, DialogDescription, Input, Label } from '@cherrystudio/ui'
import { ipcApi, useIpcOn } from '@renderer/ipc'
import { OrgKnowledgeReceiveShareInputSchema } from '@shared/data/types/enterpriseKnowledge'
import type { EnterpriseStatus } from '@shared/ipc/schemas/enterprise'

import { KnowledgeDialogBody, KnowledgeDialogFooter, KnowledgeDialogHeader } from './KnowledgeDialogLayout'

type Received = { baseId: string; name: string }
export default function ReceiveKnowledgeShareDialog({
  onClose,
  onReceived
}: {
  onClose: () => void
  onReceived: (result: Received) => void | Promise<void>
}) {
  const { t } = useTranslation()
  const [shareCode, setShareCode] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [signedIn, setSignedIn] = useState(false)
  const [received, setReceived] = useState<Received>()
  const [error, setError] = useState<string | null>(null)
  const status = useRef<EnterpriseStatus | undefined>(undefined)
  const epoch = useRef(0)
  const lock = useRef(false)
  const active = useRef(true)
  const applyStatus = useCallback((next: EnterpriseStatus) => {
    if (status.current && next.generation < status.current.generation) return
    if (next.generation === status.current?.generation && next.phase === status.current?.phase) return
    status.current = next
    epoch.current += 1
    lock.current = false
    setPassword('')
    setShareCode('')
    setReceived(undefined)
    setError(null)
    setBusy(false)
    setSignedIn(next.phase === 'signed-in')
  }, [])
  useIpcOn('enterprise.status_changed', applyStatus)
  useEffect(() => {
    active.current = true
    void ipcApi
      .request('enterprise.status.get')
      .then((next) => {
        if (active.current) applyStatus(next)
      })
      .catch((cause: unknown) => {
        if (active.current && !status.current) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      active.current = false
      epoch.current += 1
    }
  }, [applyStatus])
  const input = OrgKnowledgeReceiveShareInputSchema.safeParse({ shareCode, ...(password ? { password } : {}) })
  const refresh = async (value: Received) => {
    try {
      await onReceived(value)
    } catch {
      // MEA:enterprise-knowledge-page 领取已成功，目录延迟不改变领取结果。
    }
  }
  const submit = async () => {
    if (!input.success || !signedIn || lock.current || received) return
    const version = epoch.current
    lock.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await ipcApi.request('enterprise.knowledge.receive_share', input.data)
      if (!active.current || version !== epoch.current) return
      setReceived(result)
      setPassword('')
      await refresh(result)
    } catch (cause) {
      if (active.current && version === epoch.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (active.current && version === epoch.current) {
        lock.current = false
        setBusy(false)
      }
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}>
      <DialogContent closeLabel={t('common.close')}>
        <KnowledgeDialogHeader>{t('knowledge.org.add_with_code')}</KnowledgeDialogHeader>
        <DialogDescription>{t('knowledge.org.receive_description')}</DialogDescription>
        <KnowledgeDialogBody>
          <Label htmlFor="receive-code">{t('knowledge.org.share_code')}</Label>
          <Input
            id="receive-code"
            value={shareCode}
            disabled={busy || Boolean(received)}
            autoComplete="off"
            onChange={(event) => setShareCode(event.target.value)}
          />
          <Label htmlFor="receive-password">{t('knowledge.org.password_optional')}</Label>
          <Input
            id="receive-password"
            type="password"
            autoComplete="off"
            value={password}
            disabled={busy || Boolean(received)}
            onChange={(event) => setPassword(event.target.value)}
          />
          {shareCode && !input.success ? <p>{t('knowledge.org.invalid_code')}</p> : null}
          {error ? (
            <p role="alert" className="text-error">
              {error}
            </p>
          ) : null}
          {received ? <p role="status">{t('knowledge.org.received')}</p> : null}
        </KnowledgeDialogBody>
        <KnowledgeDialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.close')}
          </Button>
          {received ? (
            <Button disabled={busy} onClick={() => void refresh(received)}>
              {t('knowledge.org.refresh')}
            </Button>
          ) : (
            <Button disabled={busy || !signedIn || !input.success} onClick={() => void submit()}>
              {busy ? t('common.loading') : t('knowledge.org.receive')}
            </Button>
          )}
        </KnowledgeDialogFooter>
      </DialogContent>
    </Dialog>
  )
}
