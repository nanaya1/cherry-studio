import '@data/services/ProviderRegistryService'
import { setupTestDatabase } from '@test-helpers/db'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'

import { userModelTable } from '@data/db/schemas/userModel'
import { userProviderTable } from '@data/db/schemas/userProvider'
import { modelService } from '@data/services/ModelService'
import { providerService } from '@data/services/ProviderService'
import { ErrorCode } from '@shared/data/api/errors'
import { UpdateModelSchema } from '@shared/data/api/schemas/models'
import { createUniqueModelId, ENDPOINT_TYPE, MODEL_CAPABILITY } from '@shared/data/types/model'

// 自定义 provider 无预设；仅隔离注册表文件加载，不替换服务、数据库或 Drizzle 链。
vi.mock('@cherrystudio/provider-registry/node', () => ({
  RegistryLoader: class {
    loadProviders() {
      return []
    }
    loadModels() {
      return []
    }
    loadProviderModels() {
      return []
    }
    findModel() {
      return null
    }
    findOverride() {
      return null
    }
  }
}))

describe('真实配置 DB：编辑保存与 reconcile 重建对比（不验证 XML）', () => {
  const dbh = setupTestDatabase()
  const providerId = 'custom-config-db-repro'
  const endpoint = ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS
  const wrongModelId = 'wrong-model'
  const modelId = 'configured-model'
  const initialKey = { id: 'fake-key-before', key: 'sk-fake-before', isEnabled: true }
  const latestKey = { id: 'fake-key-after', key: 'sk-fake-after', isEnabled: true }
  const latestEndpointConfigs = { [endpoint]: { baseUrl: 'http://127.0.0.1:18082/v1' } }

  // 捕获保存未落库、读取回退，以及重建意外改写 provider 或丢失显式模型配置。
  it('保存最新地址和 Key 后连续读取不回退，纠正模型身份并比较同 ID 重建字段', () => {
    providerService.create({
      providerId,
      name: '配置数据库验证',
      defaultChatEndpoint: endpoint,
      endpointConfigs: { [endpoint]: { baseUrl: 'http://127.0.0.1:18080/wrong' } },
      apiKeys: [initialKey]
    })
    const [wrongModel] = modelService.create([
      { dto: { providerId, modelId: wrongModelId, name: '错误模型', capabilities: [], endpointTypes: [endpoint] } }
    ])
    expect(providerService.getByProviderId(providerId).endpointConfigs?.[endpoint]?.baseUrl).toBe(
      'http://127.0.0.1:18080/wrong'
    )
    expect(providerService.getRotatedApiKey(providerId)).toBe(initialKey.key)
    expect(modelService.getByKey(providerId, wrongModelId).apiModelId).toBe(wrongModelId)

    providerService.update(providerId, {
      endpointConfigs: { [endpoint]: { baseUrl: 'http://127.0.0.1:18081/still-wrong' } }
    })
    expect(providerService.getByProviderId(providerId).endpointConfigs?.[endpoint]?.baseUrl).toBe(
      'http://127.0.0.1:18081/still-wrong'
    )
    const savedProvider = providerService.update(providerId, {
      endpointConfigs: latestEndpointConfigs,
      defaultChatEndpoint: endpoint,
      isEnabled: true
    })
    providerService.replaceApiKeys(providerId, [latestKey])
    expect(savedProvider.endpointConfigs?.[endpoint]?.baseUrl).toBe(latestEndpointConfigs[endpoint].baseUrl)
    expect(providerService.getApiKeys(providerId)).toEqual([latestKey])

    const editedModel = modelService.update(providerId, wrongModelId, {
      name: '已编辑的错误身份',
      capabilities: [MODEL_CAPABILITY.FUNCTION_CALL],
      supportsStreaming: false
    })
    expect(editedModel).toMatchObject({
      apiModelId: wrongModelId,
      name: '已编辑的错误身份',
      capabilities: [MODEL_CAPABILITY.FUNCTION_CALL],
      supportsStreaming: false
    })
    expect(UpdateModelSchema.safeParse({ modelId }).success).toBe(false)

    const providerBeforeReconcile = dbh.db
      .select()
      .from(userProviderTable)
      .where(eq(userProviderTable.providerId, providerId))
      .get()!
    const editedRow = dbh.db.select().from(userModelTable).where(eq(userModelTable.id, wrongModel.id)).get()!
    expect(providerBeforeReconcile).toMatchObject({
      endpointConfigs: latestEndpointConfigs,
      apiKeys: [latestKey],
      defaultChatEndpoint: endpoint,
      isEnabled: true
    })
    expect(editedRow).toMatchObject({
      modelId: wrongModelId,
      name: '已编辑的错误身份',
      capabilities: [MODEL_CAPABILITY.FUNCTION_CALL],
      supportsStreaming: false
    })

    for (let read = 0; read < 20; read += 1) {
      expect(providerService.getByProviderId(providerId)).toMatchObject({
        endpointConfigs: latestEndpointConfigs,
        defaultChatEndpoint: endpoint,
        isEnabled: true
      })
      expect(providerService.getRotatedApiKey(providerId)).toBe(latestKey.key)
      expect(modelService.getByKey(providerId, wrongModelId)).toEqual(editedModel)
    }
    expect(dbh.db.select().from(userProviderTable).where(eq(userProviderTable.providerId, providerId)).get()).toEqual(
      providerBeforeReconcile
    )
    expect(dbh.db.select().from(userModelTable).where(eq(userModelTable.id, wrongModel.id)).get()).toEqual(editedRow)

    const modelDto = {
      providerId,
      modelId,
      name: '重新获取的模型',
      capabilities: [MODEL_CAPABILITY.FUNCTION_CALL],
      endpointTypes: [endpoint],
      supportsStreaming: true
    }
    // 模拟用户先手动清理；拉取同步本身会保护自定义模型不被删除。
    modelService.delete(providerId, wrongModelId)
    const corrected = modelService.reconcileForProvider(providerId, {
      toRemove: [],
      toAdd: [{ dto: modelDto }]
    })
    expect(corrected).toHaveLength(1)
    expect(corrected[0]).toMatchObject({
      apiModelId: modelDto.modelId,
      capabilities: modelDto.capabilities,
      endpointTypes: modelDto.endpointTypes
    })
    expect(() => modelService.getByKey(providerId, wrongModelId)).toThrowError(
      expect.objectContaining({ code: ErrorCode.NOT_FOUND })
    )
    expect(dbh.db.select().from(userModelTable).where(eq(userModelTable.id, wrongModel.id)).get()).toBeUndefined()

    modelService.update(providerId, modelId, {
      name: '保留的手工编辑',
      capabilities: [],
      supportsStreaming: false,
      contextWindow: 8192,
      notes: '只属于旧模型行'
    })
    const id = createUniqueModelId(providerId, modelId)
    const beforeRebuild = dbh.db.select().from(userModelTable).where(eq(userModelTable.id, id)).get()!
    expect(beforeRebuild).toMatchObject({
      name: '保留的手工编辑',
      capabilities: [],
      supportsStreaming: false,
      contextWindow: 8192,
      notes: '只属于旧模型行'
    })

    modelService.delete(providerId, modelId)
    const rebuilt = modelService.reconcileForProvider(providerId, {
      toRemove: [],
      toAdd: [{ dto: modelDto }]
    })
    expect(rebuilt).toHaveLength(1)
    expect(rebuilt[0]).toMatchObject({
      apiModelId: modelDto.modelId,
      capabilities: modelDto.capabilities,
      endpointTypes: modelDto.endpointTypes
    })
    const afterRebuild = dbh.db.select().from(userModelTable).where(eq(userModelTable.id, id)).get()!
    expect(afterRebuild).toMatchObject({
      id,
      ...modelDto,
      presetModelId: null,
      contextWindow: null,
      notes: null,
      isEnabled: true,
      isHidden: false,
      isDeprecated: false
    })
    const changedConfigFields = (
      ['name', 'capabilities', 'supportsStreaming', 'contextWindow', 'notes'] as const
    ).filter((field) => JSON.stringify(beforeRebuild[field]) !== JSON.stringify(afterRebuild[field]))
    expect(changedConfigFields).toEqual(['name', 'capabilities', 'supportsStreaming', 'contextWindow', 'notes'])
    expect(dbh.db.select().from(userProviderTable).where(eq(userProviderTable.providerId, providerId)).get()).toEqual(
      providerBeforeReconcile
    )
    for (let read = 0; read < 20; read += 1) {
      expect(providerService.getRotatedApiKey(providerId)).toBe(latestKey.key)
      expect(modelService.getByKey(providerId, modelId)).toMatchObject({
        apiModelId: modelDto.modelId,
        capabilities: modelDto.capabilities,
        endpointTypes: modelDto.endpointTypes
      })
    }
  })
})
