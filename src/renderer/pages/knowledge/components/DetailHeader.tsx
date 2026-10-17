import { FlaskConical, SlidersHorizontal } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge, Button, PageHeader } from '@cherrystudio/ui'
import type { KnowledgeBase } from '@shared/data/types/knowledge'

import { statusBadgeClassNames } from './statusStyles'

interface DetailHeaderProps {
  actions?: ReactNode
  sharingStatus?: ReactNode
  base: KnowledgeBase
  onOpenRagConfig: () => void
  onOpenRecallTest: () => void
  onRebuild: () => void
}

const DetailHeader = ({
  base,
  actions,
  sharingStatus,
  onOpenRagConfig,
  onOpenRecallTest,
  onRebuild
}: DetailHeaderProps) => {
  const { t } = useTranslation()

  const statusLabelKey = `knowledge.status.${base.status}` as const
  const statusLabel = t(statusLabelKey)

  return (
    <PageHeader
      title={
        <span className="flex min-w-0 items-center gap-3">
          <span className="truncate">{base.name}</span>
          {sharingStatus}
        </span>
      }
      titleClassName="text-2xl leading-8 font-semibold tracking-tight"
      className="relative mt-0 mb-0 h-auto min-h-20 flex-wrap gap-3 px-6 py-5 after:pointer-events-none after:absolute after:right-6 after:bottom-0 after:left-6 after:border-b after:border-border after:content-['']"
      action={
        base.status === 'failed' ? (
          <Button
            type="button"
            variant="ghost"
            onClick={onRebuild}
            aria-label={`${statusLabel}, ${t('knowledge.restore.action')}`}
            title={t('knowledge.restore.action')}
            className="h-auto min-h-0 shrink-0 cursor-pointer rounded-full p-0 shadow-none transition-opacity hover:bg-transparent hover:opacity-80">
            <Badge variant="outline" className={statusBadgeClassNames[base.status]}>
              {statusLabel}
            </Badge>
          </Button>
        ) : (
          <div className="flex shrink-0 items-center gap-2">
            {actions}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-muted-foreground"
              onClick={onOpenRecallTest}>
              <FlaskConical size={14} />
              {t('knowledge.tabs.recall_test')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('knowledge.tabs.rag_config')}
              className="size-6 text-muted-foreground hover:text-foreground"
              onClick={onOpenRagConfig}>
              <SlidersHorizontal size={14} />
            </Button>
          </div>
        )
      }
    />
  )
}

export default DetailHeader
