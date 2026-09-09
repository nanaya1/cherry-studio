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

// The gateway service is one implementation behind per-provider hosts: xuelang
// must drive the runtime with ITS provider id and only ITS own host.
describe('CherryInOAuthService (gateway providers)', () => {
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
    } as Response)
    service = new CherryInOAuthService()
  })

  it('fetches balance for xuelang under the xuelang provider id and host', async () => {
    const result = await service.getBalance('https://api.xuelanglm.com', 'xuelang')

    expect(result.balance).toBe(1)
    expect(runtimeMocks.authenticatedFetch).toHaveBeenCalledWith(
      'xuelang',
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({ context: { apiHost: 'https://api.xuelanglm.com' } })
    )
    expect(netMocks.fetch).toHaveBeenCalledWith(
      'https://api.xuelanglm.com/api/v1/oauth/balance',
      expect.anything()
    )
  })

  it('rejects a cherryin host used against the xuelang allowlist', async () => {
    await expect(service.getBalance('https://open.cherryin.ai', 'xuelang')).rejects.toThrow(/Unauthorized API host/)
    await expect(service.logout('https://open.cherryin.ai', 'xuelang')).rejects.toThrow(/Unauthorized API host/)
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
