import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Alert, Spinner } from '@cherrystudio/ui'
import Scrollbar from '@renderer/components/Scrollbar'
import { useModelMutations } from '@renderer/hooks/useModel'
import { useProviderApiKeys } from '@renderer/hooks/useProvider'
import { type Model, parseUniqueModelId } from '@shared/data/types/model'
import type { ApiKeyEntry, Provider } from '@shared/data/types/provider'

import ApiKey from '../ConnectionSettings/ApiKey'
import { ProviderModelList } from '../ModelList'
import { providerDetailColumnClasses } from '../primitives/ProviderSettingsPrimitives'

function hasUsableKey(keys: readonly (ApiKeyEntry & { revoked?: boolean })[], model: Model) {
  const apiModelId = model.apiModelId ?? parseUniqueModelId(model.id).modelId
  return keys.some(({ isEnabled, managedRoutes, revoked }) => {
    if (!isEnabled || !managedRoutes || revoked) return false
    return managedRoutes.models.some(
      (route) =>
        route.id === apiModelId &&
        route.endpointTypes.some(
          (type) => model.endpointTypes?.includes(type) && Boolean(managedRoutes.endpointConfigs[type]?.baseUrl)
        )
    )
  })
}

export default function XuelangManagedSettings({ provider }: { provider: Provider }) {
  const { t, i18n } = useTranslation()
  const zh = (i18n.resolvedLanguage ?? i18n.language)?.toLowerCase().startsWith('zh')
  const { id: providerId, managedSyncState } = provider
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const { data, isLoading: keysLoading, error: keysError } = useProviderApiKeys(providerId)
  const { updateModel } = useModelMutations()
  const visible = provider.hasManagedSnapshot === true

  return (
    <Scrollbar ref={setScrollElement} className={providerDetailColumnClasses.scrollStrip}>
      <div className={providerDetailColumnClasses.sectionStack}>
        <p className="text-sm text-muted-foreground">
          {zh ? '连接信息和模型由企业统一下发。' : 'Your organization manages connection details and models.'}
        </p>
        {managedSyncState === 'syncing' && <Spinner text={t('knowledge.sync.state.syncing')} />}
        {managedSyncState === 'failed' && (
          <Alert
            type="error"
            showIcon
            message={zh ? '企业模型配置同步失败' : 'Could not sync organization model settings'}
            description={
              visible
                ? zh
                  ? '正在使用上次成功同步的配置。'
                  : 'Using the last successfully synchronized configuration.'
                : undefined
            }
          />
        )}
        <ApiKey
          providerId={providerId}
          managed={{
            visible,
            emptyMessage: zh
              ? '企业尚未为你下发 API 密钥。'
              : 'Your organization has not assigned any API keys to you.',
            errorMessage: zh ? '无法读取 API 密钥列表' : 'Could not load API keys'
          }}
        />
        <ProviderModelList
          scrollElement={scrollElement}
          providerId={providerId}
          disabled={false}
          managed={{
            visible,
            emptyTitle: zh ? '当前账号暂无可用模型。' : 'Your organization has not assigned any models to you.',
            onToggle: async (model, isEnabled) => {
              await updateModel(providerId, parseUniqueModelId(model.id).modelId, { isEnabled })
            },
            getStatus: (model) =>
              !keysLoading && !keysError && (!provider.isEnabled || !hasUsableKey(data?.keys ?? [], model))
                ? zh
                  ? '无可用 API Key'
                  : 'No usable API key'
                : undefined
          }}
        />
      </div>
    </Scrollbar>
  )
}
