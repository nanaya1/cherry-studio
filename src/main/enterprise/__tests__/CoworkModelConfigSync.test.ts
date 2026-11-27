import { setupTestDatabase } from '@test-helpers/db'
import { MockMainCacheServiceUtils } from '@test-mocks/main/CacheService'
import { MockMainDbServiceUtils } from '@test-mocks/main/DbService'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { application } from '@application'
import { appStateTable } from '@data/db/schemas/appState'
import { userProviderTable } from '@data/db/schemas/userProvider'
import { modelService } from '@data/services/ModelService'
import { providerService, setXuelangSyncContext } from '@data/services/ProviderService'
import { generateOrderKeyBetween } from '@data/services/utils/orderKey'
import { XUELANG_PROVIDER_ID, XUELANG_PROVIDER_NAME } from '@shared/data/presets/xuelang'
import { ENDPOINT_TYPE, MODEL_CAPABILITY } from '@shared/data/types/model'
import { IpcChannel } from '@shared/IpcChannel'

import { CoworkModelConfigSync } from '../CoworkModelConfigSync'
import { OrgApiClient } from '../OrgApiClient'
import type { OrgAuthManager } from '../OrgAuthManager'
import type { JavaModelConfigSnapshot, OrgSession } from '../types'

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

const chat = ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS
const embeddings = ENDPOINT_TYPE.OPENAI_EMBEDDINGS

function session(): Extract<OrgSession, { authMode: 'management-java' }> {
  return {
    authMode: 'management-java',
    accountKind: 'management',
    issuerId: 'server-a',
    authOrigin: 'https://cowork.test',
    userId: '7',
    tenantId: '9',
    groupId: null,
    role: 'MEMBER',
    displayName: null,
    phone: '',
    officialUserId: '',
    accessToken: 'login-token',
    expiresAt: null
  }
}

function snapshot(): JavaModelConfigSnapshot {
  return {
    serverInstanceId: 'server-a',
    userId: '7',
    tenantId: '9',
    providers: [
      {
        id: 'key-42',
        name: 'Cowork 开发',
        apiKey: 'sk-key-a',
        defaultChatEndpoint: chat,
        endpointConfigs: { [chat]: { baseUrl: 'https://models.test/v1' } },
        models: [{ id: 'chat-model', endpointTypes: [chat] }]
      }
    ]
  }
}

function createAuth() {
  const state = { session: session(), generation: 0, active: true, verified: true }
  const acquireLease = (): ReturnType<OrgAuthManager['acquireLease']> => {
    if (!state.active) throw new Error('session unavailable')
    return {
      generation: state.generation,
      issuerId: state.session.issuerId,
      userId: state.session.userId,
      tenantId: state.session.tenantId,
      groupId: state.session.groupId
    }
  }
  const auth = {
    getValidSession: async () => (state.active ? state.session : null),
    getVerificationStatus: (): ReturnType<OrgAuthManager['getVerificationStatus']> => ({
      owner: 'test',
      revision: 0,
      state: state.verified ? 'verified' : 'unavailable'
    }),
    acquireLease,
    assertLease: (lease: ReturnType<OrgAuthManager['acquireLease']>) => {
      if (JSON.stringify(acquireLease()) !== JSON.stringify(lease)) throw new Error('stale lease')
    },
    apiClient: new OrgApiClient(async () => (state.active ? state.session : null))
  }
  return { state, auth }
}

