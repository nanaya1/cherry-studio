import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ipcApi } from '@renderer/ipc'

const mocks = vi.hoisted(() => ({
  decrypt: vi.fn(),
  getLanguageCode: vi.fn(async () => 'en-US'),
  loggerError: vi.fn(),
  toastError: vi.fn(),
  translate: vi.fn((key: string) => key)
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      debug: vi.fn(),
      error: mocks.loggerError,
      warn: vi.fn()
    })
  }
}))

vi.mock('@renderer/i18n/resolver', () => ({
  default: { t: mocks.translate },
  getLanguageCode: mocks.getLanguageCode
}))

vi.mock('@renderer/ipc', () => ({
  ipcApi: {
    on: vi.fn(),
    request: vi.fn()
  }
}))

vi.mock('@renderer/services/toast', () => ({
  toast: { error: mocks.toastError }
}))

import {
  oauthWith302AI,
  oauthWithAihubmix,
  oauthWithAiOnly,
  oauthWithCherryIn,
  oauthWithPPIO,
  providerBills,
  providerCharge,
  provisionOAuthApiKeys
} from '../oauth'

interface MockPopup {
  closed: boolean
  close: ReturnType<typeof vi.fn>
}

const openedPopups: MockPopup[] = []

function createPopup(): MockPopup {
  const popup: MockPopup = {
    closed: false,
    close: vi.fn(() => {
      popup.closed = true
    })
  }
  openedPopups.push(popup)
  return popup
}

function dispatchPopupMessage(popup: MockPopup, origin: string, data: unknown): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data,
      origin,
      source: popup as unknown as Window
    })
  )
}

