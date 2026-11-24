import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge, Button } from '@cherrystudio/ui'
import { ipcApi } from '@renderer/ipc'
import type { InspectionRelation } from '@shared/data/types/knowledgeInspection'

import { useInspectionQuery } from '../hooks/useInspectionQuery'
import InspectionPager from './InspectionPager'
import InspectionQueryState from './InspectionQueryState'

function RelationStatus({ value }: { value: string }) {
  const { t } = useTranslation()
  const keys: Record<string, string> = {
    active: 'knowledge.inspection.status.active',
    pending: 'knowledge.inspection.status.pending',
    declined: 'knowledge.inspection.status.declined',
    expired: 'knowledge.inspection.status.expired',
    removed: 'knowledge.inspection.status.removed',
    revoked: 'knowledge.inspection.status.revoked',
    exhausted: 'knowledge.inspection.status.exhausted'
  }
  return (
    <Badge variant="outline" className="whitespace-nowrap font-normal">
      {t(keys[value] ?? 'knowledge.inspection.unknown')}
    </Badge>
  )
}

function RelationTable({ rows, receipts = false }: { rows: InspectionRelation[]; receipts?: boolean }) {
  const { t } = useTranslation()
  const actor = (name: string | null, id: number | null) =>
    name || (id ? t('knowledge.inspection.user_id', { id }) : t('knowledge.inspection.unknown'))
  const time = (value: string | null) => (value ? new Date(value).toLocaleString() : t('knowledge.inspection.unknown'))
  const headings = [
    t('knowledge.inspection.sharer'),
    t('knowledge.inspection.recipient'),
    t('knowledge.inspection.state'),
    receipts ? t('knowledge.inspection.received_at') : t('knowledge.inspection.invited_at'),
    t('knowledge.inspection.updated_at')
  ]
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr>
            {headings.map((heading) => (
              <th key={heading} className="whitespace-nowrap px-3 py-3 font-medium">
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="min-w-24 max-w-48 break-words px-3 py-3">{actor(row.sharerName, row.sharerId)}</td>
              <td className="min-w-24 max-w-48 break-words px-3 py-3">{actor(row.recipientName, row.recipientId)}</td>
              <td className="px-3 py-3">
                <RelationStatus value={row.status} />
              </td>
              <td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground">{time(row.createTime)}</td>
              <td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground">{time(row.updateTime)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Receipts({ baseId, shareId }: { baseId: string; shareId: string }) {
  const { t } = useTranslation()
  const [page, setPage] = useState(1)
  const load = useCallback(
    () => ipcApi.request('enterprise.knowledge.inspection.receipts', { baseId, shareId, page }),
    [baseId, shareId, page]
  )
  const query = useInspectionQuery(load)
  return (
    <section aria-label={t('knowledge.inspection.receipts')} className="mt-3 rounded-md bg-muted p-2">
      <InspectionQueryState {...query} />
      {query.data ? (
        <>
          {query.data.items.length ? (
            <RelationTable rows={query.data.items} receipts />
          ) : (
            <p className="p-3 text-sm text-muted-foreground">{t('knowledge.inspection.no_receipts')}</p>
          )}
          <InspectionPager page={page} total={query.data.total} onChange={setPage} />
        </>
      ) : null}
    </section>
  )
}

function Link({ baseId, row }: { baseId: string; row: InspectionRelation }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  return (
    <article className="border-t border-border py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-all text-sm font-medium">
              {row.sharerName ||
                (row.sharerId
                  ? t('knowledge.inspection.user_id', { id: row.sharerId })
                  : t('knowledge.inspection.unknown'))}
            </span>
            <RelationStatus value={row.status} />
          </div>
          <p className="text-xs text-muted-foreground">
            {t('knowledge.inspection.created_at', {
              time: row.createTime ? new Date(row.createTime).toLocaleString() : t('knowledge.inspection.unknown')
            })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('knowledge.inspection.usage', {
              used: row.viewCount ?? 0,
              limit: row.maxViews ?? t('knowledge.inspection.unlimited')
            })}{' '}
            ·{' '}
            {row.expiresAt
              ? t('knowledge.inspection.expires', { time: new Date(row.expiresAt).toLocaleString() })
              : t('knowledge.inspection.no_expiry')}
          </p>
        </div>
        <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {t('knowledge.inspection.receipt_count', { count: row.receiptCount ?? 0 })}
        </Button>
      </div>
      {expanded ? <Receipts baseId={baseId} shareId={row.id} /> : null}
    </article>
  )
}

export default function KnowledgeInspectionRelations({ baseId }: { baseId: string }) {
  const { t } = useTranslation()
  const [invitationPage, setInvitationPage] = useState(1)
  const [linkPage, setLinkPage] = useState(1)
  const loadInvitations = useCallback(
    () => ipcApi.request('enterprise.knowledge.inspection.invitations', { baseId, page: invitationPage }),
    [baseId, invitationPage]
  )
  const loadLinks = useCallback(
    () => ipcApi.request('enterprise.knowledge.inspection.links', { baseId, page: linkPage }),
    [baseId, linkPage]
  )
  const invitations = useInspectionQuery(loadInvitations)
  const links = useInspectionQuery(loadLinks)
  return (
    <div className="space-y-8">
      <section aria-label={t('knowledge.inspection.invitations')}>
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-medium">{t('knowledge.inspection.invitations')}</h3>
          <Button variant="ghost" size="sm" onClick={invitations.reload}>
            {t('knowledge.org.refresh')}
          </Button>
        </div>
        <InspectionQueryState {...invitations} />
        {invitations.data ? (
          <>
            {invitations.data.items.length ? (
              <RelationTable rows={invitations.data.items} />
            ) : (
              <p className="py-4 text-sm text-muted-foreground">{t('knowledge.inspection.no_invitations')}</p>
            )}
            <InspectionPager page={invitationPage} total={invitations.data.total} onChange={setInvitationPage} />
          </>
        ) : null}
      </section>
      <section aria-label={t('knowledge.inspection.links')}>
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-medium">{t('knowledge.inspection.links')}</h3>
          <Button variant="ghost" size="sm" onClick={links.reload}>
            {t('knowledge.org.refresh')}
          </Button>
        </div>
        <p className="py-2 text-xs text-muted-foreground">{t('knowledge.inspection.link_hint')}</p>
        <InspectionQueryState {...links} />
        {links.data ? (
          <>
            {links.data.items.length ? (
              links.data.items.map((row) => <Link key={row.id} baseId={baseId} row={row} />)
            ) : (
              <p className="py-4 text-sm text-muted-foreground">{t('knowledge.inspection.no_links')}</p>
            )}
            <InspectionPager page={linkPage} total={links.data.total} onChange={setLinkPage} />
          </>
        ) : null}
      </section>
    </div>
  )
}
