import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PROVIDER_SETTINGS_MODEL_SWR_OPTIONS } from '../providerSetting/constants'
import { useProviderModelSync } from '../useProviderModelSync'

const dataApiGetMock = vi.fn()
const useModelsMock = vi.fn()
const useProviderMock = vi.fn()
const createModelsMock = vi.fn()
const fetchResolvedProviderModelsMock = vi.fn()
const resolveCreateModelEndpointTypesMock = vi.fn()

vi.mock('@data/DataApiService', () => ({
  dataApiService: {
    get: (...args: any[]) => dataApiGetMock(...args)
  }
}))

vi.mock('@renderer/hooks/useModel', () => ({
  useModels: (...args: any[]) => useModelsMock(...args),
  useModelMutations: () => ({
    createModels: createModelsMock,
    isCreating: false
  })
}))

vi.mock('@renderer/hooks/useProvider', () => ({
  useProvider: (...args: any[]) => useProviderMock(...args)
}))

vi.mock('../../utils/modelSync', () => ({
  fetchResolvedProviderModels: (...args: any[]) => fetchResolvedProviderModelsMock(...args),
  resolveCreateModelEndpointTypes: (...args: any[]) => resolveCreateModelEndpointTypesMock(...args),
  toCreateModelDto: (_providerId: string, model: any, endpointTypes: any) => ({
    providerId: model.providerId,
    modelId: model.id.split(':')[1],
    name: model.name,
    endpointTypes
  })
}))

