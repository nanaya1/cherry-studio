import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge, Button } from '@cherrystudio/ui'
import { ipcApi } from '@renderer/ipc'
import type { InspectionSpace } from '@shared/data/types/knowledgeInspection'

import { useInspectionQuery } from '../hooks/useInspectionQuery'
import DetailHeader from './DetailHeader'
import InspectionQueryState from './InspectionQueryState'
import KnowledgeInspectionFiles from './KnowledgeInspectionFiles'
import KnowledgeInspectionRelations from './KnowledgeInspectionRelations'

export default function KnowledgeInspectionDetail({ base }: { base: InspectionSpace }) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'files' | 'relations'>('files')
  const load = useCallback(
    () => ipcApi.request('enterprise.knowledge.inspection.detail', { baseId: base.id }),
    [base.id]
  )
  const query = useInspectionQuery(load)
  return (
    <main data-ui="knowledge.content" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
      <DetailHeader
        base={{ name: query.data?.name ?? base.name }}
        sharingStatus={
          <Badge variant="outline" className="shrink-0 font-normal">
            {t('knowledge.inspection.read_only')}
          </Badge>
        }
        actions={
          <Button variant="ghost" size="sm" onClick={query.reload}>
            {t('knowledge.org.refresh')}
          </Button>
        }
      />
      <div className="space-y-4 px-6 py-4">
        <InspectionQueryState {...query} />
        {query.data ? (
          <>
            <p className="text-sm text-muted-foreground">
              {t('knowledge.inspection.owner', {
                name: query.data.ownerName || query.data.ownerId || t('knowledge.inspection.unknown')
              })}
            </p>
            {query.data.description ? (
              <p className="whitespace-pre-wrap break-words text-sm">{query.data.description}</p>
            ) : null}
            <div className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
              <p>{t('knowledge.inspection.read_hint')}</p>
              <p className="mt-1">
                {t(query.data.qaAuthorized ? 'knowledge.inspection.qa_allowed' : 'knowledge.inspection.qa_denied')}
              </p>
            </div>
            <div className="flex gap-2 border-b border-border pb-2" aria-label={t('knowledge.inspection.detail_tabs')}>
              {(['files', 'relations'] as const).map((value) => (
                <Button
                  key={value}
                  variant={tab === value ? 'secondary' : 'ghost'}
                  aria-pressed={tab === value}
                  onClick={() => setTab(value)}>
                  {t(value === 'files' ? 'knowledge.inspection.files' : 'knowledge.inspection.relations')}
                </Button>
              ))}
            </div>
            {tab === 'files' ? (
              <KnowledgeInspectionFiles key={query.data.id} baseId={query.data.id} />
            ) : (
              <KnowledgeInspectionRelations key={query.data.id} baseId={query.data.id} />
            )}
          </>
        ) : null}
      </div>
    </main>
  )
}
