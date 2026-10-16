import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@cherrystudio/ui'
import { ipcApi } from '@renderer/ipc'
import type { OrgKnowledgeShare, OrgKnowledgeShareResult } from '@shared/data/types/enterpriseKnowledge'

import { canInviteAfterShare } from '../utils/sharing'
import { KnowledgeDialogBody, KnowledgeDialogFooter, KnowledgeDialogHeader } from './KnowledgeDialogLayout'
import KnowledgeInvitePanel from './KnowledgeInvitePanel'

export default function ShareKnowledgeDialog({
  baseId,
  name,
  remote = false,
  mode = 'code',
  onClose,
  onShared
}: {
  baseId: string
  name: string
  remote?: boolean
  mode?: 'code' | 'people'
  onClose: () => void
  onShared: () => void
}) {
  const { t } = useTranslation()
  const [password, setPassword] = useState('')
  const [maxViews, setMaxViews] = useState('')
  const [expiry, setExpiry] = useState('7')
  const [result, setResult] = useState<OrgKnowledgeShareResult>()
  const [share, setShare] = useState<OrgKnowledgeShare>()
  const [records, setRecords] = useState<OrgKnowledgeShare[]>([])
  const [unknown, setUnknown] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const locked = useRef(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const validPassword = password === '' || (password.length >= 4 && password.length <= 32)
  const count = Number(maxViews)
  const validCount = maxViews === '' || (/^[1-9]\d*$/.test(maxViews) && Number.isSafeInteger(count))
  const verify = async (id: string) => {
    try {
      const list = await ipcApi.request('enterprise.knowledge.shares', { baseId: id })
      if (active.current) setRecords(list.shares)
    } catch {
      // MEA:enterprise-knowledge-page 查询失败仍保留待核对状态，禁止重复创建。
    }
  }
  const submit = async () => {
    if (!validPassword || !validCount || locked.current || unknown || share) return
    locked.current = true
    setBusy(true)
    setError(null)
    let target = baseId
    try {
      if (!remote) {
        const uploaded = result ?? (await ipcApi.request('enterprise.knowledge.share', { baseId }))
        if (!active.current) return
        setResult(uploaded)
        if (!canInviteAfterShare(uploaded)) {
          setError(t('knowledge.org.upload_incomplete'))
          return
        }
        target = uploaded.shareId
      }
      const created = await ipcApi.request('enterprise.knowledge.create_share', {
        baseId: target,
        expireDays: expiry === 'never' ? null : Number(expiry),
        ...(password ? { password } : {}),
        ...(maxViews ? { maxViews: count } : {})
      })
      if (!active.current) return
      setShare(created)
      onShared()
    } catch (cause) {
      if (!active.current) return
      if (
        typeof cause === 'object' &&
        cause !== null &&
        'code' in cause &&
        cause.code === 'ORGKB_SHARE_CREATE_UNKNOWN'
      ) {
        setUnknown(true)
        setError(t('knowledge.org.create_unknown'))
        await verify(target)
      } else setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (active.current) {
        locked.current = false
        setBusy(false)
      }
    }
  }
  const copy = async () => {
    if (!share) return
    try {
      await navigator.clipboard.writeText(
        [
          name,
          `${t('knowledge.org.share_code')}: ${share.shareCode}`,
          ...(password ? [`${t('knowledge.org.password')}: ${password}`] : []),
          t('knowledge.org.receive_instructions')
        ].join('\n')
      )
      if (active.current) setCopied(true)
    } catch (cause) {
      if (active.current) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const disabled = busy || Boolean(share) || unknown
  if (mode === 'people' && !remote) {
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !busy) onClose()
        }}>
        <DialogContent closeLabel={t('common.close')}>
          <KnowledgeDialogHeader>{t('knowledge.org.invite_people')}</KnowledgeDialogHeader>
          <DialogDescription>{name}</DialogDescription>
          <KnowledgeDialogBody>
            <KnowledgeInvitePanel
              baseId={baseId}
              prepared={result}
              busy={busy}
              onBusyChange={setBusy}
              onPrepared={setResult}
              onInvited={onShared}
            />
            {result?.files.map((file, index) => (
              <p key={`${file.fileName}-${index}`}>
                {file.fileName} ·{' '}
                {t(
                  {
                    success: 'knowledge.org.file_success',
                    failure: 'knowledge.org.file_failure',
                    unknown: 'knowledge.org.file_unknown'
                  }[file.status]
                )}
                {file.error ? ` · ${file.error}` : ''}
              </p>
            ))}
          </KnowledgeDialogBody>
          <KnowledgeDialogFooter>
            <Button variant="outline" disabled={busy} onClick={onClose}>
              {t('common.close')}
            </Button>
          </KnowledgeDialogFooter>
        </DialogContent>
      </Dialog>
    )
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}>
      <DialogContent closeLabel={t('common.close')}>
        <KnowledgeDialogHeader>{t('knowledge.org.share_code')}</KnowledgeDialogHeader>
        <DialogDescription>{t('knowledge.org.share_description')}</DialogDescription>
        <KnowledgeDialogBody>
          <p className="font-medium">{name}</p>
          <p className="text-sm text-muted-foreground">{t('knowledge.org.readonly')}</p>
          <Label htmlFor="share-expiry">{t('knowledge.org.validity')}</Label>
          <Select value={expiry} onValueChange={setExpiry} disabled={disabled}>
            <SelectTrigger id="share-expiry">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[1, 7, 30, 365].map((days) => (
                <SelectItem key={days} value={String(days)}>
                  {t('knowledge.org.valid_days', { count: days })}
                </SelectItem>
              ))}
              <SelectItem value="never">{t('knowledge.org.never_expires')}</SelectItem>
            </SelectContent>
          </Select>
          <Label htmlFor="share-password">{t('knowledge.org.password_optional')}</Label>
          <Input
            id="share-password"
            type="password"
            autoComplete="new-password"
            value={password}
            disabled={disabled}
            aria-invalid={!validPassword}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Label htmlFor="share-max-views">{t('knowledge.org.max_views')}</Label>
          <Input
            id="share-max-views"
            inputMode="numeric"
            value={maxViews}
            disabled={disabled}
            aria-invalid={!validCount}
            onChange={(e) => setMaxViews(e.target.value)}
          />
          {!validPassword || !validCount ? <p role="alert">{t('knowledge.org.invalid_settings')}</p> : null}
          {result?.files.map((file, index) => (
            <p key={`${file.fileName}-${index}`}>
              {file.fileName} ·{' '}
              {t(
                {
                  success: 'knowledge.org.file_success',
                  failure: 'knowledge.org.file_failure',
                  unknown: 'knowledge.org.file_unknown'
                }[file.status]
              )}
              {file.error ? ` · ${file.error}` : ''}
            </p>
          ))}
          {share ? (
            <div className="space-y-2">
              <p>{t('knowledge.org.share_code')}</p>
              <p className="break-all font-mono">{share.shareCode}</p>
              {password ? (
                <p>
                  {t('knowledge.org.password')}: {password}
                </p>
              ) : null}
              <p>{share.expiresAt ?? t('knowledge.org.never_expires')}</p>
            </div>
          ) : null}
          {unknown ? (
            <div className="space-y-2">
              <Button variant="outline" disabled={busy} onClick={() => void verify(result?.shareId ?? baseId)}>
                {t('knowledge.org.refresh')}
              </Button>
              {records.map((record) => (
                <p key={record.id} className="break-all">
                  {record.shareCode} · {record.createdAt}
                </p>
              ))}
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-error">
              {error}
            </p>
          ) : null}
          {copied ? <p role="status">{t('knowledge.org.copied')}</p> : null}
          {/* 指定人邀请移至独立入口，分享码弹窗仅管理分享码。
          {!remote ? (
            <KnowledgeInvitePanel baseId={baseId} prepared={result} busy={busy}
              onBusyChange={setBusy} onPrepared={setResult} onInvited={onShared} />
          ) : null}
          */}
        </KnowledgeDialogBody>
        <KnowledgeDialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('common.close')}
          </Button>
          {share ? (
            <Button onClick={() => void copy()}>{t('knowledge.org.copy_text')}</Button>
          ) : (
            <Button
              disabled={disabled || !validPassword || !validCount || Boolean(result && !canInviteAfterShare(result))}
              onClick={() => void submit()}>
              {busy ? t('common.loading') : t('knowledge.org.generate_code')}
            </Button>
          )}
        </KnowledgeDialogFooter>
      </DialogContent>
    </Dialog>
  )
}
