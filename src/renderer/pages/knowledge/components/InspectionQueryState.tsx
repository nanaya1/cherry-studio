import { useTranslation } from 'react-i18next'

import { Button } from '@cherrystudio/ui'

export default function InspectionQueryState({
  loading,
  error,
  reload
}: {
  loading: boolean
  error?: string
  reload: () => void
}) {
  const { t } = useTranslation()
  if (loading)
    return (
      <p role="status" className="p-2 text-sm text-muted-foreground">
        {t('common.loading')}
      </p>
    )
  if (error)
    return (
      <div role="alert" className="space-y-2 p-2">
        <p className="break-words text-sm text-error">{error}</p>
        <Button variant="outline" size="sm" onClick={reload}>
          {t('knowledge.org.refresh')}
        </Button>
      </div>
    )
  return null
}
