import { createHash } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { safeStorage } from 'electron'

import { application } from '@application'
import { notifyDataApiDataChange } from '@data/dataApiDataChange'
import { appStateTable } from '@data/db/schemas/appState'
import { userProviderTable } from '@data/db/schemas/userProvider'
import { modelService } from '@data/services/ModelService'
import { providerService, setXuelangSyncContext, XUELANG_SNAPSHOT_OWNER } from '@data/services/ProviderService'
import { XUELANG_PROVIDER_ID } from '@shared/data/presets/xuelang'
import { endpointImpliedCapability, parseUniqueModelId } from '@shared/data/types/model'

import { parseJavaModelConfigEnvelope } from './JavaModelConfigClient'
import type { OrgAuthManager } from './OrgAuthManager'
import type { JavaModelConfigModel, JavaModelConfigProvider, JavaModelConfigSnapshot } from './types'

type ModelConfigAuth = Pick<
  OrgAuthManager,
  'getValidSession' | 'getVerificationStatus' | 'acquireLease' | 'assertLease'
> & {
  apiClient: Pick<OrgAuthManager['apiClient'], 'getModelConfig'>
}

const COWORK_KEY_LABEL = 'Cowork'
const snapshotKey = (scope: string) => `enterprise.xuelang.snapshot.${scope}`

type Preferences = { enabled?: boolean; keys?: Record<string, boolean>; models?: Record<string, boolean> }

function readState(key: string): unknown {
  return application.get('DbService').getDb().select().from(appStateTable).where(eq(appStateTable.key, key)).get()
    ?.value
}

function writeState(key: string, value: unknown): void {
  application
    .get('DbService')
    .getDb()
    .insert(appStateTable)
    .values({ key, value })
    .onConflictDoUpdate({ target: appStateTable.key, set: { value } })
    .run()
}

