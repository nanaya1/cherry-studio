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
    expect(authorization.searchParams.get('redirect_uri')).toBe('meacowork://')
  })

  it('starts CherryIN through its loopback runtime', async () => {
    vi.mocked(ipcApi.request).mockResolvedValueOnce({ apiKeys: 'managed-key' } as never)
    const setKey = vi.fn()

    await expect(oauthWithCherryIn(setKey, { oauthServer: 'https://open.cherryin.ai' })).resolves.toBe('managed-key')

    expect(ipcApi.request).toHaveBeenCalledWith(
      'cherryin.sign_in',
      expect.objectContaining({ oauthServer: 'https://open.cherryin.ai' })
    )
    expect(setKey).toHaveBeenCalledWith('managed-key')
  })

  it('provisions API keys for the CherryIN gateway provider', async () => {
    vi.mocked(ipcApi.request).mockResolvedValueOnce('managed-key')

    await expect(provisionOAuthApiKeys()).resolves.toBe('managed-key')
    expect(ipcApi.request).toHaveBeenCalledWith('oauth.provision_api_keys', { providerId: 'cherryin' })
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
