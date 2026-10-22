// import { BookOpen, Check, Copy, LockKeyhole } from 'lucide-react'
import { Check, Copy } from 'lucide-react'
// import { Checkbox } from '@cherrystudio/ui' // 首次分享必须上传源文件，暂不允许关闭
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
import { KnowledgeUploadProgress, useKnowledgeUpload } from './KnowledgeUploadDetails'

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
  const upload = useKnowledgeUpload(baseId, !remote)
  const [uploadStarted, setUploadStarted] = useState(false)
  useEffect(() => {
    // if (upload && upload.phase !== 'completed') setUploadStarted(true)
    if (!upload) {
      setUploadStarted(false)
      setResult(undefined)
    }
    if (upload) {
      if (upload.phase !== 'completed') setUploadStarted(true)
    }
  }, [upload])
  // MEA:enterprise-knowledge-page 仅保留本次弹窗观察到的上传完成反馈，历史结果仍用于复用副本。
  const hideCompletedUpload = upload?.phase === 'completed' && !uploadStarted
  const visibleUpload = hideCompletedUpload ? null : upload
  const uploadOriginal = true
  const originalOption =
    !remote && !uploadStarted && !upload ? (
      <div className="text-sm text-muted-foreground">{t('knowledge.org.upload_original_required')}</div>
    ) : null
  const [password, setPassword] = useState('')
  const [maxViews, setMaxViews] = useState('')
  const [expiry, setExpiry] = useState('7')
  const [result, setResult] = useState<OrgKnowledgeShareResult>()
  const [showUploadDetails, setShowUploadDetails] = useState(false)
  const visibleResult = result && (!hideCompletedUpload || !canInviteAfterShare(result)) ? result : undefined
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
    if (!remote && upload?.phase !== 'completed') setUploadStarted(true)
    setError(null)
    let target = baseId
    try {
      if (!remote) {
        // const uploaded = result ?? (await ipcApi.request('enterprise.knowledge.share', { baseId }))
        const uploaded =
          result && canInviteAfterShare(result)
            ? result
            : await ipcApi.request('enterprise.knowledge.share', { baseId, uploadOriginal })
        if (!active.current) return
        setResult(uploaded)
        if (!canInviteAfterShare(uploaded)) {
          const status = await ipcApi.request('enterprise.knowledge.upload_status', { baseId })
          if (!active.current) return
          if (!status && !uploaded.shareId) {
            setResult(undefined)
            setUploadStarted(false)
          }
          // setError(t('knowledge.org.upload_incomplete'))
          const failedFile = uploaded.files.find((file) => file.status !== 'success' && file.error)
          // const reason = failedFile ? `${failedFile.fileName} · ${failedFile.error}` : status?.error
          const reason = failedFile ? `${failedFile.fileName} · ${failedFile.error}` : uploaded.error ?? status?.error
          setError([reason, t('knowledge.org.upload_incomplete')].filter(Boolean).join('\n'))
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
  const disabled =
    busy || Boolean(share) || unknown || upload?.phase === 'cleanup_pending' || upload?.phase === 'cleanup_unknown'
  // if (mode === 'people' && !remote) {
  if (mode === 'people') {
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose()
        }}>
        <DialogContent closeLabel={t('common.close')}>
          <KnowledgeDialogHeader>{t('knowledge.org.invite_people')}</KnowledgeDialogHeader>
          <DialogDescription>{name}</DialogDescription>
          <KnowledgeDialogBody>
            {/* {upload ? <KnowledgeUploadProgress progress={upload} /> : null} */}
            {visibleUpload ? <KnowledgeUploadProgress progress={visibleUpload} /> : null}
            {originalOption}
            <KnowledgeInvitePanel
              remote={remote}
              uploadOriginal={uploadOriginal}
              baseId={baseId}
              prepared={result}
              busy={busy || upload?.phase === 'cleanup_pending' || upload?.phase === 'cleanup_unknown'}
              // onBusyChange={setBusy}
              onBusyChange={(value) => {
                if (value && upload?.phase !== 'completed') setUploadStarted(true)
                setBusy(value)
              }}
              onPrepared={setResult}
              onInvited={onShared}
              renderActions={(inviteButton) => (
                <KnowledgeDialogFooter className="flex-row justify-end pt-3">
                  <Button variant="outline" onClick={onClose}>
                    {t('common.close')}
                  </Button>
                  {inviteButton}
                </KnowledgeDialogFooter>
              )}
            />
            {visibleResult?.files.length ? (
              <Button
                variant="outline"
                aria-expanded={showUploadDetails}
                onClick={() => setShowUploadDetails((shown) => !shown)}>
                {t('knowledge.org.upload_details')}
              </Button>
            ) : null}
            {/* 原条件：visibleResult?.files.map((file, index) => (...) */}
            {showUploadDetails &&
              visibleResult?.files.map((file, index) => (
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
          {/* 关闭按钮与发送邀请合并到面板操作区。
          <KnowledgeDialogFooter>
            <Button variant="outline" onClick={onClose}>
              {t('common.close')}
            </Button>
          </KnowledgeDialogFooter>
          */}
        </DialogContent>
      </Dialog>
    )
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}>
      <DialogContent
        closeLabel={t('common.close')}
        className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto rounded-2xl p-0 sm:max-w-[548px] [&_[data-slot=dialog-close]]:grid [&_[data-slot=dialog-close]]:size-11 [&_[data-slot=dialog-close]]:place-items-center">
        {/* MEA:enterprise-knowledge-page 分享成功后突出真实分享码，设置仅在生成前展示。 */}
        <div className="space-y-3 px-7 pt-8 pb-6">
          <KnowledgeDialogHeader className="[&_[data-slot=dialog-title]]:text-xl">
            {t('knowledge.org.share_code')}
          </KnowledgeDialogHeader>
          <DialogDescription className="pr-4 text-sm leading-relaxed">
            {t('knowledge.org.receive_instructions')}
          </DialogDescription>
        </div>
        <KnowledgeDialogBody className="space-y-5 px-7 pb-7">
          {originalOption}
          {/* {upload ? <KnowledgeUploadProgress progress={upload} /> : null} */}
          {visibleUpload ? <KnowledgeUploadProgress progress={visibleUpload} /> : null}
          {/* <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
            <BookOpen className="size-4 shrink-0" aria-hidden="true" />
            <p className="truncate font-medium text-foreground" title={name}>
              {name}
            </p>
          </div> */}
          {share ? (
            <section aria-label={t('knowledge.org.share_code')} className="space-y-3">
              <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/40 p-5">
                <p className="min-w-0 flex-1 break-all font-mono text-3xl leading-tight font-semibold tracking-wide select-all">
                  {share.shareCode}
                </p>
                <Button
                  variant="ghost"
                  className="size-11 shrink-0"
                  aria-label={t('knowledge.org.copy_text')}
                  onClick={() => void copy()}>
                  {copied ? (
                    <Check className="size-5" aria-hidden="true" />
                  ) : (
                    <Copy className="size-5" aria-hidden="true" />
                  )}
                </Button>
              </div>
              <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
                <p>
                  {t('knowledge.org.validity')}: {share.expiresAt ?? t('knowledge.org.never_expires')}
                </p>
                {password ? (
                  <p>
                    {t('knowledge.org.password')}:{' '}
                    <span className="font-mono text-foreground select-all">{password}</span>
                  </p>
                ) : null}
                {share.maxViews !== null ? (
                  <p>
                    {t('knowledge.org.max_views')}: {share.maxViews}
                  </p>
                ) : null}
              </div>
            </section>
          ) : null}
          {/* <div className="flex gap-3 rounded-xl border border-border p-4">
            <LockKeyhole className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="space-y-1">
              <p className="text-sm font-medium">{t('knowledge.org.readonly')}</p>
              <p className="text-xs leading-relaxed text-muted-foreground">{t('knowledge.org.readonly_notice')}</p>
            </div>
          </div> */}
          {!share ? (
            <div className="space-y-3">
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
            </div>
          ) : null}
          {!share ? (
            <p className="text-xs leading-relaxed text-muted-foreground">{t('knowledge.org.share_description')}</p>
          ) : null}
          {/* 保留原上传逐项展示，成功后由分享码结果区承接。
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
          */}
          {!share && visibleResult?.files.length ? (
            <Button
              variant="outline"
              aria-expanded={showUploadDetails}
              onClick={() => setShowUploadDetails((shown) => !shown)}>
              {t('knowledge.org.upload_details')}
            </Button>
          ) : null}
          {/* 原条件：!share && visibleResult，逐项结果改为点击后展示。 */}
          {!share && showUploadDetails && visibleResult
            ? visibleResult.files.map((file, index) => (
                <p key={`${file.fileName}-${index}`} className="text-xs text-muted-foreground">
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
              ))
            : null}
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
        <KnowledgeDialogFooter className="border-t border-border bg-muted/20 px-7 py-5">
          <Button
            variant={share ? 'default' : 'outline'}
            className="min-h-11 min-w-20"
            disabled={busy}
            onClick={onClose}>
            {t('common.close')}
          </Button>
          {/* 复制操作已移到分享码右侧。
          {share ? <Button onClick={() => void copy()}>{t('knowledge.org.copy_text')}</Button> : null}
          */}
          {/* 原禁用条件：disabled || !validPassword || !validCount || Boolean(result && !canInviteAfterShare(result)) */}
          {!share ? (
            <Button
              disabled={
                disabled ||
                !validPassword ||
                !validCount ||
                Boolean(result && !canInviteAfterShare(result) && upload?.phase !== 'completed')
              }
              onClick={() => void submit()}>
              {busy ? t('common.loading') : t('knowledge.org.generate_code')}
            </Button>
          ) : null}
        </KnowledgeDialogFooter>
      </DialogContent>
    </Dialog>
  )
}
