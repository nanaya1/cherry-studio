import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge, Button, NormalTooltip } from '@cherrystudio/ui'
import { ipcApi } from '@renderer/ipc'
import type { InspectionSpace } from '@shared/data/types/knowledgeInspection'

import { useInspectionQuery } from '../hooks/useInspectionQuery'
import DetailHeader from './DetailHeader'
import InspectionQueryState from './InspectionQueryState'
import KnowledgeInspectionFiles, { InspectionFileDetail, type InspectionFileTarget } from './KnowledgeInspectionFiles'
import KnowledgeInspectionRelations from './KnowledgeInspectionRelations'

export default function KnowledgeInspectionDetail({ base }: { base: InspectionSpace }) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'files' | 'relations'>('files')
  const [opened, setOpened] = useState<InspectionFileTarget | null>(null)
  const load = useCallback(
    () => ipcApi.request('enterprise.knowledge.inspection.detail', { baseId: base.id }),
    [base.id]
  )
  const query = useInspectionQuery(load)
  return (
    <main
      data-ui="knowledge.content"
      className={`flex min-h-0 min-w-0 flex-1 flex-col ${opened ? 'overflow-hidden' : 'overflow-auto'}`}>
      <div className={opened ? 'hidden' : 'contents'} hidden={Boolean(opened)}>
        <DetailHeader
          base={{ name: query.data?.name ?? base.name }}
          sharingStatus={
            <NormalTooltip
              content={t('knowledge.inspection.read_hint')}
              contentProps={{ className: 'max-w-72 whitespace-normal' }}>
              <Badge variant="outline" tabIndex={0} className="shrink-0 font-normal">
                {t('knowledge.inspection.read_only')}
              </Badge>
            </NormalTooltip>
          }
        />
        <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-4">
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
              <div
                className="flex gap-2 border-b border-border pb-2"
                aria-label={t('knowledge.inspection.detail_tabs')}>
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
                <div className="flex min-h-0 flex-1 flex-col overflow-auto">
                  <KnowledgeInspectionFiles key={query.data.id} baseId={query.data.id} onOpen={setOpened} />
                </div>
              ) : (
                <KnowledgeInspectionRelations key={query.data.id} baseId={query.data.id} />
              )}
            </>
          ) : null}
        </div>
      </div>
      {opened ? (
        <InspectionFileDetail
          key={opened.file.id}
          baseId={base.id}
          file={opened.file}
          initialMode={opened.mode}
          onBack={() => setOpened(null)}
        />
      ) : null}
    </main>
  )
}
