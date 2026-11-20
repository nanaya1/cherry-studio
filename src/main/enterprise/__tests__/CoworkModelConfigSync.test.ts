import { setupTestDatabase } from '@test-helpers/db'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { application } from '@application'
import { userModelTable } from '@data/db/schemas/userModel'
import { userProviderTable } from '@data/db/schemas/userProvider'
import { modelService } from '@data/services/ModelService'
import { providerService } from '@data/services/ProviderService'
import { ENDPOINT_TYPE } from '@shared/data/types/model'
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
  const sync = new CoworkModelConfigSync()

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function serve(data = snapshot()) {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ code: 200, data }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('每个 Key 创建独立服务商和授权模型，并保留手动同名配置与默认模型', async () => {
    const broadcast = vi.mocked(application.get('WindowManager').broadcast)
    broadcast.mockClear()
    providerService.create({
      providerId: 'manual',
      name: 'Cowork 开发',
      apiKeys: [{ id: 'user-key', key: 'sk-manual', isEnabled: true }]
    })
    modelService.create([{ dto: { providerId: 'manual', modelId: 'user-model' } }])
    await application.get('PreferenceService').set('chat.default_model_id', 'manual::user-model')
    const data = snapshot()
    data.providers.push({
      ...data.providers[0],
      id: 'key-43',
      name: 'Cowork 生产',
      apiKey: 'sk-key-b',
      models: [{ id: 'production-model', endpointTypes: [chat] }]
    })
    serve(data)
    const { auth } = createAuth()

    await expect(sync.sync(auth)).resolves.toEqual({ providerCount: 2, modelCount: 2 })
    const providers = providerService.list({}).filter((provider) => provider.id !== 'manual')
    expect(providers).toHaveLength(2)
    expect(providers.every((provider) => provider.isEnabled && provider.apiKeys.length === 1)).toBe(true)
    for (const provider of providers) {
      const production = provider.name === 'Cowork 生产'
      expect(providerService.getRotatedApiKey(provider.id)).toBe(production ? 'sk-key-b' : 'sk-key-a')
      expect(modelService.list({ providerId: provider.id }).map((model) => model.apiModelId)).toEqual([
        production ? 'production-model' : 'chat-model'
      ])
      expect(JSON.stringify(provider)).not.toContain('sk-key-')
    }
    expect(providerService.getRotatedApiKey('manual')).toBe('sk-manual')
    expect(application.get('PreferenceService').get('chat.default_model_id')).toBe('manual::user-model')
    // 通知必须覆盖已挂载的列表、详情和凭据读模型，且不向事件载荷复制明文 Key。
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

  it('重复同步原位更新地址、Key 和模型，不增加记录也不重排', async () => {
    const data = snapshot()
    serve(data)
    const { auth } = createAuth()
    await sync.sync(auth)
    const before = dbh.db.select().from(userProviderTable).all()[0]
    data.providers[0].apiKey = 'sk-rotated'
    data.providers[0].endpointConfigs[chat]!.baseUrl = 'https://new-models.test/v1'
    data.providers[0].models[0].name = '更新后的名称'
    await sync.sync(auth)

    const rows = dbh.db.select().from(userProviderTable).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].providerId).toBe(before.providerId)
    expect(rows[0].orderKey).toBe(before.orderKey)
    expect(rows[0].apiKeys).toEqual([{ id: 'cowork', key: 'sk-rotated', isEnabled: true }])
    expect(providerService.getByProviderId(rows[0].providerId).endpointConfigs?.[chat]?.baseUrl).toBe(
      'https://new-models.test/v1'
    )
    expect(modelService.list({})).toHaveLength(1)
    expect(modelService.list({})[0].name).toBe('更新后的名称')
  })

  it('完整快照移除 Key 后停用凭据与模型，并保留历史引用；恢复后重新启用', async () => {
    const data = snapshot()
    serve(data)
    const { auth } = createAuth()
    await sync.sync(auth)
    const original = data.providers
    data.providers = []
    await sync.sync(auth)

    const provider = providerService.list({})[0]
    expect(provider.isEnabled).toBe(false)
    expect(providerService.getRotatedApiKey(provider.id)).toBe('')
    expect(modelService.list({})[0]).toMatchObject({ isEnabled: false, isDeprecated: true })
    expect(dbh.db.select().from(userModelTable).all()).toHaveLength(1)

    data.providers = original
    await sync.sync(auth)
    expect(providerService.list({})).toHaveLength(1)
    expect(providerService.list({})[0].isEnabled).toBe(true)
    expect(modelService.list({})[0]).toMatchObject({ isEnabled: true, isDeprecated: false })
  })

  it('模型权限变化只停用已移除的模型，空模型列表不会填入默认模型', async () => {
    const data = snapshot()
    serve(data)
    const { auth } = createAuth()
    await sync.sync(auth)
    data.providers[0].models = []
    await sync.sync(auth)
    expect(providerService.list({})[0].isEnabled).toBe(true)
    expect(modelService.list({ enabled: true })).toEqual([])
    expect(modelService.list({})).toHaveLength(1)
    expect(modelService.list({})[0].isEnabled).toBe(false)
  })

  it('按声明的嵌入协议生成能力标签，不将嵌入模型混入普通对话', async () => {
    const data = snapshot()
    data.providers[0].endpointConfigs[ENDPOINT_TYPE.OPENAI_EMBEDDINGS] = { baseUrl: 'https://models.test/v1' }
    data.providers[0].models = [{ id: 'opaque-model-123', endpointTypes: [ENDPOINT_TYPE.OPENAI_EMBEDDINGS] }]
    serve(data)
    const { auth } = createAuth()
    await sync.sync(auth)
    expect(modelService.list({ capability: 'embedding' }).map((model) => model.apiModelId)).toEqual([
      'opaque-model-123'
    ])
  })

  it.each(['tenantId', 'userId', 'issuerId', 'authOrigin'] as const)(
    '%s 变化不覆盖原绑定，接口失败时也不能继续使用旧身份凭据',
    async (field) => {
      const data = snapshot()
      const fetchMock = serve(data)
      const { auth, state } = createAuth()
      await sync.sync(auth)
      const oldId = providerService.list({})[0].id
      state.session = { ...state.session, [field]: field === 'authOrigin' ? 'https://other-cowork.test' : 'other' }
      state.generation += 1
      fetchMock.mockRejectedValueOnce(new Error('network unavailable'))
      await expect(sync.sync(auth)).rejects.toThrow()
      expect(providerService.getByProviderId(oldId).isEnabled).toBe(false)
      expect(providerService.getRotatedApiKey(oldId)).toBe('')
      data.serverInstanceId = state.session.issuerId
      data.userId = state.session.userId
      data.tenantId = state.session.tenantId
      await sync.sync(auth)
      const providers = providerService.list({})
      expect(providers).toHaveLength(2)
      expect(providers.filter((provider) => provider.isEnabled)).toHaveLength(1)
      expect(providers.find((provider) => provider.id !== oldId)?.isEnabled).toBe(true)
    }
  )

  it.each([500, 10007])('同身份业务失败 %s 不清空已有配置', async (code) => {
    const fetchMock = serve()
    const { auth } = createAuth()
    await sync.sync(auth)
    const before = dbh.db.select().from(userProviderTable).all()
    fetchMock.mockResolvedValueOnce(Response.json({ code }))
    await expect(sync.sync(auth)).rejects.toThrow()
    expect(dbh.db.select().from(userProviderTable).all()).toEqual(before)
    expect(modelService.list({ enabled: true })).toHaveLength(1)
  })

  it('错误身份快照不写入、不停用当前服务商', async () => {
    const data = snapshot()
    serve(data)
    const { auth } = createAuth()
    await sync.sync(auth)
    const before = dbh.db.select().from(userProviderTable).all()
    data.tenantId = 'other'
    await expect(sync.sync(auth)).rejects.toThrow('不一致')
    expect(dbh.db.select().from(userProviderTable).all()).toEqual(before)
  })

  it('请求未完成时退出或切换企业，迟到快照不能写入', async () => {
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
    state.active = false
    complete(Response.json({ code: 200, data: snapshot() }))
    await expect(operation).rejects.toThrow('session unavailable')
    expect(dbh.db.select().from(userProviderTable).all()).toEqual([])
    expect(modelService.list({})).toEqual([])
  })

  it('中途模型写入失败回滚整份配置，保留旧 Key 与旧授权', async () => {
    const data = snapshot()
    serve(data)
    const { auth } = createAuth()
    await sync.sync(auth)
    const broadcast = vi.mocked(application.get('WindowManager').broadcast)
    broadcast.mockClear()
    const before = dbh.db.select().from(userProviderTable).all()
    data.providers[0].apiKey = 'sk-new-key'
    data.providers[0].models = [{ id: 'new-model', endpointTypes: [chat] }]
    vi.spyOn(modelService, 'create').mockImplementationOnce(() => {
      throw new Error('disk write failed')
    })
    await expect(sync.sync(auth)).rejects.toThrow('disk write failed')
    expect(dbh.db.select().from(userProviderTable).all()).toEqual(before)
    expect(modelService.list({ enabled: true }).map((model) => model.apiModelId)).toEqual(['chat-model'])
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('未通过在线身份校验时不拉取模型配置', async () => {
    const fetchMock = serve()
    const { auth, state } = createAuth()
    state.verified = false
    await expect(sync.sync(auth)).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(providerService.list({})).toEqual([])
  })
})
