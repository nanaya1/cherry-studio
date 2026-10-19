import { afterEach, describe, expect, it, vi } from 'vitest'

import { ipcApi } from '@renderer/ipc'

import { oauthWithCherryIn, oauthWithPPIO, providerBills, providerCharge, provisionOAuthApiKeys } from '../oauth'

vi.mock('@renderer/ipc', () => ({
  ipcApi: {
    request: vi.fn().mockResolvedValue(undefined),
    on: vi.fn()
  }
}))
vi.mock('@renderer/i18n/resolver', () => ({ default: { t: (key: string) => key }, getLanguageCode: async () => 'en' }))
vi.mock('@renderer/services/toast', () => ({ toast: { error: vi.fn() } }))

describe('provider websites', () => {
  afterEach(() => vi.clearAllMocks())

  it('opens PPIO protocol-callback authorization in the system browser', async () => {
    await oauthWithPPIO(undefined)
    const [route, url] = vi.mocked(ipcApi.request).mock.calls[0]
    expect(route).toBe('system.shell.open_external_website')
    const authorization = new URL(url as string)
    expect(authorization.origin).toBe('https://ppio.com')
    expect(authorization.searchParams.get('redirect_uri')).toBe('meacowork-enterprise://')
  })

  it('starts Xuelang through the deep-link runtime and opens authorization externally', async () => {
    vi.mocked(ipcApi.request).mockImplementation((route: string) => {
      if (route === 'oauth.start_deep_link_flow') {
        return Promise.resolve({
          authUrl: 'https://api.xuelanglm.com/oauth2/auth?state=xuelang-state',
          state: 'xuelang-state'
        }) as never
      }
      return Promise.resolve(undefined) as never
    })
    vi.mocked(ipcApi.on).mockImplementation((_event, listener) => {
      queueMicrotask(() => listener({ state: 'xuelang-state', apiKeys: 'managed-key' }))
      return vi.fn()
    })
    const setKey = vi.fn()

    await expect(
      oauthWithCherryIn(setKey, {
        oauthServer: 'https://api.xuelanglm.com',
        providerId: 'xuelang'
      })
    ).resolves.toBe('managed-key')

    expect(ipcApi.request).toHaveBeenCalledWith('oauth.start_deep_link_flow', {
      providerId: 'xuelang',
      oauthServer: 'https://api.xuelanglm.com',
      apiHost: undefined
    })
    expect(ipcApi.request).toHaveBeenCalledWith(
      'system.shell.open_external_website',
      'https://api.xuelanglm.com/oauth2/auth?state=xuelang-state'
    )
    expect(setKey).toHaveBeenCalledWith('managed-key')
  })

  it('preserves Xuelang deep-link error codes for renderer i18n mapping', async () => {
    vi.mocked(ipcApi.request).mockImplementation((route: string) => {
      if (route === 'oauth.start_deep_link_flow') {
        return Promise.resolve({ authUrl: 'https://api.xuelanglm.com/oauth2/auth', state: 'state' }) as never
      }
      return Promise.resolve(undefined) as never
    })
    vi.mocked(ipcApi.on).mockImplementation((_event, listener) => {
      queueMicrotask(() => listener({ state: 'state', error: 'subscription missing', code: 'NO_ACTIVE_SUBSCRIPTION' }))
      return vi.fn()
    })

    await expect(
      oauthWithCherryIn(vi.fn(), { oauthServer: 'https://api.xuelanglm.com', providerId: 'xuelang' })
    ).rejects.toMatchObject({ message: 'subscription missing', code: 'NO_ACTIVE_SUBSCRIPTION' })
  })

  it('provisions API keys for the selected gateway provider', async () => {
    vi.mocked(ipcApi.request).mockResolvedValueOnce('managed-key')

    await expect(provisionOAuthApiKeys('xuelang')).resolves.toBe('managed-key')
    expect(ipcApi.request).toHaveBeenCalledWith('oauth.provision_api_keys', { providerId: 'xuelang' })
  })

  it.each([
    ['charge', providerCharge, 'https://tokendance.space/credits'],
    ['bills', providerBills, 'https://tokendance.space/activity/requests']
  ] as const)(
    'opens provider %s externally instead of losing the existing browser session',
    async (_name, open, url) => {
      await open('tokendance')
      expect(ipcApi.request).toHaveBeenCalledWith('system.shell.open_external_website', url)
    }
  )
})
