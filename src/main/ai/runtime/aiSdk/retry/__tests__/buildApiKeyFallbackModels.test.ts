import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ENDPOINT_TYPE } from '@shared/data/types/model'

import { makeModel, makeProvider } from '../../../../__tests__/fixtures'

const resolveLanguageModel = vi.fn()
vi.mock('@cherrystudio/ai-core', () => ({
  resolveLanguageModel: (...args: unknown[]) => resolveLanguageModel(...args)
}))

const buildAgentParams = vi.fn()
vi.mock('../../params/buildAgentParams', () => ({
  buildAgentParams: (...args: unknown[]) => buildAgentParams(...args)
}))

const getApiKeys = vi.fn()
const getXuelangApiKeys = vi.fn()
const getByProviderId = vi.fn()
const getByKey = vi.fn()
vi.mock('@main/data/services/ProviderService', () => ({
  providerService: { getApiKeys: (...args: unknown[]) => getApiKeys(...args), getXuelangApiKeys, getByProviderId }
}))
vi.mock('@main/data/services/ModelService', () => ({ modelService: { getByKey } }))

const { buildApiKeyFallbackModels } = await import('../buildApiKeyFallbackModels')

describe('buildApiKeyFallbackModels', () => {
  beforeEach(() => vi.clearAllMocks())

  it('builds the next enabled key lazily with its own usage attribution', async () => {
    const provider = makeProvider({ id: 'provider' })
    getApiKeys.mockReturnValue([
      { id: 'key-1', key: 'sk-1', isEnabled: true },
      { id: 'disabled', key: 'sk-disabled', isEnabled: false },
      { id: 'key-2', key: 'sk-2', isEnabled: true },
      { id: 'key-3', key: 'sk-3', isEnabled: true }
    ])
    const model = makeModel({ id: 'provider::model', providerId: 'provider', apiModelId: 'model' })
    const fallbackReceipt = { attribution: 'matched' as const, id: 'key-3', masked: 'sk-3****3333' }
    const featurePlugin = { name: 'feature' }
    const usagePlugin = { name: 'usage-key-3' }
    const repairToolCall = vi.fn()
    const createUsagePlugin = vi.fn().mockReturnValue(usagePlugin)
    buildAgentParams.mockResolvedValue({
      sdkConfig: { providerId: 'openai', providerSettings: { apiKey: 'sk-3' }, modelId: 'model' },
      credentialReceipt: fallbackReceipt,
      plugins: [featurePlugin],
      options: { repairToolCall }
    })
    const resolvedModel = { modelId: 'model' }
    resolveLanguageModel.mockResolvedValue(resolvedModel)

    const fallbacks = buildApiKeyFallbackModels({
      request: { uniqueModelId: 'provider::model' } as never,
      provider,
      model,
      assistant: undefined,
      signal: undefined,
      extraFeatures: [],
      primaryCredentialReceipt: { attribution: 'explicit', id: 'key-2', masked: 'sk-2****2222' },
      createUsagePlugin
    })

    expect(fallbacks).toHaveLength(2)
    expect(buildAgentParams).not.toHaveBeenCalled()

    await expect(fallbacks[0]()).resolves.toEqual({ model: resolvedModel, repairToolCall })
    expect(buildAgentParams).toHaveBeenCalledWith(
      expect.objectContaining({ request: expect.objectContaining({ apiKeyOverride: 'sk-3' }) })
    )
    expect(createUsagePlugin).toHaveBeenCalledWith(fallbackReceipt)
    expect(resolveLanguageModel).toHaveBeenCalledWith('openai', { apiKey: 'sk-3' }, 'model', [
      featurePlugin,
      usagePlugin
    ])
  })

  it('keeps retries on the primary protocol and skips a managed key revoked after planning', async () => {
    const chat = ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS
    const provider = makeProvider({ id: 'xuelang', isEnabled: true })
    const model = makeModel({
      id: 'xuelang::stored',
      providerId: 'xuelang',
      apiModelId: 'wire-model',
      endpointTypes: [chat, ENDPOINT_TYPE.ANTHROPIC_MESSAGES]
    })
    const endpoint = { endpointType: chat, baseUrl: 'https://primary.test/v1' }
    const primary = { id: 'primary', key: 'sk-primary', isEnabled: true }
    const revoked = { id: 'revoked', key: 'sk-revoked', isEnabled: true }
    const remaining = { id: 'remaining', key: 'sk-remaining', isEnabled: true }
    getByProviderId.mockReturnValue(provider)
    getByKey.mockReturnValue(model)
    getXuelangApiKeys.mockImplementation((id, type) =>
      id === 'wire-model' && type === chat ? [primary, revoked, remaining] : []
    )
    buildAgentParams.mockResolvedValue({
      sdkConfig: { providerId: 'cherryin-chat', providerSettings: { apiKey: remaining.key }, modelId: 'wire-model' },
      credentialReceipt: { attribution: 'matched', id: remaining.id, masked: 'sk-****' },
      plugins: [],
      options: {}
    })
    const resolvedModel = { modelId: 'wire-model' }
    resolveLanguageModel.mockResolvedValue(resolvedModel)
    const fallbacks = buildApiKeyFallbackModels({
      request: { uniqueModelId: model.id } as never,
      provider,
      model,
      assistant: undefined,
      signal: undefined,
      extraFeatures: [],
      resolvedEndpoint: endpoint,
      primaryCredentialReceipt: { attribution: 'explicit', id: primary.id, masked: 'sk-****' },
      createUsagePlugin: vi.fn()
    })

    expect(fallbacks).toHaveLength(2)
    getXuelangApiKeys.mockImplementation((id, type) =>
      id === 'wire-model' && type === chat ? [primary, remaining] : []
    )
    await expect(fallbacks[0]()).resolves.toBeNull()
    expect(buildAgentParams).not.toHaveBeenCalled()
    await expect(fallbacks[1]()).resolves.toMatchObject({ model: resolvedModel })
    expect(buildAgentParams).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedEndpoint: endpoint,
        request: expect.objectContaining({ apiKeyOverride: remaining.key })
      })
    )
  })

  it('does not read the key pool for an override or an unknown serving credential', () => {
    const provider = makeProvider({ id: 'provider' })
    const model = makeModel({ id: 'provider::model', providerId: 'provider', apiModelId: 'model' })
    const common = {
      provider,
      model,
      assistant: undefined,
      signal: undefined,
      extraFeatures: [],
      createUsagePlugin: vi.fn()
    }

    expect(
      buildApiKeyFallbackModels({
        ...common,
        request: { uniqueModelId: 'provider::model', apiKeyOverride: 'sk-override' } as never,
        primaryCredentialReceipt: { attribution: 'matched', id: 'key-1', masked: 'sk-1****1111' }
      })
    ).toEqual([])
    expect(
      buildApiKeyFallbackModels({
        ...common,
        request: { uniqueModelId: 'provider::model' } as never,
        primaryCredentialReceipt: { attribution: 'unknown' }
      })
    ).toEqual([])
    expect(getApiKeys).not.toHaveBeenCalled()
  })
})