describe('useProviderModelSync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useModelsMock.mockReturnValue({ models: [] })
    useProviderMock.mockReturnValue({ provider: { id: 'openai' } })
    createModelsMock.mockResolvedValue([])
    dataApiGetMock.mockResolvedValue([])
    resolveCreateModelEndpointTypesMock.mockReturnValue(undefined)
  })

  it('disables fallback model fetching when existing models are supplied', async () => {
    const existingModels = [{ id: 'openai:model-alpha', providerId: 'openai', name: 'Alpha' }] as any
    const { result } = renderHook(() => useProviderModelSync('openai', { existingModels }))

    await act(async () => {
      await result.current.syncProviderModels()
    })

    expect(useModelsMock).toHaveBeenCalledWith(
      { providerId: 'openai' },
      {
        fetchEnabled: false,
        swrOptions: PROVIDER_SETTINGS_MODEL_SWR_OPTIONS
      }
    )
    expect(dataApiGetMock).not.toHaveBeenCalled()
    expect(fetchResolvedProviderModelsMock).not.toHaveBeenCalled()
    expect(createModelsMock).not.toHaveBeenCalled()
  })

  it('checks the latest server models before inserting and skips create when any already exist', async () => {
    const serverModels = [{ id: 'zhipu::glm-4.5', providerId: 'zhipu', name: 'GLM-4.5' }] as any
    dataApiGetMock.mockResolvedValue(serverModels)

    const { result } = renderHook(() => useProviderModelSync('zhipu', { existingModels: [] }))

    await act(async () => {
      const synced = await result.current.syncProviderModels()
      expect(synced).toEqual(serverModels)
    })

    expect(dataApiGetMock).toHaveBeenCalledWith('/models', {
      query: { providerId: 'zhipu' }
    })
    expect(fetchResolvedProviderModelsMock).not.toHaveBeenCalled()
    expect(createModelsMock).not.toHaveBeenCalled()
  })

  it('creates models only when both current snapshot and latest server models are empty', async () => {
    fetchResolvedProviderModelsMock.mockResolvedValue({
      models: [
        { id: 'openai:model-alpha', providerId: 'openai', name: 'Alpha' },
        { id: 'openai:model-beta', providerId: 'openai', name: 'Beta' }
      ]
    })
    createModelsMock.mockResolvedValue([{ id: 'openai:model-alpha' }, { id: 'openai:model-beta' }])

    const { result } = renderHook(() => useProviderModelSync('openai', { existingModels: [] }))

    await act(async () => {
      await result.current.syncProviderModels()
    })

    expect(dataApiGetMock).toHaveBeenCalledWith('/models', {
      query: { providerId: 'openai' }
    })
    expect(fetchResolvedProviderModelsMock).toHaveBeenCalledWith('openai')
    expect(createModelsMock).toHaveBeenCalledTimes(1)
  })

  it('resolves endpoint types with the current provider before creating models', async () => {
    const provider = { id: 'new-api', defaultChatEndpoint: 'openai-chat-completions' }
    const model = { id: 'new-api:model-alpha', providerId: 'new-api', name: 'Alpha' }
    useProviderMock.mockReturnValue({ provider })
    fetchResolvedProviderModelsMock.mockResolvedValue({ models: [model] })
    resolveCreateModelEndpointTypesMock.mockReturnValue(['openai-chat-completions'])
    createModelsMock.mockResolvedValue([{ id: 'new-api:model-alpha' }])

    const { result } = renderHook(() => useProviderModelSync('new-api', { existingModels: [] }))

    await act(async () => {
      await result.current.syncProviderModels()
    })

    expect(resolveCreateModelEndpointTypesMock).toHaveBeenCalledWith(provider, model)
    expect(createModelsMock).toHaveBeenCalledWith([
      {
        providerId: 'new-api',
        modelId: 'model-alpha',
        name: 'Alpha',
        endpointTypes: ['openai-chat-completions']
      }
    ])
  })

  it('fills missing models from fresh storage without overwriting custom or disabled models', async () => {
    const existing = { id: 'xuelang::alpha', providerId: 'xuelang', name: 'Custom', isEnabled: false }
    const beta = { id: 'xuelang::beta', providerId: 'xuelang', name: 'Beta' }
    useModelsMock.mockReturnValue({ models: [{ ...existing, name: 'Stale' }] })
    dataApiGetMock.mockResolvedValue([existing])
    fetchResolvedProviderModelsMock.mockResolvedValue({ models: [{ ...existing, name: 'Remote' }, beta] })
    createModelsMock.mockResolvedValue([beta])
    const { result } = renderHook(() => useProviderModelSync('xuelang', { fillMissingOnly: true }))

    await act(async () => {
      expect(await result.current.syncProviderModels()).toEqual([existing, beta])
    })
    expect(createModelsMock).toHaveBeenCalledTimes(1)
    expect(createModelsMock).toHaveBeenCalledWith([expect.objectContaining({ name: 'Beta' })])
  })

  it('does not write models when a login expires while fetching the remote list', async () => {
    let current = true
    fetchResolvedProviderModelsMock.mockImplementation(async () => {
      current = false
      return { models: [{ id: 'xuelang::beta', providerId: 'xuelang', name: 'Beta' }] }
    })
    const { result } = renderHook(() => useProviderModelSync('xuelang', { fillMissingOnly: true }))
    await act(async () => {
      await result.current.syncProviderModels(undefined, () => current)
    })
    expect(createModelsMock).not.toHaveBeenCalled()
  })

  it('does not recreate existing models on repeated fill-only syncs', async () => {
    const model = { id: 'xuelang::alpha', providerId: 'xuelang', name: 'Alpha' }
    dataApiGetMock.mockResolvedValueOnce([]).mockResolvedValue([model])
    fetchResolvedProviderModelsMock.mockResolvedValue({ models: [model] })
    createModelsMock.mockResolvedValue([model])
    const { result } = renderHook(() => useProviderModelSync('xuelang', { fillMissingOnly: true }))
    await act(async () => {
      expect(await result.current.syncProviderModels()).toEqual([model])
      expect(await result.current.syncProviderModels()).toEqual([model])
    })
    expect(createModelsMock).toHaveBeenCalledTimes(1)
  })

  it('uses an endpoint provider override when settings changed before the hook rerenders', async () => {
    const currentProvider = { id: 'new-api', defaultChatEndpoint: 'openai-chat-completions' }
    const updatedProvider = { id: 'new-api', defaultChatEndpoint: 'anthropic-messages' }
    const model = { id: 'new-api:model-alpha', providerId: 'new-api', name: 'Alpha' }
    useProviderMock.mockReturnValue({ provider: currentProvider })
    fetchResolvedProviderModelsMock.mockResolvedValue({ models: [model] })
    resolveCreateModelEndpointTypesMock.mockReturnValue(['anthropic-messages'])
    createModelsMock.mockResolvedValue([{ id: 'new-api:model-alpha' }])

    const { result } = renderHook(() => useProviderModelSync('new-api', { existingModels: [] }))

    await act(async () => {
      await result.current.syncProviderModels(updatedProvider as any)
    })

    expect(resolveCreateModelEndpointTypesMock).toHaveBeenCalledWith(updatedProvider, model)
  })
})
