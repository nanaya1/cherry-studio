import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtimeMocks = vi.hoisted(() => ({
  getValidAccessToken: vi.fn(),
  authenticatedFetch: vi.fn(),
  logout: vi.fn()
}))

const netMocks = vi.hoisted(() => ({
  fetch: vi.fn()
}))

vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  const result = mockApplicationFactory()
  const originalGet = result.application.get.getMockImplementation()!
  result.application.get.mockImplementation((name: string) => {
    if (name === 'OAuthRuntimeService') return runtimeMocks
    return originalGet(name)
  })
  return result
})

vi.mock('electron', () => ({
  net: {
    fetch: netMocks.fetch
  }
}))

import { CherryInOAuthService } from '../CherryInOAuthService'

// The gateway service is the shared CherryIN REST layer over the OAuth runtime.
describe('CherryInOAuthService (gateway provider)', () => {
  let service: CherryInOAuthService

  beforeEach(() => {
    vi.clearAllMocks()
    runtimeMocks.authenticatedFetch.mockImplementation(async (_providerId, buildRequest, doFetch) => {
      const { input, init } = buildRequest({ accessToken: 'oauth-access', accountId: null })
      return doFetch(input, init)
    })
    netMocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ success: true, data: { quota: 500000, used_quota: 0 } })
    })
    service = new CherryInOAuthService()
  })

  it('prefers available_balance over legacy quota', async () => {
    netMocks.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ success: true, data: { available_balance: 12.5, quota: 500000, used_quota: 0 } })
    })

    const result = await service.getBalance('https://open.cherryin.ai')

    expect(result.balance).toBe(12.5)
  })

  it('defaults to the cherryin provider id for legacy callers', async () => {
    await service.getBalance('https://open.cherryin.ai')

    expect(runtimeMocks.authenticatedFetch).toHaveBeenCalledWith(
      'cherryin',
      expect.any(Function),
      expect.any(Function),
      expect.anything()
    )
  })
})
