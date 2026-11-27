import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import useSWR from 'swr'

import { Button } from '@cherrystudio/ui'
import { dataApiService } from '@data/DataApiService'
import { useModelMutations } from '@renderer/hooks/useModel'
import { ipcApi } from '@renderer/ipc'
import { toast } from '@renderer/services/toast'
import { MODELS_BULK_UPDATE_MAX_ITEMS } from '@shared/data/api/schemas/models'
import { XUELANG_PROVIDER_ID } from '@shared/data/presets/xuelang'
import type { Model, UniqueModelId } from '@shared/data/types/model'

import { ModelListSyncDrawer } from '../ModelList'
import { modelListClasses } from '../primitives/ProviderSettingsPrimitives'
import CherryInOauth from './CherryInOauth'

export default function XuelangAccountSettings({ providerId }: { providerId: string }) {
  const { data: status } = useSWR('enterprise.personal.status', () => ipcApi.request('enterprise.personal.status'), {
    shouldRetryOnError: false
  })
  return status?.signedIn === false ? <CherryInOauth providerId={providerId} /> : null
}

const EMPTY_MODELS: Model[] = []

export function XuelangModelRefresh({ disabled }: { disabled?: boolean }) {
  const { t } = useTranslation()
  const { updateModels } = useModelMutations()
  const [isApplying, setIsApplying] = useState(false)
  const [open, setOpen] = useState(false)
  const {
    data = EMPTY_MODELS,
    error,
    isValidating,
    mutate
  } = useSWR(
    'enterprise.personal.sync_models',
    async () => {
      const count = await ipcApi.request('enterprise.personal.sync_models')
      if (count === null) throw new Error('Account synchronization did not complete')
      const models = await dataApiService.get('/models', { query: { providerId: XUELANG_PROVIDER_ID } })
      return models.filter((model) => model.isEnabled)
    },
    { revalidateOnMount: false, revalidateOnFocus: false, revalidateOnReconnect: false, shouldRetryOnError: false }
  )

  const visibleModels = data.filter((model) => !model.isHidden)
  const setHidden = async (ids: UniqueModelId[], isHidden: boolean) => {
    setIsApplying(true)
    try {
      for (let offset = 0; offset < ids.length; offset += MODELS_BULK_UPDATE_MAX_ITEMS) {
        const batch = ids.slice(offset, offset + MODELS_BULK_UPDATE_MAX_ITEMS)
        const updated = await updateModels(batch.map((uniqueModelId) => ({ uniqueModelId, patch: { isHidden } })))
        const byId = new Map(updated.map((model) => [model.id, model]))
        await mutate((current) => current?.map((model) => byId.get(model.id) ?? model), { revalidate: false })
      }
    } catch {
      toast.error(t('settings.models.manage.operation_failed'))
    } finally {
      setIsApplying(false)
    }
  }

  const sync = () => {
    return mutate().then(() => undefined)
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className={modelListClasses.fetchActionButton}
        disabled={disabled || isValidating || isApplying}
        onClick={() => {
          setOpen(true)
          void sync()
        }}>
        <RefreshCw className={modelListClasses.toolbarDesignIcon} aria-hidden />
        <span>{t('settings.models.toolbar.pull_short')}</span>
      </Button>
      <ModelListSyncDrawer
        open={open}
        bulkOnly
        allModels={data}
        localModels={visibleModels}
        removableModelIds={visibleModels.map((model) => model.id)}
        isLoading={isValidating}
        isApplying={isApplying}
        onAddModels={(models) =>
          setHidden(
            models.map((model) => model.id),
            false
          )
        }
        onRemoveModels={(ids) => setHidden(ids, true)}
        loadErrorMessage={error && !isValidating ? t('settings.models.manage.sync_pull_failed') : null}
        onRetryLoadModels={sync}
        onClose={() => setOpen(false)}
      />
    </>
  )
}
