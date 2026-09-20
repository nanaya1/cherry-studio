import { Database, Pencil, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Badge, Button, Switch, Tooltip } from '@cherrystudio/ui'
import type { RemoteKnowledgeServiceInfo } from '@shared/data/types/remoteKnowledge'

interface ServiceListItemProps {
  service: RemoteKnowledgeServiceInfo
  busy: boolean
  onEdit: () => void
  onDelete: () => void
  onToggle: (enabled: boolean) => void
}

export function ServiceListItem({ service, busy, onEdit, onDelete, onToggle }: ServiceListItemProps) {
  const { t } = useTranslation()

  return (
    <div className="flex min-h-16 items-center gap-3 border-b border-border-subtle px-1 py-3 last:border-b-0">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-background">
        <Database className="size-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{service.name}</span>
          <Badge variant="outline" className="shrink-0 text-[10px]">
            {service.authType}
          </Badge>
          {!service.enabled && (
            <Badge variant="secondary" className="shrink-0 text-[10px]">
              {t('settings.remoteKnowledge.disabled')}
            </Badge>
          )}
        </div>
        <div className="mt-1 truncate text-xs text-muted-foreground">{service.baseUrl}</div>
      </div>
      <Switch size="sm" checked={service.enabled} disabled={busy} onCheckedChange={onToggle} />
      <Tooltip content={t('common.edit')}>
        <Button variant="ghost" size="icon" disabled={busy} onClick={onEdit}>
          <Pencil className="size-4" />
        </Button>
      </Tooltip>
      <Tooltip content={t('common.delete')}>
        <Button variant="ghost" size="icon" disabled={busy} onClick={onDelete}>
          <Trash2 className="size-4 text-destructive" />
        </Button>
      </Tooltip>
    </div>
  )
}
