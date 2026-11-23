import { createHash } from 'node:crypto'

import { application } from '@application'
import { notifyDataApiDataChange } from '@data/dataApiDataChange'
import { modelService } from '@data/services/ModelService'
import { providerService } from '@data/services/ProviderService'
import { endpointImpliedCapability, parseUniqueModelId } from '@shared/data/types/model'

import type { OrgAuthManager } from './OrgAuthManager'
import type { JavaModelConfigProvider, JavaModelConfigSnapshot, OrgSession } from './types'

const AUTO_PROVIDER_PREFIX = 'cowork-auto-'

type ModelConfigAuth = Pick<
  OrgAuthManager,
  'getValidSession' | 'getVerificationStatus' | 'acquireLease' | 'assertLease'
> & {
  apiClient: Pick<OrgAuthManager['apiClient'], 'getModelConfig'>
}

function digest(parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

function contextPrefix(session: Extract<OrgSession, { authMode: 'management-java' }>): string {
  return `${AUTO_PROVIDER_PREFIX}${digest([session.authOrigin, session.issuerId, session.userId, session.tenantId])}-`
}

function disableBinding(providerId: string): void {
  providerService.update(providerId, { isEnabled: false })
  providerService.replaceApiKeys(
    providerId,
    providerService.getApiKeys(providerId).map((key) => ({ ...key, isEnabled: false }))
  )
  const models = modelService.list({ providerId })
  modelService.bulkUpdate(
    models.map((model) => ({ ...parseUniqueModelId(model.id), patch: { isEnabled: false, isDeprecated: true } }))
  )
}

function notifyModelChanges(): void {
  notifyDataApiDataChange([
    { endpoint: '/providers', kind: 'membership' },
    { endpoint: '/providers/:providerId' },
    { endpoint: '/providers/:providerId/api-keys' },
    { endpoint: '/providers/:providerId/auth-config' },
    { endpoint: '/models', kind: 'membership' },
    { endpoint: '/models/:uniqueModelId*' }
  ])
}

function modelFields(model: JavaModelConfigProvider['models'][number]) {
  // 只采用协议本身确定的能力；不根据名称猜测模型的视觉、工具或推理权限。
  const capabilities = [
    ...new Set(
      model.endpointTypes.flatMap((endpoint) => {
        const capability = endpointImpliedCapability(endpoint)
        return capability ? [capability] : []
      })
    )
  ]
  return { name: model.name ?? model.id, endpointTypes: model.endpointTypes, capabilities }
}

/** 由 EnterprisePlugin 管理触发时机，所有持久化仍复用服务商与模型的领域服务。 */
export class CoworkModelConfigSync {
  async sync(auth: ModelConfigAuth): Promise<{ providerCount: number; modelCount: number } | null> {
    if (auth.getVerificationStatus().state !== 'verified') return null
    const lease = auth.acquireLease()
    const session = await auth.getValidSession()
    auth.assertLease(lease)
    if (!session || session.authMode !== 'management-java') return null
    const prefix = contextPrefix(session)

    // MEA:enterprise-model-binding 企业切换后即使新接口不可用，也不能继续调用旧企业的自动凭据。
    const foreignBindings = providerService
      .list({})
      .filter((provider) => provider.id.startsWith(AUTO_PROVIDER_PREFIX) && !provider.id.startsWith(prefix))
    if (foreignBindings.length > 0) {
      application.get('DbService').withWriteTx(() => {
        for (const provider of foreignBindings) disableBinding(provider.id)
      })
      notifyModelChanges()
    }

    const snapshot = await auth.apiClient.getModelConfig(session, () => auth.assertLease(lease))
    auth.assertLease(lease)
    if (
      snapshot.serverInstanceId !== session.issuerId ||
      snapshot.userId !== session.userId ||
      snapshot.tenantId !== session.tenantId
    ) {
      throw new Error('模型配置身份或企业与当前登录会话不一致')
    }

    // 同步 SQLite 驱动共用单一连接，领域服务的嵌套事务均为保存点；任一写失败回滚整份快照。
    application.get('DbService').withWriteTx(() => this.applySnapshot(prefix, snapshot))
    notifyModelChanges()
    return {
      providerCount: snapshot.providers.length,
      modelCount: snapshot.providers.reduce((count, provider) => count + provider.models.length, 0)
    }
  }

  private applySnapshot(prefix: string, snapshot: JavaModelConfigSnapshot): void {
    const existingProviders = new Map(providerService.list({}).map((provider) => [provider.id, provider]))
    const desiredIds = new Set<string>()
    for (const config of snapshot.providers) {
      const providerId = `${prefix}${digest([config.id])}`
      desiredIds.add(providerId)
      // MEA:enterprise-model-binding 已导入的 Key 由本地维护，后续登录只恢复撤权停用状态。
      const existing = existingProviders.get(providerId)
      if (existing) {
        if (!existing.isEnabled && existing.apiKeys.length > 0 && existing.apiKeys.every((key) => !key.isEnabled)) {
          const models = modelService.list({ providerId })
          // 自动停用会同时标记全部模型弃用，普通手动关闭不应在登录时被重新打开。
          if (models.some((model) => !model.isDeprecated)) continue
          providerService.replaceApiKeys(
            providerId,
            providerService.getApiKeys(providerId).map((key) => ({ ...key, isEnabled: true }))
          )
          modelService.bulkUpdate(
            models.map((model) => ({
              ...parseUniqueModelId(model.id),
              patch: { isEnabled: true, isDeprecated: false }
            }))
          )
          providerService.update(providerId, { isEnabled: true })
        }
        continue
      }
      const fields = {
        name: config.name,
        endpointConfigs: config.endpointConfigs,
        defaultChatEndpoint: config.defaultChatEndpoint,
        authConfig: { type: 'api-key' as const }
      }
      const apiKeys = [{ id: 'cowork', key: config.apiKey, isEnabled: true }]
      /* 原重复覆盖逻辑保留，已存在的绑定在上方跳过。
      if (existingProviders.has(providerId)) {
        providerService.update(providerId, fields)
        providerService.replaceApiKeys(providerId, apiKeys)
      } else {
        providerService.create({ providerId, ...fields, apiKeys })
      }
      */
      providerService.create({ providerId, ...fields, apiKeys })
      this.syncModels(providerId, config)
      providerService.update(providerId, { isEnabled: true })
    }

    // 完整成功快照才允许停用缺失绑定，保留历史对话所引用的服务商与模型行。
    for (const provider of existingProviders.values()) {
      if (provider.id.startsWith(prefix) && !desiredIds.has(provider.id)) disableBinding(provider.id)
    }
  }

  private syncModels(providerId: string, config: JavaModelConfigProvider): void {
    const existingModels = new Map(
      modelService.list({ providerId }).map((model) => [parseUniqueModelId(model.id).modelId, model])
    )
    const desiredIds = new Set(config.models.map((model) => model.id))
    const additions = config.models
      .filter((model) => !existingModels.has(model.id))
      .map((model) => ({
        dto: { providerId, modelId: model.id, ...modelFields(model) }
      }))
    modelService.create(additions)
    modelService.bulkUpdate(
      config.models
        .filter((model) => existingModels.has(model.id))
        .map((model) => ({
          providerId,
          modelId: model.id,
          patch: { ...modelFields(model), isEnabled: true, isDeprecated: false }
        }))
    )
    modelService.bulkUpdate(
      [...existingModels.keys()]
        .filter((modelId) => !desiredIds.has(modelId))
        .map((modelId) => ({ providerId, modelId, patch: { isEnabled: false, isDeprecated: true } }))
    )
  }
}
