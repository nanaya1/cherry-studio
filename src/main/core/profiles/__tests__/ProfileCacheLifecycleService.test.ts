import { beforeEach, describe, expect, it, vi } from 'vitest'

import { BaseService } from '@main/core/lifecycle'

const cacheMocks = vi.hoisted(() => ({
  copilot: vi.fn(),
  enterprise: vi.fn(),
  provider: vi.fn()
}))

vi.mock('@main/services/CopilotService', () => ({
  copilotService: { resetProfileCache: cacheMocks.copilot }
}))

vi.mock('@main/enterprise/OrgStateStore', () => ({
  orgStateStore: { resetProfileCache: cacheMocks.enterprise }
}))

vi.mock('@main/data/services/ProviderRegistryService', () => ({
  providerRegistryService: { clearCache: cacheMocks.provider }
}))

import { ProfileCacheLifecycleService } from '../ProfileCacheLifecycleService'

describe('ProfileCacheLifecycleService', () => {
  beforeEach(() => {
    BaseService.resetInstances()
    vi.clearAllMocks()
  })

  it('clears every profile-bound module cache when the lifecycle stops', async () => {
    const service = new ProfileCacheLifecycleService()

    await service._doStop()

    expect(cacheMocks.copilot).toHaveBeenCalledOnce()
    expect(cacheMocks.enterprise).toHaveBeenCalledOnce()
    expect(cacheMocks.provider).toHaveBeenCalledOnce()
  })
})
