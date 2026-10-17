import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

// import { Button } from '@cherrystudio/ui'
import { Button, ConfirmDialog } from '@cherrystudio/ui'
import { ipcApi } from '@renderer/ipc'

import { useOrgKnowledgeResource } from '../hooks/useOrgKnowledgeResource'
import ShareKnowledgeDialog from './ShareKnowledgeDialog'

// 活跃的上传/同步阶段与状态：期间主线程会拒绝取消分享，面板预先禁用确认以避免无谓的错误往返。
const ACTIVE_UPLOAD_PHASES = ['counting', 'uploading', 'confirming']
// 仅 syncing 视为进行中的同步；pending 是已排队、尚未开始的待处理任务，不应阻止取消分享。
const ACTIVE_SYNC_STATES = ['syncing']

export default function KnowledgeSharingPanel({
  baseId,
  name = '',
  localBaseId,
  onUnshared,
  confirmUnshare = false
}: {
  baseId: string
  name?: string
  localBaseId?: string
  onUnshared?: () => void
  confirmUnshare?: boolean
}) {
  const { t } = useTranslation()
  const load = useCallback(() => ipcApi.request('enterprise.knowledge.shares', { baseId }), [baseId])
  const { data, loading, error, refresh } = useOrgKnowledgeResource(load)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)
  // const [unsharing, setUnsharing] = useState(false)
  const [unsharing, setUnsharing] = useState(confirmUnshare)
  const [checkingActivity, setCheckingActivity] = useState(false)
  const [activityBlocked, setActivityBlocked] = useState(false)
  const lock = useRef(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const revoke = async () => {
    if (!revoking || lock.current) return
    lock.current = true
    setBusy(true)
    setActionError(null)
    try {
      const result = await ipcApi.request('enterprise.knowledge.revoke_share', { baseId, shareId: revoking })
      if (!active.current) return
      if (!result.ok) throw new Error(t('knowledge.org.operation_failed'))
      setRevoking(null)
      await refresh()
    } catch (cause) {
      if (active.current) setActionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (active.current) {
        lock.current = false
        setBusy(false)
      }
    }
  }
  // 取消整个分享前检查是否有活跃的上传/同步；单次查询，不轮询。
  const checkActivity = useCallback(async () => {
    if (!localBaseId) return
    setCheckingActivity(true)
    setActivityBlocked(false)
    try {
      const [upload, syncStatus] = await Promise.all([
        ipcApi.request('enterprise.knowledge.upload_status', { baseId: localBaseId }),
        ipcApi.request('enterprise.knowledge.sync_status', { baseId: localBaseId })
      ])
      if (!active.current) return
      const uploading = upload != null && ACTIVE_UPLOAD_PHASES.includes(upload.phase)
      const syncing = syncStatus != null && ACTIVE_SYNC_STATES.includes(syncStatus.state)
      setActivityBlocked(uploading || syncing)
    } catch {
      // 状态查询失败不应阻断确认；主线程会在取消分享时拒绝活跃的上传/同步。
    } finally {
      if (active.current) setCheckingActivity(false)
    }
  }, [localBaseId])
  const startUnshare = useCallback(() => {
    if (!localBaseId || busy) return
    setUnsharing(true)
    void checkActivity()
  }, [localBaseId, busy, checkActivity])
  useEffect(() => {
    if (confirmUnshare) void checkActivity()
  }, [confirmUnshare, checkActivity])
  const unshare = async () => {
    if (!localBaseId || lock.current) return
    lock.current = true
    setBusy(true)
    setActionError(null)
    try {
      // 主线程输入为本地知识库 uuid，输出 { ok: true }；活跃的上传/同步会被主线程拒绝。
      const result = await ipcApi.request('enterprise.knowledge.unshare', { baseId: localBaseId })
      if (!active.current) return
      if (!result.ok) throw new Error(t('knowledge.org.operation_failed'))
      setUnsharing(false)
      onUnshared?.()
    } catch (cause) {
      if (active.current) setActionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (active.current) {
        lock.current = false
        setBusy(false)
      }
    }
  }
  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code)
    } catch (cause) {
      if (active.current) setActionError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  // 任一确认对话框（取消分享 / 吊销）打开时，禁用生成码、刷新、取消分享与吊销等竞争动作，避免并发竞态。
  const confirming = unsharing || revoking !== null
  return (
    <section className="space-y-4 p-4" aria-label={t('knowledge.org.shares')}>
      <h2 className="font-medium">{t('knowledge.org.shares')}</h2>
      <p className="text-sm text-muted-foreground">{t('knowledge.org.copy_notice')}</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || confirming} onClick={() => setCreating(true)}>
          {t('knowledge.org.generate_code')}
        </Button>
        <Button variant="outline" disabled={loading || busy || confirming} onClick={() => void refresh()}>
          {t('knowledge.org.refresh')}
        </Button>
        {localBaseId ? (
          <Button variant="outline" disabled={busy || confirming} onClick={() => startUnshare()}>
            {t('knowledge.org.unshare')}
          </Button>
        ) : null}
      </div>
      {creating ? (
        <ShareKnowledgeDialog
          baseId={baseId}
          name={name}
          remote
          onClose={() => setCreating(false)}
          onShared={() => void refresh()}
        />
      ) : null}
      {loading ? <p role="status">{t('common.loading')}</p> : null}
      {error || (actionError && !unsharing) ? (
        <p role="alert" className="text-error">
          {error || actionError}
        </p>
      ) : null}
      {!loading && data?.shares.length === 0 ? <p>{t('knowledge.org.empty_shares')}</p> : null}
      {data?.shares.map((share) => {
        const state = share.revokedAt
          ? 'knowledge.org.revoked'
          : share.expiresAt && Date.parse(share.expiresAt) <= Date.now()
            ? 'knowledge.org.expired'
            : share.maxViews !== null && share.viewCount >= share.maxViews
              ? 'knowledge.org.exhausted'
              : 'knowledge.org.active_share'
        return (
          <div key={share.id} className="space-y-2 border-b border-border py-3">
            <p className="break-all font-mono">{share.shareCode}</p>
            <p>{t(state)}</p>
            <p>{t('knowledge.org.readonly')}</p>
            <p>{t(share.hasPassword ? 'knowledge.org.has_password' : 'knowledge.org.no_password')}</p>
            <p>{t('knowledge.org.access_count', { count: share.viewCount })}</p>
            <p>
              {share.maxViews === null
                ? t('knowledge.org.unlimited')
                : t('knowledge.org.access_limit', { count: share.maxViews })}
            </p>
            <p>{share.expiresAt ?? t('knowledge.org.never_expires')}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => void copy(share.shareCode)}>
                {t('knowledge.org.copy_code')}
              </Button>
              {!share.revokedAt ? (
                <Button variant="outline" disabled={busy || confirming} onClick={() => setRevoking(share.id)}>
                  {t('knowledge.org.revoke')}
                </Button>
              ) : null}
            </div>
          </div>
        )
      })}
      {revoking ? (
        <div className="space-y-2 rounded border border-border p-3">
          <p>{t('knowledge.org.revoke_notice')}</p>
          <Button variant="destructive" disabled={busy} onClick={() => void revoke()}>
            {t('knowledge.org.confirm_revoke')}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setRevoking(null)}>
            {t('common.cancel')}
          </Button>
        </div>
      ) : null}
      {/* {unsharing ? (
        <div className="space-y-2 rounded border border-border p-3">
          <p>{t('knowledge.org.unshare_notice')}</p>
          {checkingActivity ? <p role="status">{t('common.loading')}</p> : null}
          {activityBlocked ? (
            <p role="alert" className="text-error">
              {t('knowledge.org.unshare_blocked_activity')}
            </p>
          ) : null}
          <Button
            variant="destructive"
            disabled={busy || checkingActivity || activityBlocked}
            onClick={() => void unshare()}>
            {t('knowledge.org.confirm_unshare')}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setUnsharing(false)}>
            {t('common.cancel')}
          </Button>
        </div>
      ) : null} */}
      <ConfirmDialog
        open={unsharing}
        onOpenChange={(open) => {
          if (!lock.current) setUnsharing(open)
        }}
        title={t('knowledge.org.unshare')}
        description={t('knowledge.org.unshare_notice')}
        content={
          <div className="space-y-2">
            {activityBlocked ? (
              <p role="alert" className="text-error">
                {t('knowledge.org.unshare_blocked_activity')}
              </p>
            ) : null}
            {actionError ? (
              <p role="alert" className="text-error">
                {actionError}
              </p>
            ) : null}
          </div>
        }
        confirmText={t('knowledge.org.confirm_unshare')}
        cancelText={t('common.cancel')}
        confirmLoading={busy || checkingActivity}
        confirmDisabled={busy || checkingActivity || activityBlocked}
        cancelDisabled={busy}
        destructive
        onConfirm={async () => {
          await unshare()
          return false
        }}
      />
    </section>
  )
}
