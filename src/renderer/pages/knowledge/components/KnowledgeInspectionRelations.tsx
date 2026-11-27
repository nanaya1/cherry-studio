import { ChevronRight } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@cherrystudio/ui'
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
    <div className="overflow-hidden rounded-lg border border-border">
      <Table className="w-full text-left text-sm">
        <TableHeader className="bg-muted text-xs text-muted-foreground">
          <TableRow>
            {headings.map((heading) => (
              <TableHead key={heading} scope="col" className="h-8 whitespace-nowrap px-3 font-medium">
                {heading}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody className="divide-y divide-border">
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="min-w-24 max-w-48 break-words px-3 py-2">
                {actor(row.sharerName, row.sharerId)}
              </TableCell>
              <TableCell className="min-w-24 max-w-48 break-words px-3 py-2">
                {actor(row.recipientName, row.recipientId)}
              </TableCell>
              <TableCell className="px-3 py-2">
                <RelationStatus value={row.status} />
              </TableCell>
              <TableCell className="whitespace-nowrap px-3 py-2 text-xs tabular-nums text-muted-foreground">
                {time(row.createTime)}
              </TableCell>
              <TableCell className="whitespace-nowrap px-3 py-2 text-xs tabular-nums text-muted-foreground">
                {time(row.updateTime)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
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
    <section aria-label={t('knowledge.inspection.receipts')} className="mt-2 space-y-2 border-l border-border pl-3">
      <p className="text-xs text-muted-foreground">{t('knowledge.inspection.link_hint')}</p>
      <InspectionQueryState {...query} />
      {query.data ? (
        <>
          {query.data.items.length ? (
            <RelationTable rows={query.data.items} receipts />
          ) : (
            <p className="py-2 text-sm text-muted-foreground">{t('knowledge.inspection.no_receipts')}</p>
          )}
          {query.data.total > query.data.pageSize ? (
            <InspectionPager page={page} pageSize={query.data.pageSize} total={query.data.total} onChange={setPage} />
          ) : null}
        </>
      ) : null}
    </section>
  )
}

function Link({ baseId, row }: { baseId: string; row: InspectionRelation }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  return (
    <article className="border-t border-border py-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 space-y-0.5">
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
            {' · '}
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
          <ChevronRight aria-hidden="true" className={expanded ? 'size-3.5 rotate-90' : 'size-3.5'} />
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
    <div className="space-y-5">
      <section className="space-y-2" aria-label={t('knowledge.inspection.invitations')}>
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="font-medium">{t('knowledge.inspection.invitations')}</h3>
          {invitations.data ? (
            <span className="text-xs text-muted-foreground">
              {t('knowledge.org.pagination_total', { total: invitations.data.total })}
            </span>
          ) : null}
        </div>
        <InspectionQueryState {...invitations} />
        {invitations.data ? (
          <>
            {invitations.data.items.length ? (
              <RelationTable rows={invitations.data.items} />
            ) : (
              <p className="py-4 text-sm text-muted-foreground">{t('knowledge.inspection.no_invitations')}</p>
            )}
            {invitations.data.total > invitations.data.pageSize ? (
              <InspectionPager
                page={invitationPage}
                pageSize={invitations.data.pageSize}
                total={invitations.data.total}
                onChange={setInvitationPage}
              />
            ) : null}
          </>
        ) : null}
      </section>
      <section aria-label={t('knowledge.inspection.links')}>
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="font-medium">{t('knowledge.inspection.links')}</h3>
          {links.data ? (
            <span className="text-xs text-muted-foreground">
              {t('knowledge.org.pagination_total', { total: links.data.total })}
            </span>
          ) : null}
        </div>
        <InspectionQueryState {...links} />
        {links.data ? (
          <>
            {links.data.items.length ? (
              links.data.items.map((row) => <Link key={row.id} baseId={baseId} row={row} />)
            ) : (
              <p className="py-4 text-sm text-muted-foreground">{t('knowledge.inspection.no_links')}</p>
            )}
            {links.data.total > links.data.pageSize ? (
              <InspectionPager
                page={linkPage}
                pageSize={links.data.pageSize}
                total={links.data.total}
                onChange={setLinkPage}
              />
            ) : null}
          </>
        ) : null}
      </section>
    </div>
  )
}
