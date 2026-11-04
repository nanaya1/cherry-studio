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
  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('opens PPIO protocol-callback authorization in the system browser', async () => {
    await oauthWithPPIO(undefined)
    const [route, url] = vi.mocked(ipcApi.request).mock.calls[0]
    expect(route).toBe('system.shell.open_external_website')
    const authorization = new URL(url as string)
    expect(authorization.origin).toBe('https://ppio.com')
    expect(authorization.searchParams.get('redirect_uri')).toBe('meacowork://')
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
      queueMicrotask(() => listener({ state: 'xuelang-state', requestId: 'test-request', apiKeys: 'managed-key' }))
      return vi.fn()
    })
    const setKey = vi.fn()

    await expect(
      oauthWithCherryIn(setKey, {
        oauthServer: 'https://api.xuelanglm.com',
        providerId: 'xuelang',
        requestId: 'test-request'
      })
    ).resolves.toBe('managed-key')

    expect(ipcApi.request).toHaveBeenCalledWith('oauth.start_deep_link_flow', {
      providerId: 'xuelang',
      oauthServer: 'https://api.xuelanglm.com',
      apiHost: undefined,
      requestId: 'test-request'
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
      queueMicrotask(() =>
        listener({
          state: 'state',
          requestId: 'test-request',
          error: 'subscription missing',
          code: 'NO_ACTIVE_SUBSCRIPTION'
        })
      )
      return vi.fn()
    })

    await expect(
      oauthWithCherryIn(vi.fn(), {
        oauthServer: 'https://api.xuelanglm.com',
        providerId: 'xuelang',
        requestId: 'test-request'
      })
    ).rejects.toMatchObject({ message: 'subscription missing', code: 'NO_ACTIVE_SUBSCRIPTION' })
  })

  it.each(['start', 'browser', 'save'])('expires the entire Xuelang attempt while %s is blocked', async (phase) => {
    vi.useFakeTimers()
    let deliver!: (result: any) => void
    const setKey = vi.fn(() => (phase === 'save' ? new Promise<void>(() => {}) : undefined))
    vi.mocked(ipcApi.on).mockImplementation((_event, listener) => {
      deliver = listener
      return vi.fn()
    })
    vi.mocked(ipcApi.request).mockImplementation((route: string) => {
      if (route === 'oauth.start_deep_link_flow') {
        return (
          phase === 'start'
            ? new Promise(() => {})
            : Promise.resolve({ authUrl: 'https://api.xuelanglm.com/oauth2/auth', state: 'state' })
        ) as never
      }
      if (route === 'system.shell.open_external_website' && phase === 'browser') return new Promise(() => {}) as never
      return Promise.resolve(undefined) as never
    })
    const outcome = oauthWithCherryIn(setKey, {
      oauthServer: 'https://api.xuelanglm.com',
      providerId: 'xuelang',
      requestId: 'attempt'
    }).catch((error) => error)
    await vi.advanceTimersByTimeAsync(0)
    if (phase === 'save') deliver({ state: 'state', requestId: 'attempt', apiKeys: 'key' })
    await vi.advanceTimersByTimeAsync(600_000)
    let result: unknown
    void outcome.then((value) => {
      result = value
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(result).toMatchObject({ message: 'OAuth flow timed out' })
    expect(ipcApi.request).toHaveBeenCalledWith('oauth.cancel_sign_in', { providerId: 'xuelang', requestId: 'attempt' })
    vi.useRealTimers()
  })

  it('ignores a result belonging to another Xuelang request even when state matches', async () => {
    vi.mocked(ipcApi.request).mockImplementation(
      (route: string) =>
        Promise.resolve(
          route === 'oauth.start_deep_link_flow'
            ? { authUrl: 'https://api.xuelanglm.com/oauth2/auth', state: 'state' }
            : undefined
        ) as never
    )
    let deliver!: (result: any) => void
    vi.mocked(ipcApi.on).mockImplementation((_event, listener) => {
      deliver = listener
      return vi.fn()
    })
    const setKey = vi.fn()
    const login = oauthWithCherryIn(setKey, {
      oauthServer: 'https://api.xuelanglm.com',
      providerId: 'xuelang',
      requestId: 'current'
    })
    await Promise.resolve()
    deliver({ state: 'state', requestId: 'old', apiKeys: 'wrong-key' })
    await Promise.resolve()
    expect(setKey).not.toHaveBeenCalled()
    deliver({ state: 'state', requestId: 'current', apiKeys: 'right-key' })
    await expect(login).resolves.toBe('right-key')
  })

  it('cancels a blocked start immediately and ignores its late authorization URL', async () => {
    let release!: (flow: { authUrl: string; state: string }) => void
    vi.mocked(ipcApi.request).mockImplementation((route: string) => {
      if (route === 'oauth.start_deep_link_flow')
        return new Promise((resolve) => {
          release = resolve
        }) as never
      return Promise.resolve(undefined) as never
    })
    const controller = new AbortController()
    const setKey = vi.fn()
    const login = oauthWithCherryIn(setKey, {
      oauthServer: 'https://api.xuelanglm.com',
      providerId: 'xuelang',
      requestId: 'cancelled',
      signal: controller.signal
    })
    const outcome = expect(login).rejects.toMatchObject({ code: 'OAUTH_SIGN_IN_CANCELLED' })
    controller.abort()
    await outcome
    release({ authUrl: 'https://api.xuelanglm.com/oauth2/auth', state: 'late' })
    await Promise.resolve()
    expect(ipcApi.request).not.toHaveBeenCalledWith('system.shell.open_external_website', expect.anything())
    expect(setKey).not.toHaveBeenCalled()
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
