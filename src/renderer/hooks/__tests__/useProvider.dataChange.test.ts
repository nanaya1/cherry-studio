import { mockDataApiService, MockDataApiUtils } from '@test-mocks/renderer/DataApiService'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createSWRTestWrapper } from '@renderer/data/hooks/__tests__/testUtils'
import type { ConcreteApiPaths } from '@shared/data/api/types'
import type { Provider } from '@shared/data/types/provider'

import {
  useProviderApiKeys,
  useProviderAuthConfig,
  useProviderById,
  useProviderDisplayName,
  useProviders
} from '../useProvider'

// 使用真实查询、缓存和订阅，只在 IPC 数据边界提供确定的快照。
vi.unmock('@data/hooks/useDataApi')

function provider(name: string): Provider {
  return {
    id: 'cowork-auto-dev',
    name,
    reportsActualCost: false,
    apiKeys: [{ id: 'cowork', isEnabled: true }],
    authType: 'api-key',
    settings: {},
    isEnabled: true
  }
}

describe('Cowork 自动服务商的数据收敛', () => {
  beforeEach(() => MockDataApiUtils.resetMocks())

  it('登录后异步同步多把 Key，已挂载的服务商列表能显示新绑定', async () => {
    MockDataApiUtils.setCustomResponse('/providers', 'GET', [])
    const { Wrapper } = createSWRTestWrapper()
    const { result } = renderHook(() => useProviders(), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.hasLoaded).toBe(true))
    expect(result.current.providers).toEqual([])

    MockDataApiUtils.setCustomResponse('/providers', 'GET', [
      provider('Cowork · 开发'),
      { ...provider('Cowork · 生产'), id: 'cowork-auto-prod' }
    ])
    act(() => MockDataApiUtils.emitDataChange([{ endpoint: '/providers', kind: 'membership' }]))

    await waitFor(() =>
      expect(result.current.providers.map((item) => item.name)).toEqual(['Cowork · 开发', 'Cowork · 生产'])
    )
  })

  it('后台轮换 Key 与配置后，已打开的详情、名称和凭据读取更新为新快照', async () => {
    const initial = provider('旧名称')
    const responses = new Map<ConcreteApiPaths, unknown>([
      [`/providers/${initial.id}`, initial],
      [`/providers/${initial.id}/auth-config`, null],
      [`/providers/${initial.id}/api-keys`, { keys: [{ id: 'cowork', key: 'sk-old', isEnabled: true }] }]
    ])
    mockDataApiService.get.mockImplementation(async (path) => responses.get(path))
    const { Wrapper } = createSWRTestWrapper()
    const { result } = renderHook(
      () => ({
        detail: useProviderById(initial.id),
        name: useProviderDisplayName(initial.id),
        auth: useProviderAuthConfig(initial.id),
        keys: useProviderApiKeys(initial.id)
      }),
      { wrapper: Wrapper }
    )
    await waitFor(() => expect(result.current.keys.data?.keys[0].key).toBe('sk-old'))
    expect(result.current.name).toBe('旧名称')

    responses.set(`/providers/${initial.id}`, { ...initial, name: 'Cowork · 开发', isEnabled: false })
    responses.set(`/providers/${initial.id}/auth-config`, { type: 'api-key' })
    responses.set(`/providers/${initial.id}/api-keys`, { keys: [{ id: 'cowork', key: 'sk-new', isEnabled: false }] })
    act(() =>
      MockDataApiUtils.emitDataChange([
        { endpoint: '/providers/:providerId' },
        { endpoint: '/providers/:providerId/auth-config' },
        { endpoint: '/providers/:providerId/api-keys' }
      ])
    )

    await waitFor(() => {
      expect(result.current.detail.provider).toMatchObject({ name: 'Cowork · 开发', isEnabled: false })
      expect(result.current.name).toBe('Cowork · 开发')
      expect(result.current.auth.data).toEqual({ type: 'api-key' })
      expect(result.current.keys.data?.keys).toEqual([{ id: 'cowork', key: 'sk-new', isEnabled: false }])
    })
  })
})