describe('popup message OAuth flows', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    openedPopups.length = 0
    mocks.getLanguageCode.mockResolvedValue('en-US')
    mocks.decrypt.mockResolvedValue(JSON.stringify({ api_keys: [{ value: 'aihubmix-key' }] }))

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { aes: { decrypt: mocks.decrypt } }
    })
    vi.spyOn(window, 'open').mockImplementation(() => createPopup() as unknown as Window)
  })

  afterEach(() => {
    for (const popup of openedPopups) popup.closed = true
    vi.advanceTimersByTime(500)
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('accepts only the expected AiOnly popup and origin, then removes the listener', async () => {
    const setKey = vi.fn()
    await oauthWithAiOnly(setKey)
    const popup = openedPopups[0]
    const otherPopup = createPopup()
    const payload = [{ secretKey: 'aionly-key' }]

    dispatchPopupMessage(popup, 'https://attacker.example', payload)
    dispatchPopupMessage(otherPopup, 'https://maas.aiionly.com', payload)
    expect(setKey).not.toHaveBeenCalled()

    dispatchPopupMessage(popup, 'https://maas.aiionly.com', payload)
    await vi.waitFor(() => expect(setKey).toHaveBeenCalledWith('aionly-key'))

    expect(setKey).toHaveBeenCalledOnce()
    expect(popup.close).toHaveBeenCalledOnce()

    dispatchPopupMessage(popup, 'https://maas.aiionly.com', payload)
    expect(setKey).toHaveBeenCalledOnce()
  })

  it('retires the previous handler when another flow reuses the oauth popup name', async () => {
    const setAihubmixKey = vi.fn()
    const set302Key = vi.fn()
    await oauthWithAihubmix(setAihubmixKey)
    const aihubmixPopup = openedPopups[0]

    await oauthWith302AI(set302Key)
    const popup302 = openedPopups[1]

    dispatchPopupMessage(aihubmixPopup, 'https://console.inferera.com', {
      key: 'cherry_studio_oauth_callback',
      data: { iv: 'iv', encryptedData: 'ciphertext' }
    })
    dispatchPopupMessage(popup302, 'https://dash.302.ai', { data: { apikey: '302-key' } })
    await vi.waitFor(() => expect(set302Key).toHaveBeenCalledWith('302-key'))

    expect(setAihubmixKey).not.toHaveBeenCalled()
  })

  it('keeps the previous flow active when its replacement popup is blocked', async () => {
    const setAihubmixKey = vi.fn()
    await oauthWithAihubmix(setAihubmixKey)
    const aihubmixPopup = openedPopups[0]

    vi.mocked(window.open).mockReturnValueOnce(null)
    await oauthWith302AI(vi.fn())

    dispatchPopupMessage(aihubmixPopup, 'https://console.inferera.com', {
      key: 'cherry_studio_oauth_callback',
      data: { iv: 'iv', encryptedData: 'ciphertext' }
    })
    await vi.waitFor(() => expect(setAihubmixKey).toHaveBeenCalledWith('aihubmix-key'))
  })

  it.each([
    ['charge', providerCharge],
    ['bills', providerBills]
  ] as const)('preserves the OAuth handler when %s opens in the system browser', async (_label, openPage) => {
    const setKey = vi.fn()
    await oauthWithAiOnly(setKey)
    const oauthPopup = openedPopups[0]

    await openPage('silicon')
    dispatchPopupMessage(oauthPopup, 'https://maas.aiionly.com', [{ secretKey: 'stale-key' }])

    await vi.waitFor(() => expect(setKey).toHaveBeenCalledWith('stale-key'))
  })

  it('removes a handler when its popup closes', async () => {
    const setKey = vi.fn()
    await oauthWith302AI(setKey)
    const popup = openedPopups[0]

    popup.closed = true
    vi.advanceTimersByTime(500)
    dispatchPopupMessage(popup, 'https://dash.302.ai', { data: { apikey: 'late-key' } })

    expect(setKey).not.toHaveBeenCalled()
  })

  it('removes a handler when the flow times out', async () => {
    const setKey = vi.fn()
    await oauthWith302AI(setKey)
    const popup = openedPopups[0]

    vi.advanceTimersByTime(10 * 60 * 1000)
    dispatchPopupMessage(popup, 'https://dash.302.ai', { data: { apikey: 'late-key' } })

    expect(setKey).not.toHaveBeenCalled()
  })

  it('opens Aihubmix without the client_id that stalls its key page', async () => {
    await oauthWithAihubmix(vi.fn())
    const url = new URL(String(vi.mocked(window.open).mock.calls[0][0]))
    expect(url.searchParams.has('client_id')).toBe(false)
    expect(url.searchParams.get('lang')).toBe('en-US')
    expect(url.searchParams.get('aff')).toBe('SJyh')
  })

  it('cleans up a recognized malformed Aihubmix callback', async () => {
    const setKey = vi.fn()
    await oauthWithAihubmix(setKey)
    const popup = openedPopups[0]

    dispatchPopupMessage(popup, 'https://console.inferera.com', {
      key: 'cherry_studio_oauth_callback',
      data: { iv: 42 }
    })
    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('settings.provider.oauth.error'))

    expect(mocks.decrypt).not.toHaveBeenCalled()
    expect(setKey).not.toHaveBeenCalled()
    expect(popup.close).toHaveBeenCalledOnce()

    dispatchPopupMessage(popup, 'https://console.inferera.com', {
      key: 'cherry_studio_oauth_callback',
      data: { iv: 'iv', encryptedData: 'ciphertext' }
    })
    expect(mocks.decrypt).not.toHaveBeenCalled()
  })

  it('finishes processing a valid callback after its popup closes', async () => {
    let resolveDecryption: (value: string) => void = () => undefined
    mocks.decrypt.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveDecryption = resolve
      })
    )
    const setKey = vi.fn()
    await oauthWithAihubmix(setKey)
    const popup = openedPopups[0]

    dispatchPopupMessage(popup, 'https://console.inferera.com', {
      key: 'cherry_studio_oauth_callback',
      data: { iv: 'iv', encryptedData: 'ciphertext' }
    })
    await vi.waitFor(() => expect(mocks.decrypt).toHaveBeenCalledOnce())

    popup.closed = true
    vi.advanceTimersByTime(500)
    resolveDecryption(JSON.stringify({ api_keys: [{ value: 'callback-key' }] }))

    await vi.waitFor(() => expect(setKey).toHaveBeenCalledWith('callback-key'))
  })

  it('preserves successful Aihubmix decryption and AiOnly key handling', async () => {
    const setAihubmixKey = vi.fn()
    await oauthWithAihubmix(setAihubmixKey)
    const aihubmixPopup = openedPopups[0]

    dispatchPopupMessage(aihubmixPopup, 'https://console.inferera.com', {
      key: 'cherry_studio_oauth_callback',
      data: { iv: 'iv', encryptedData: 'ciphertext' }
    })
    await vi.waitFor(() => expect(setAihubmixKey).toHaveBeenCalledWith('aihubmix-key'))

    expect(mocks.decrypt).toHaveBeenCalledWith('ciphertext', 'iv', '')

    const setAiOnlyKey = vi.fn()
    await oauthWithAiOnly(setAiOnlyKey)
    const aiOnlyPopup = openedPopups[1]
    dispatchPopupMessage(aiOnlyPopup, 'https://maas.aiionly.com', [{ secretKey: 'aionly-key' }])
    await vi.waitFor(() => expect(setAiOnlyKey).toHaveBeenCalledWith('aionly-key'))

    expect(aiOnlyPopup.close).toHaveBeenCalledOnce()
  })
})

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
    ['bills', providerBills, 'https://tokendance.space/activity/requests'],
    ['charge', providerCharge, 'https://cloud.siliconflow.cn/expensebill'],
    ['bills', providerBills, 'https://cloud.siliconflow.cn/bills']
  ] as const)(
    'opens provider %s externally instead of losing the existing browser session',
    async (_name, open, url) => {
      await open(url.includes('siliconflow') ? 'silicon' : 'tokendance')
      expect(ipcApi.request).toHaveBeenCalledWith('system.shell.open_external_website', url)
    }
  )
})