function digest(parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

/**
 * 多把 Key 下发的模型可能重叠：按实际 API 模型 ID 去重，合并协议与展示名。
 * 服务端是唯一来源，能力只按协议推导，不按名称猜测视觉/工具/推理权限。
 */
function mergeModels(providers: JavaModelConfigProvider[]): JavaModelConfigModel[] {
  const merged = new Map<string, JavaModelConfigModel>()
  for (const provider of providers) {
    for (const model of provider.models) {
      const existing = merged.get(model.id)
      if (!existing) {
        merged.set(model.id, { ...model, endpointTypes: [...model.endpointTypes] })
        continue
      }
      existing.endpointTypes = [...new Set([...existing.endpointTypes, ...model.endpointTypes])]
      if (existing.name === undefined && model.name !== undefined) existing.name = model.name
    }
  }
  return [...merged.values()]
}

function modelFields(model: JavaModelConfigModel) {
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

/** 由 EnterprisePlugin 管理触发时机，所有持久化仍复用服务商与模型的领域服务。 */
export class CoworkModelConfigSync {
  constructor(
    private readonly crypto: Pick<
      typeof safeStorage,
      'isEncryptionAvailable' | 'getSelectedStorageBackend' | 'encryptString' | 'decryptString'
    > = safeStorage
  ) {}

  async sync(auth: ModelConfigAuth): Promise<{ providerId: string; keyCount: number; modelCount: number } | null> {
    if (auth.getVerificationStatus().state !== 'verified') return null
    const lease = auth.acquireLease()
    const session = await auth.getValidSession()
    auth.assertLease(lease)
    if (!session || session.authMode !== 'management-java') return null

    const { authOrigin } = session
    const scopeFor = (identity: typeof lease) =>
      digest([authOrigin, identity.issuerId, identity.userId, identity.tenantId ?? ''])
    const scope = scopeFor(lease)
    const currentScope = () => {
      try {
        const current = auth.acquireLease()
        return current.generation === lease.generation && scopeFor(current) === scope ? scope : undefined
      } catch {
        return undefined
      }
    }
    setXuelangSyncContext(currentScope, 'syncing')
    notifyModelChanges()
    try {
      const snapshot = await auth.apiClient.getModelConfig(session, () => auth.assertLease(lease))
      auth.assertLease(lease)
      if (
        snapshot.serverInstanceId !== session.issuerId ||
        snapshot.userId !== session.userId ||
        snapshot.tenantId !== session.tenantId
      ) {
        throw new Error('模型配置身份或企业与当前登录会话不一致')
      }

      const models = mergeModels(snapshot.providers)
      // MEA:enterprise-model-binding 快照、身份归属和本机偏好在同一事务中对账。
      application.get('DbService').withWriteTx(() => {
        this.applySnapshot(scope, snapshot, models)
        writeState(snapshotKey(scope), this.sealSnapshot(snapshot))
      })
      setXuelangSyncContext(currentScope, 'success')
      notifyModelChanges()
      return { providerId: XUELANG_PROVIDER_ID, keyCount: snapshot.providers.length, modelCount: models.length }
    } catch (error) {
      if (currentScope()) {
        try {
          this.restoreSnapshot(scope, session)
        } catch {
          // A missing or unreadable cache must not re-enable another scope or hide the sync failure.
        }
        setXuelangSyncContext(currentScope, 'failed')
        notifyModelChanges()
      }
      throw error
    }
  }

  private canEncrypt(): boolean {
    return (
      this.crypto.isEncryptionAvailable() &&
      (process.platform !== 'linux' || !['basic_text', '', 'unknown'].includes(this.crypto.getSelectedStorageBackend()))
    )
  }

  private sealSnapshot(snapshot: JavaModelConfigSnapshot): string | null {
    try {
      if (this.canEncrypt()) return this.crypto.encryptString(JSON.stringify(snapshot)).toString('base64')
    } catch {
      // The current snapshot is still usable; never fall back to a plaintext archive.
    }
    return null
  }

  private restoreSnapshot(
    scope: string,
    session: { issuerId: string; userId: string; tenantId?: string | null }
  ): void {
    if (readState(XUELANG_SNAPSHOT_OWNER) === scope || !this.canEncrypt()) return
    const sealed = readState(snapshotKey(scope))
    if (typeof sealed !== 'string') return
    const data: unknown = JSON.parse(this.crypto.decryptString(Buffer.from(sealed, 'base64')))
    const snapshot = parseJavaModelConfigEnvelope({ code: 200, data })
    if (
      snapshot.serverInstanceId !== session.issuerId ||
      snapshot.userId !== session.userId ||
      snapshot.tenantId !== session.tenantId
    )
      return
    application.get('DbService').withWriteTx(() => this.applySnapshot(scope, snapshot, mergeModels(snapshot.providers)))
  }

  private applySnapshot(scope: string, snapshot: JavaModelConfigSnapshot, models: JavaModelConfigModel[]): void {
    const db = application.get('DbService').getDb()
    const oldOwner = readState(XUELANG_SNAPSHOT_OWNER)
    const row = db.select().from(userProviderTable).where(eq(userProviderTable.providerId, XUELANG_PROVIDER_ID)).get()
    const existing = new Map(
      modelService
        .list({ providerId: XUELANG_PROVIDER_ID }, { includeUnscopedManaged: true })
        .map((model) => [parseUniqueModelId(model.id).modelId, model] as const)
    )
    const preferenceKey = (owner: string) => `enterprise.xuelang.preferences.${owner}`
    if (typeof oldOwner === 'string' && row) {
      const prior = readState(preferenceKey(oldOwner)) as Preferences | undefined
      writeState(preferenceKey(oldOwner), {
        enabled: row.isEnabled,
        keys: { ...prior?.keys, ...Object.fromEntries((row.apiKeys ?? []).map((key) => [key.id, key.isEnabled])) },
        models: {
          ...prior?.models,
          ...Object.fromEntries(
            [...existing].filter(([, model]) => !model.isDeprecated).map(([id, model]) => [id, model.isEnabled])
          )
        }
      })
    }
    const preferences = readState(preferenceKey(scope)) as Preferences | undefined
    const first = snapshot.providers[0]
    const apiKeys = snapshot.providers.map((config) => {
      const id = `cowork-${digest([config.id])}`
      return {
        id,
        key: config.apiKey,
        label: COWORK_KEY_LABEL,
        isEnabled: preferences?.keys?.[id] ?? true,
        managedRoutes: { endpointConfigs: config.endpointConfigs, models: config.models }
      }
    })
    const endpointConfigs: JavaModelConfigProvider['endpointConfigs'] = Object.assign(
      {},
      ...snapshot.providers.map((provider) => provider.endpointConfigs)
    )

    // MEA:enterprise-model-binding 雪浪工匠由登录用户独占，凭据来源固定为 api-key。
    // 服务端按当前身份下发完整列表，全量替换即刻清理旧企业与已撤销的 Key；
    // 只写凭据、地址与模型，不碰 name/preset。
    providerService.update(XUELANG_PROVIDER_ID, {
      endpointConfigs,
      defaultChatEndpoint: first?.defaultChatEndpoint,
      authConfig: { type: 'api-key' },
      isEnabled: preferences?.enabled ?? true
    })
    providerService.replaceApiKeys(XUELANG_PROVIDER_ID, apiKeys)
    this.syncModels(models, existing, preferences?.models)
    writeState(XUELANG_SNAPSHOT_OWNER, scope)
  }

  private syncModels(
    desired: JavaModelConfigModel[],
    existing: Map<string, { isEnabled: boolean; isDeprecated?: boolean | null }>,
    enabled: Record<string, boolean> | undefined
  ): void {
    const desiredIds = new Set(desired.map((model) => model.id))

    modelService.create(
      desired
        .filter((model) => !existing.has(model.id))
        .map((model) => ({ dto: { providerId: XUELANG_PROVIDER_ID, modelId: model.id, ...modelFields(model) } }))
    )
    // 撤权不删除历史行；重新授权时恢复本机偏好而非强制开启。
    modelService.bulkUpdate(
      desired
        .filter((model) => existing.has(model.id))
        .map((model) => ({
          providerId: XUELANG_PROVIDER_ID,
          modelId: model.id,
          patch: {
            ...modelFields(model),
            isEnabled: Object.hasOwn(enabled ?? {}, model.id) ? enabled?.[model.id] : true,
            isDeprecated: false
          }
        }))
    )
    modelService.bulkUpdate(
      [...existing.keys()]
        .filter((modelId) => !desiredIds.has(modelId))
        .map((modelId) => ({
          providerId: XUELANG_PROVIDER_ID,
          modelId,
          patch: { isEnabled: false, isDeprecated: true }
        }))
    )
  }
}
