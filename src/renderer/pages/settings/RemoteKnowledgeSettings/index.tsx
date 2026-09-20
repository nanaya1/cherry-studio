import { Database, Plus } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, ConfirmDialog, EmptyState, Spinner } from '@cherrystudio/ui'
import Scrollbar from '@renderer/components/Scrollbar'
import {
  SettingDivider,
  SettingGroup,
  SettingsContentBody,
  SettingTitle
} from '@renderer/components/SettingsPrimitives'
import { useRemoteKnowledgeServices } from '@renderer/hooks/useRemoteKnowledge'
import type { CreateRemoteKnowledgeServiceDto, RemoteKnowledgeServiceInfo } from '@shared/data/types/remoteKnowledge'

import { ServiceForm } from './ServiceForm'
import { ServiceListItem } from './ServiceListItem'

export function RemoteKnowledgeSettings() {
  const { t } = useTranslation()
  const { services, error, isLoading, pendingAction, createService, updateService, deleteService, testConnection } =
    useRemoteKnowledgeServices()
  const [formOpen, setFormOpen] = useState(false)
  const [editingService, setEditingService] = useState<RemoteKnowledgeServiceInfo>()
  const [deleteTarget, setDeleteTarget] = useState<RemoteKnowledgeServiceInfo>()

  const openCreate = () => {
    setEditingService(undefined)
    setFormOpen(true)
  }
  const openEdit = (service: RemoteKnowledgeServiceInfo) => {
    setEditingService(service)
    setFormOpen(true)
  }
  const handleSave = useCallback(
    async (draft: CreateRemoteKnowledgeServiceDto) => {
      if (editingService) {
        await updateService(editingService.id, draft)
      } else {
        await createService(draft)
      }
      setFormOpen(false)
    },
    [createService, editingService, updateService]
  )

  if (isLoading) {
    return (
      <SettingsContentBody className="flex-1 items-center justify-center">
        <Spinner text={t('common.loading')} />
      </SettingsContentBody>
    )
  }

  return (
    <Scrollbar className="flex flex-1 flex-col" style={{ height: 'calc(100vh - var(--navbar-height))' }}>
      <SettingsContentBody>
        <SettingGroup>
          <div className="flex items-start justify-between gap-4 pb-1">
            <div className="min-w-0">
              <SettingTitle className="justify-start gap-2">
                <Database className="size-4" />
                {t('settings.remoteKnowledge.title')}
              </SettingTitle>
              <p className="mt-1.5 mb-0 text-xs text-muted-foreground">{t('settings.remoteKnowledge.description')}</p>
            </div>
            <Button size="sm" variant="outline" onClick={openCreate}>
              <Plus className="size-4" />
              {t('settings.remoteKnowledge.add')}
            </Button>
          </div>
          <SettingDivider className="m-0 mt-2" />
          {error && <p className="my-3 text-xs text-destructive">{error.message}</p>}
          {services.length === 0 ? (
            <EmptyState
              compact
              preset="no-resource"
              className="py-8"
              description={t('settings.remoteKnowledge.empty')}
            />
          ) : (
            <div className="flex flex-col">
              {services.map((service) => (
                <ServiceListItem
                  key={service.id}
                  service={service}
                  busy={pendingAction === service.id}
                  onEdit={() => openEdit(service)}
                  onDelete={() => setDeleteTarget(service)}
                  onToggle={(enabled) => void updateService(service.id, { enabled })}
                />
              ))}
            </div>
          )}
        </SettingGroup>
      </SettingsContentBody>

      <ServiceForm
        open={formOpen}
        service={editingService}
        busy={pendingAction !== null}
        onOpenChange={setFormOpen}
        onTest={testConnection}
        onSave={handleSave}
      />
      <ConfirmDialog
        open={deleteTarget !== undefined}
        onOpenChange={(open) => !open && pendingAction === null && setDeleteTarget(undefined)}
        title={t('settings.remoteKnowledge.delete.title')}
        description={t('settings.remoteKnowledge.delete.confirm', { name: deleteTarget?.name ?? '' })}
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        destructive
        confirmLoading={pendingAction === deleteTarget?.id}
        onConfirm={async () => {
          if (!deleteTarget) return
          await deleteService(deleteTarget.id)
          setDeleteTarget(undefined)
        }}
      />
    </Scrollbar>
  )
}

export default RemoteKnowledgeSettings
