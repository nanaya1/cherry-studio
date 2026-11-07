import { useTranslation } from 'react-i18next'

import { Button } from '@cherrystudio/ui'
import type { AbsoluteFilePath } from '@shared/types/file'

import type { MaterialState } from './industrialVideoMaterials'

export interface IndustrialMaterial extends MaterialState {
  id: string
  name: string
  path?: AbsoluteFilePath
  knowledgeItemId?: string
  jobId?: string
  error?: string
}

export default function IndustrialVideoMaterial({
  material,
  disabled,
  onRemove,
  onRetry
}: {
  material: IndustrialMaterial
  disabled: boolean
  onRemove: () => void
  onRetry: () => void
}) {
  const { t } = useTranslation()
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border border-border p-3">
      <span>{material.name}</span>
      <span role="status">
        {t(
          {
            parsing: 'industrial_video.material_parsing',
            ready: 'industrial_video.material_ready',
            failed: 'industrial_video.material_failed'
          }[material.status]
        )}
      </span>
      {material.error && <span role="alert">{t(material.error, { defaultValue: material.error })}</span>}
      {material.status === 'failed' && (
        <Button variant="outline" disabled={disabled} onClick={onRetry}>
          {t('industrial_video.retry')}
        </Button>
      )}
      <Button variant="ghost" disabled={disabled} onClick={onRemove}>
        {t('industrial_video.remove')}
      </Button>
    </li>
  )
}