describe('CoworkModelConfigSync', () => {
  const dbh = setupTestDatabase()
  const sync = new CoworkModelConfigSync({
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (value) => value.toString('utf8')
  })

  beforeEach(() => {
    MockMainDbServiceUtils.setDb(dbh.db)
    const dbService = application.get('DbService')
    vi.spyOn(dbService, 'getDb').mockImplementation(() => dbh.db)
    vi.spyOn(dbService, 'withWriteTx').mockImplementation((fn) => dbh.db.transaction(fn))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    setXuelangSyncContext(() => undefined, 'idle')
    MockMainCacheServiceUtils.resetMocks()
  })

  function seedXuelangProvider() {
    dbh.db
      .insert(userProviderTable)
      .values({
        providerId: XUELANG_PROVIDER_ID,
        presetProviderId: XUELANG_PROVIDER_ID,
        name: XUELANG_PROVIDER_NAME,
        orderKey: generateOrderKeyBetween(null, null),
        authConfig: { type: 'api-key' },
        isEnabled: false
      })
      .onConflictDoNothing()
      .run()
  }

  function serve(data = snapshot()) {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ code: 200, data }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('把 Key、地址与所有模型写入雪浪工匠，不生成新服务商', async () => {
    const broadcast = vi.mocked(application.get('WindowManager').broadcast)
    broadcast.mockClear()
    seedXuelangProvider()
    const data = snapshot()
    data.providers.push({
      ...data.providers[0],
      id: 'key-43',
      name: 'Cowork 生产',
      apiKey: 'sk-key-b',
      models: [
        { id: 'chat-model', endpointTypes: [chat] },
        { id: 'embed-model', name: '向量模型', endpointTypes: [embeddings] }
      ],
      endpointConfigs: {
        [chat]: { baseUrl: 'https://production-models.test/v1' },
        [embeddings]: { baseUrl: 'https://embed.test/v1' }
      }
    })
    serve(data)
    const { auth } = createAuth()

    await expect(sync.sync(auth)).resolves.toEqual({
      providerId: XUELANG_PROVIDER_ID,
      keyCount: 2,
      modelCount: 2
    })

    const providers = providerService.list({})
    expect(providers).toHaveLength(1)
    expect(providers[0].id).toBe(XUELANG_PROVIDER_ID)
    expect(providers[0].name).toBe(XUELANG_PROVIDER_NAME)
    expect(providers[0]).toMatchObject({ isEnabled: true, managedSyncState: 'success' })
    expect(providerService.getAuthConfig(XUELANG_PROVIDER_ID)).toEqual({ type: 'api-key' })
    const keys = providerService.getApiKeys(XUELANG_PROVIDER_ID)
    expect(keys).toHaveLength(2)
    expect(keys.find((key) => key.key === 'sk-key-a')).toMatchObject({
      isEnabled: true,
      label: 'Cowork',
      managedRoutes: {
        endpointConfigs: { [chat]: { baseUrl: 'https://models.test/v1' } },
        models: [{ id: 'chat-model', endpointTypes: [chat] }]
      }
    })
    expect(keys.find((key) => key.key === 'sk-key-b')).toMatchObject({
      isEnabled: true,
      label: 'Cowork',
      managedRoutes: {
        endpointConfigs: {
          [chat]: { baseUrl: 'https://production-models.test/v1' },
          [embeddings]: { baseUrl: 'https://embed.test/v1' }
        },
        models: [
          { id: 'chat-model', endpointTypes: [chat] },
          { id: 'embed-model', endpointTypes: [embeddings] }
        ]
      }
    })

    // 重复模型按 id 去重，能力只由协议推导。
    const models = modelService.list({ providerId: XUELANG_PROVIDER_ID })
    expect(models.map((model) => model.apiModelId).sort()).toEqual(['chat-model', 'embed-model'])
    expect(modelService.getByKey(XUELANG_PROVIDER_ID, 'embed-model').capabilities).toEqual([MODEL_CAPABILITY.EMBEDDING])
    expect(modelService.getByKey(XUELANG_PROVIDER_ID, 'embed-model').name).toBe('向量模型')
    expect(models.every((model) => model.isEnabled && !model.isDeprecated)).toBe(true)
    expect(modelService.getByKey(XUELANG_PROVIDER_ID, 'chat-model').capabilities).toEqual([])
    expect(JSON.stringify(providers)).not.toContain('sk-key-')
    expect(broadcast).toHaveBeenCalledWith(IpcChannel.DataApi_DataChanged, [
      { endpoint: '/providers', kind: 'membership' },
      { endpoint: '/providers/:providerId' },
      { endpoint: '/providers/:providerId/api-keys' },
      { endpoint: '/providers/:providerId/auth-config' },
      { endpoint: '/models', kind: 'membership' },
      { endpoint: '/models/:uniqueModelId*' }
    ])
    expect(JSON.stringify(broadcast.mock.calls)).not.toContain('sk-key-')
  })

  it('按模型和协议筛选启用的 Key，再轮询并返回各 Key 对应的地址', async () => {
    seedXuelangProvider()
    const data = snapshot()
    const responses = ENDPOINT_TYPE.OPENAI_RESPONSES
    data.providers.push(
      {
        ...data.providers[0],
        id: 'key-43',
        apiKey: 'sk-key-b',
        endpointConfigs: { [chat]: { baseUrl: 'https://second-models.test/v1' } }
      },
      {
        ...data.providers[0],
        id: 'key-44',
        apiKey: 'sk-key-c',
        endpointConfigs: {
          [chat]: { baseUrl: 'https://other-models.test/v1' },
          [responses]: { baseUrl: 'https://responses.test/v1' }
        },
        models: [
          { id: 'other-model', endpointTypes: [chat] },
          { id: 'chat-model', endpointTypes: [responses] }
        ]
      }
    )
    serve(data)
    const { auth } = createAuth()
    await sync.sync(auth)
    const [keyA, keyB] = providerService.getApiKeys(XUELANG_PROVIDER_ID)

    expect(providerService.resolveXuelangApiKey('chat-model', chat)).toMatchObject({
      value: 'sk-key-a',
      baseUrl: 'https://models.test/v1',
      apiKeySelection: { id: keyA.id }
    })
    expect(providerService.resolveXuelangApiKey('chat-model', responses)).toMatchObject({
      value: 'sk-key-c',
      baseUrl: 'https://responses.test/v1'
    })
    expect(providerService.resolveXuelangApiKey('other-model', chat)).toMatchObject({
      value: 'sk-key-c',
      baseUrl: 'https://other-models.test/v1'
    })
    expect(providerService.resolveXuelangApiKey('chat-model', chat)).toMatchObject({
      value: 'sk-key-b',
      baseUrl: 'https://second-models.test/v1',
      apiKeySelection: { id: keyB.id }
    })
    expect(providerService.resolveXuelangApiKey('chat-model', chat)?.value).toBe('sk-key-a')
    expect(providerService.resolveXuelangApiKey('chat-model', chat, 'sk-key-c')).toBeUndefined()
    expect(providerService.resolveXuelangApiKey('other-model', responses)).toBeUndefined()

    providerService.updateApiKey(XUELANG_PROVIDER_ID, keyB.id, { isEnabled: false })
    expect(providerService.resolveXuelangApiKey('chat-model', chat, 'sk-key-b')).toBeUndefined()
    expect(providerService.resolveXuelangApiKey('chat-model', chat)?.value).toBe('sk-key-a')
  })

  it('合并同一模型在多个 Key 下声明的协议，只建一条模型', async () => {
    seedXuelangProvider()
    const data = snapshot()
    data.providers[0].endpointConfigs = {
      [chat]: { baseUrl: 'https://models.test/v1' },
      [embeddings]: { baseUrl: 'https://embed.test/v1' }
    }
    data.providers.push({
      ...data.providers[0],
      id: 'key-43',
      apiKey: 'sk-key-b',
      models: [{ id: 'chat-model', endpointTypes: [embeddings] }]
    })
    serve(data)
    const { auth } = createAuth()

    await expect(sync.sync(auth)).resolves.toMatchObject({ modelCount: 1 })

    const models = modelService.list({ providerId: XUELANG_PROVIDER_ID })
    expect(models).toHaveLength(1)
    expect(modelService.getByKey(XUELANG_PROVIDER_ID, 'chat-model').endpointTypes).toEqual([chat, embeddings])
  })

  it('重复同步刷新服务端字段，但保留 Key、模型和服务商的本地开关', async () => {
    seedXuelangProvider()
    const data = snapshot()
    serve(data)
    const { auth } = createAuth()
    await sync.sync(auth)
    const [originalKey] = providerService.getApiKeys(XUELANG_PROVIDER_ID)
    const originalModel = modelService.getByKey(XUELANG_PROVIDER_ID, 'chat-model')

    providerService.update(XUELANG_PROVIDER_ID, { name: '本地改名', isEnabled: false })
    providerService.updateApiKey(XUELANG_PROVIDER_ID, originalKey.id, { isEnabled: false })
    modelService.update(XUELANG_PROVIDER_ID, 'chat-model', { isEnabled: false })
    data.providers[0].apiKey = 'sk-rotated'
    data.providers[0].endpointConfigs[chat]!.baseUrl = 'https://new-models.test/v1'
    data.providers[0].models = [{ id: 'chat-model', name: '新名字', endpointTypes: [chat] }]
    await sync.sync(auth)

    const providers = providerService.list({})
    expect(providers).toHaveLength(1)
    expect(providers[0]).toMatchObject({ name: '本地改名', isEnabled: false, managedSyncState: 'success' })
    expect(providerService.getApiKeys(XUELANG_PROVIDER_ID)).toMatchObject([
      {
        id: originalKey.id,
        key: 'sk-rotated',
        isEnabled: false,
        managedRoutes: { endpointConfigs: { [chat]: { baseUrl: 'https://new-models.test/v1' } } }
      }
    ])
    expect(modelService.list({ providerId: XUELANG_PROVIDER_ID })).toMatchObject([
      { id: originalModel.id, name: '新名字', isEnabled: false, isDeprecated: false }
    ])
  })

  it.each([true, false])('撤权再授予时记住开关（原本启用：%s），空快照仍显示服务商', async (isEnabled) => {
    seedXuelangProvider()
    const data = snapshot()
    serve(data)
    const { auth } = createAuth()
    await sync.sync(auth)
    const [originalKey] = providerService.getApiKeys(XUELANG_PROVIDER_ID)
    const originalModel = modelService.getByKey(XUELANG_PROVIDER_ID, 'chat-model')
    if (!isEnabled) {
      providerService.update(XUELANG_PROVIDER_ID, { isEnabled })
      providerService.updateApiKey(XUELANG_PROVIDER_ID, originalKey.id, { isEnabled })
      modelService.update(XUELANG_PROVIDER_ID, 'chat-model', { isEnabled })
    }

    data.providers = []
    await expect(sync.sync(auth)).resolves.toMatchObject({ keyCount: 0, modelCount: 0 })

    expect(providerService.list({})).toMatchObject([
      { id: XUELANG_PROVIDER_ID, isEnabled, managedSyncState: 'success', apiKeys: [] }
    ])
    expect(providerService.getApiKeys(XUELANG_PROVIDER_ID)).toEqual([])
    expect(providerService.resolveXuelangApiKey('chat-model', chat)).toBeUndefined()
    expect(modelService.getByKey(XUELANG_PROVIDER_ID, 'chat-model')).toMatchObject({
      id: originalModel.id,
      isEnabled: false,
      isDeprecated: true
    })

    data.providers = snapshot().providers
    await sync.sync(auth)

    expect(providerService.getByProviderId(XUELANG_PROVIDER_ID).isEnabled).toBe(isEnabled)
    expect(providerService.getApiKeys(XUELANG_PROVIDER_ID)).toMatchObject([
      { id: originalKey.id, key: 'sk-key-a', isEnabled }
    ])
    expect(modelService.getByKey(XUELANG_PROVIDER_ID, 'chat-model')).toMatchObject({
      id: originalModel.id,
      isEnabled,
      isDeprecated: false
    })
  })

  it('服务端新增与移除模型时做增量对账，保留不再下发的模型行', async () => {
    seedXuelangProvider()
    const data = snapshot()
    serve(data)
    const { auth } = createAuth()
    await sync.sync(auth)
    const originalId = modelService.getByKey(XUELANG_PROVIDER_ID, 'chat-model').id

    data.providers[0].models = [
      { id: 'chat-model', endpointTypes: [chat] },
      { id: 'new-model', endpointTypes: [chat] }
    ]
    await sync.sync(auth)

    expect(
      modelService
        .list({ providerId: XUELANG_PROVIDER_ID })
        .map((model) => model.apiModelId)
        .sort()
    ).toEqual(['chat-model', 'new-model'])
    expect(modelService.getByKey(XUELANG_PROVIDER_ID, 'new-model').isEnabled).toBe(true)

    data.providers[0].models = [{ id: 'new-model', endpointTypes: [chat] }]
    await sync.sync(auth)

    expect(modelService.getByKey(XUELANG_PROVIDER_ID, 'chat-model')).toMatchObject({
      id: originalId,
      isEnabled: false,
      isDeprecated: true
    })
    expect(modelService.getByKey(XUELANG_PROVIDER_ID, 'new-model').isEnabled).toBe(true)
  })

  it('OAuth 遗留 token 与 Key 在同步后被 api-key 凭据替换', async () => {
    seedXuelangProvider()
    providerService.update(XUELANG_PROVIDER_ID, {
      authConfig: { type: 'oauth', clientId: 'c', accessToken: 'oauth-token', refreshToken: 'r' }
    })
    providerService.replaceApiKeys(XUELANG_PROVIDER_ID, [
      { id: 'oauth', label: 'OAuth', key: 'sk-oauth', isEnabled: true }
    ])
    serve()
    const { auth } = createAuth()

    await sync.sync(auth)

    expect(providerService.getAuthConfig(XUELANG_PROVIDER_ID)).toEqual({ type: 'api-key' })
    expect(providerService.getApiKeys(XUELANG_PROVIDER_ID).map((key) => key.key)).toEqual(['sk-key-a'])
  })

  it('按服务端下发的协议写入地址并创建对应协议模型', async () => {
    seedXuelangProvider()
    const data = snapshot()
    const responses = ENDPOINT_TYPE.OPENAI_RESPONSES
    data.providers[0].defaultChatEndpoint = responses
    data.providers[0].endpointConfigs = { [responses]: { baseUrl: 'https://responses.test/v1' } }
    data.providers[0].models = [{ id: 'chat-model', endpointTypes: [responses] }]
    serve(data)
    const { auth } = createAuth()

    await sync.sync(auth)

    const provider = providerService.getByProviderId(XUELANG_PROVIDER_ID)
    expect(provider.endpointConfigs?.[responses]?.baseUrl).toBe('https://responses.test/v1')
    expect(provider.defaultChatEndpoint).toBe(responses)
    expect(modelService.getByKey(XUELANG_PROVIDER_ID, 'chat-model').endpointTypes).toEqual([responses])
  })

  it.each(['tenantId', 'userId', 'issuerId'] as const)('%s 变化的快照被拒绝且不写入', async (field) => {
    seedXuelangProvider()
    const data = snapshot()
    serve(data)
    const { auth } = createAuth()
    await sync.sync(auth)
    const before = dbh.db.select().from(userProviderTable).all()

    const snapshotField = field === 'issuerId' ? 'serverInstanceId' : field
    data[snapshotField] = 'other'
    await expect(sync.sync(auth)).rejects.toThrow('不一致')
    expect(dbh.db.select().from(userProviderTable).all()).toEqual(before)
  })

  it.each([500, 10007])('同身份业务失败 %s 不清空已有配置', async (code) => {
    seedXuelangProvider()
    const fetchMock = serve()
    const { auth } = createAuth()
    await sync.sync(auth)
    const keysBefore = providerService.getApiKeys(XUELANG_PROVIDER_ID)
    const modelBefore = modelService.getByKey(XUELANG_PROVIDER_ID, 'chat-model')
    const providerBefore = providerService.getByProviderId(XUELANG_PROVIDER_ID)

    fetchMock.mockResolvedValueOnce(Response.json({ code }))
    await expect(sync.sync(auth)).rejects.toThrow()
    expect(providerService.getApiKeys(XUELANG_PROVIDER_ID)).toEqual(keysBefore)
    expect(modelService.getByKey(XUELANG_PROVIDER_ID, 'chat-model')).toEqual(modelBefore)
    expect(providerService.getByProviderId(XUELANG_PROVIDER_ID)).toEqual({
      ...providerBefore,
      managedSyncState: 'failed'
    })
  })

  it('跨企业同步失败后隔离旧企业的凭据和模型，服务商仍可见', async () => {
    seedXuelangProvider()
    const fetchMock = serve()
    const { auth, state } = createAuth()
    await sync.sync(auth)

    const before = dbh.db.select().from(userProviderTable).all()
    state.session = { ...state.session, tenantId: '10' }
    state.generation += 1
    fetchMock.mockResolvedValueOnce(Response.json({ code: 500 }))
    await expect(sync.sync(auth)).rejects.toThrow()

    expect(providerService.list({})).toMatchObject([
      { id: XUELANG_PROVIDER_ID, managedSyncState: 'failed', apiKeys: [] }
    ])
    expect(providerService.getApiKeys(XUELANG_PROVIDER_ID)).toEqual([])
    expect(providerService.resolveXuelangApiKey('chat-model', chat)).toBeUndefined()
    expect(modelService.list({ providerId: XUELANG_PROVIDER_ID })).toEqual([])
    expect(dbh.db.select().from(userProviderTable).all()).toEqual(before)
  })

  it('两家企业先后同步成功后，切回原企业同步失败时仅恢复原企业的配置和开关', async () => {
    seedXuelangProvider()
    const fetchMock = serve()
    const { auth, state } = createAuth()
    await sync.sync(auth)
    const [keyA] = providerService.getApiKeys(XUELANG_PROVIDER_ID)
    providerService.update(XUELANG_PROVIDER_ID, { isEnabled: false })
    providerService.updateApiKey(XUELANG_PROVIDER_ID, keyA.id, { isEnabled: false })
    modelService.update(XUELANG_PROVIDER_ID, 'chat-model', { isEnabled: false })

    const other = snapshot()
    other.tenantId = '10'
    other.providers[0].apiKey = 'sk-other-tenant'
    other.providers[0].models = [{ id: 'other-model', endpointTypes: [chat] }]
    state.session = { ...state.session, tenantId: other.tenantId }
    state.generation += 1
    fetchMock.mockResolvedValueOnce(Response.json({ code: 200, data: other }))
    await sync.sync(auth)
    expect(providerService.getApiKeys(XUELANG_PROVIDER_ID)).toMatchObject([{ key: 'sk-other-tenant', isEnabled: true }])
    expect(JSON.stringify(dbh.db.select().from(appStateTable).all())).not.toMatch(/sk-key-a|sk-other-tenant/)

    state.session = session()
    state.generation += 1
    fetchMock.mockResolvedValueOnce(Response.json({ code: 500 }))
    await expect(sync.sync(auth)).rejects.toThrow()
    expect(providerService.getByProviderId(XUELANG_PROVIDER_ID)).toMatchObject({
      hasManagedSnapshot: true,
      isEnabled: false,
      managedSyncState: 'failed'
    })
    expect(providerService.getApiKeys(XUELANG_PROVIDER_ID)).toMatchObject([
      { id: keyA.id, key: 'sk-key-a', isEnabled: false }
    ])
    expect(modelService.getByKey(XUELANG_PROVIDER_ID, 'chat-model')).toMatchObject({
      isEnabled: false,
      isDeprecated: false
    })
    expect(modelService.getByKey(XUELANG_PROVIDER_ID, 'other-model').isDeprecated).toBe(true)
  })

  it('请求未完成时显示同步中，退出后迟到的快照不能写入', async () => {
    seedXuelangProvider()
    let complete!: (value: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve
          })
      )
    )
    const { auth, state } = createAuth()
    const operation = sync.sync(auth)
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
    expect(providerService.getByProviderId(XUELANG_PROVIDER_ID).managedSyncState).toBe('syncing')
    state.active = false
    complete(Response.json({ code: 200, data: snapshot() }))
    await expect(operation).rejects.toThrow('session unavailable')
    expect(providerService.getApiKeys(XUELANG_PROVIDER_ID)).toEqual([])
    expect(modelService.list({ providerId: XUELANG_PROVIDER_ID })).toEqual([])
  })

  it('中途写入失败回滚整份配置与模型，并标记失败', async () => {
    seedXuelangProvider()
    serve()
    const { auth } = createAuth()
    await sync.sync(auth)
    const broadcast = vi.mocked(application.get('WindowManager').broadcast)
    broadcast.mockClear()
    const data = snapshot()
    data.providers[0].apiKey = 'sk-new-key'
    data.providers[0].models = [
      { id: 'chat-model', endpointTypes: [chat] },
      { id: 'rollback-model', endpointTypes: [chat] }
    ]
    serve(data)

    vi.spyOn(modelService, 'create').mockImplementationOnce(() => {
      throw new Error('disk write failed')
    })
    await expect(sync.sync(auth)).rejects.toThrow('disk write failed')
    expect(providerService.getApiKeys(XUELANG_PROVIDER_ID).map((key) => key.key)).toEqual(['sk-key-a'])
    expect(modelService.list({ providerId: XUELANG_PROVIDER_ID }).map((model) => model.apiModelId)).toEqual([
      'chat-model'
    ])
    expect(providerService.getByProviderId(XUELANG_PROVIDER_ID).managedSyncState).toBe('failed')
    expect(broadcast).toHaveBeenCalledWith(
      IpcChannel.DataApi_DataChanged,
      expect.arrayContaining([{ endpoint: '/providers/:providerId' }])
    )
    expect(JSON.stringify(broadcast.mock.calls)).not.toContain('sk-new-key')
  })

  it('未通过在线身份校验时不拉取模型配置', async () => {
    seedXuelangProvider()
    const fetchMock = serve()
    const { auth, state } = createAuth()
    state.verified = false
    await expect(sync.sync(auth)).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(providerService.getByProviderId(XUELANG_PROVIDER_ID).managedSyncState).toBe('idle')
    expect(providerService.getApiKeys(XUELANG_PROVIDER_ID)).toEqual([])
    expect(modelService.list({ providerId: XUELANG_PROVIDER_ID })).toEqual([])
  })
})
