import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@cherrystudio/ui'
import { ipcApi } from '@renderer/ipc'

import { useOrgKnowledgeResource } from '../hooks/useOrgKnowledgeResource'
import ShareKnowledgeDialog from './ShareKnowledgeDialog'

export default function KnowledgeSharingPanel({ baseId, name = '' }: { baseId: string; name?: string }) {
  const { t } = useTranslation()
  const load = useCallback(() => ipcApi.request('enterprise.knowledge.shares', { baseId }), [baseId])
  const { data, loading, error, refresh } = useOrgKnowledgeResource(load)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)
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
  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code)
    } catch (cause) {
      if (active.current) setActionError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return (
    <section className="space-y-4 p-4" aria-label={t('knowledge.org.shares')}>
      <h2 className="font-medium">{t('knowledge.org.shares')}</h2>
      <p className="text-sm text-muted-foreground">{t('knowledge.org.copy_notice')}</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => setCreating(true)}>
          {t('knowledge.org.generate_code')}
        </Button>
        <Button variant="outline" disabled={loading || busy} onClick={() => void refresh()}>
          {t('knowledge.org.refresh')}
        </Button>
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
      {error || actionError ? (
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
                <Button variant="outline" disabled={busy} onClick={() => setRevoking(share.id)}>
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
    </section>
  )
}
