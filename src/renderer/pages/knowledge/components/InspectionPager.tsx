import { useTranslation } from 'react-i18next'

import { Button } from '@cherrystudio/ui'

export default function InspectionPager({
  page,
  total,
  pageSize = 20,
  onChange
}: {
  page: number
  total: number
  pageSize?: number
  onChange: (value: number) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs text-muted-foreground">
      <span>
        {t('knowledge.inspection.pagination', { page, pages: Math.max(1, Math.ceil(total / pageSize)), total })}
      </span>
      <div className="flex gap-1">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          {t('knowledge.inspection.previous')}
        </Button>
        <Button size="sm" variant="ghost" disabled={page * pageSize >= total} onClick={() => onChange(page + 1)}>
          {t('knowledge.inspection.next')}
        </Button>
      </div>
    </div>
  )
}
