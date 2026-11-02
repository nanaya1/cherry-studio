import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '@renderer/i18n/resolver'
import { oauthWithCherryIn, provisionOAuthApiKeys } from '@renderer/services/oauth'
import { popup } from '@renderer/services/popup'
import { toast } from '@renderer/services/toast'
import { IpcError } from '@shared/ipc/errors/IpcError'
import { oauthErrorCodes } from '@shared/ipc/errors/oauth'

import CherryInOauth from '../ProviderSpecific/CherryInOauth'

const useProviderMock = vi.fn()
const ipcApiRequestMock = vi.fn()
const oauthWithCherryInMock = vi.mocked(oauthWithCherryIn)
const provisionOAuthApiKeysMock = vi.mocked(provisionOAuthApiKeys)

vi.mock('@renderer/hooks/useProvider', () => ({
  useProvider: (...args: any[]) => useProviderMock(...args)
}))

vi.mock('@renderer/ipc', () => ({
  ipcApi: {
    request: (...args: any[]) => ipcApiRequestMock(...args)
  }
}))

const DEFAULT_BALANCE = {
  balance: 128.5,
  profile: {
    displayName: 'Siin',
    username: 'siin',
    email: 'siin@gmail.com',
    group: 'Pro'
  }
}

const TOPPED_UP_BALANCE = { ...DEFAULT_BALANCE, balance: 256 }

vi.mock('@renderer/services/oauth', () => ({
  oauthWithCherryIn: vi.fn(),
  provisionOAuthApiKeys: vi.fn()
}))

vi.mock('@cherrystudio/ui', async (importOriginal) => {
  const actual = await importOriginal<object>()

  return {
    ...actual,
    Skeleton: ({ className }: { className?: string }) => <div className={className} data-testid="skeleton" />
  }
})

vi.mock('@cherrystudio/ui/icons/providers', () => ({
  Cherryin: {
    Avatar: ({ size }: { size?: number }) => <div data-testid="cherryin-avatar">{size ?? 0}</div>
  },
  Xuelang: {
    Avatar: ({ size }: { size?: number }) => <div data-testid="xuelang-avatar">{size ?? 0}</div>
  }
}))

describe('CherryInOauth', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN')
    vi.clearAllMocks()
    oauthWithCherryInMock.mockReset()
    provisionOAuthApiKeysMock.mockReset()
    ipcApiRequestMock.mockImplementation((route: string) => {
      if (route === 'cherryin.get_balance') return Promise.resolve(DEFAULT_BALANCE)
      if (route === 'oauth.has_token') return Promise.resolve(true)
      return Promise.resolve(undefined)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('offers Xuelang cancellation and a reminder after 60 seconds without accepting late keys', async () => {
    const addApiKey = vi.fn()
    useProviderMock.mockReturnValue({
      provider: { id: 'xuelang', name: '雪浪工匠', apiKeys: [], isEnabled: false },
      updateProvider: vi.fn(),
      addApiKey,
      deleteApiKey: vi.fn()
    })
    ipcApiRequestMock.mockImplementation((route: string) =>
      Promise.resolve(route === 'oauth.has_token' ? false : undefined)
    )
    oauthWithCherryInMock.mockImplementation(() => new Promise(() => {}))
    const user = userEvent.setup()
    render(<CherryInOauth providerId="xuelang" />)
    await waitFor(() => expect(ipcApiRequestMock).toHaveBeenCalledWith('oauth.has_token', { providerId: 'xuelang' }))
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: /授权|Authorize/i }))
    expect(screen.getByRole('button', { name: /取消|Cancel/i })).toBeEnabled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(screen.getByText(/尚未收到授权结果|No authorization result/i)).toBeInTheDocument()
    vi.useRealTimers()
    await user.click(screen.getByRole('button', { name: /取消|Cancel/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /授权|Authorize/i })).toBeEnabled())
    await act(async () => {
      await oauthWithCherryInMock.mock.calls[0][0]('late-key')
    })
    expect(addApiKey).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('stops subsequent Xuelang writes when cancelled during an API-key save', async () => {
    let release!: () => void
    const addApiKey = vi.fn().mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const updateProvider = vi.fn()
    useProviderMock.mockReturnValue({
      provider: { id: 'xuelang', name: '雪浪工匠', apiKeys: [], isEnabled: false },
      addApiKey,
      updateProvider,
      deleteApiKey: vi.fn()
    })
    ipcApiRequestMock.mockImplementation((route: string) =>
      Promise.resolve(route === 'oauth.has_token' ? false : undefined)
    )
    oauthWithCherryInMock.mockImplementation(async (save) => {
      await save('first,second')
      return 'first,second'
    })
    const user = userEvent.setup()
    render(<CherryInOauth providerId="xuelang" />)
    await waitFor(() => expect(ipcApiRequestMock).toHaveBeenCalledWith('oauth.has_token', { providerId: 'xuelang' }))
    await user.click(screen.getByRole('button', { name: /授权/ }))
    await waitFor(() => expect(addApiKey).toHaveBeenCalledWith('first', 'OAuth'))
    await user.click(screen.getByRole('button', { name: /取消/ }))
    await act(async () => {
      release()
    })
    expect(addApiKey).toHaveBeenCalledTimes(1)
    expect(updateProvider).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /授权/ })).toBeEnabled()
  })

  it('ignores an unmounted Xuelang save without cancelling the background attempt', async () => {
    const addApiKey = vi.fn()
    const updateProvider = vi.fn()
    useProviderMock.mockReturnValue({
      provider: { id: 'xuelang', name: '雪浪工匠', apiKeys: [], isEnabled: false },
      addApiKey,
      updateProvider,
      deleteApiKey: vi.fn()
    })
    ipcApiRequestMock.mockResolvedValue(false)
    oauthWithCherryInMock.mockImplementation(() => new Promise(() => {}))
    const view = render(<CherryInOauth providerId="xuelang" />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: /授权/ }))
    const [save, config] = oauthWithCherryInMock.mock.calls[0]
    view.unmount()
    await act(async () => {
      await save('late-key')
    })
    expect(config.signal?.aborted).toBe(false)
    expect(ipcApiRequestMock).not.toHaveBeenCalledWith('oauth.cancel_sign_in', expect.anything())
    expect(addApiKey).not.toHaveBeenCalled()
    expect(updateProvider).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('keeps a newer Xuelang attempt pending when an older save returns', async () => {
    let release!: () => void
    const addApiKey = vi.fn().mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const updateProvider = vi.fn()
    useProviderMock.mockReturnValue({
      provider: { id: 'xuelang', name: '雪浪工匠', apiKeys: [], isEnabled: false },
      addApiKey,
      updateProvider,
      deleteApiKey: vi.fn()
    })
    ipcApiRequestMock.mockResolvedValue(false)
    oauthWithCherryInMock.mockImplementationOnce(async (save) => {
      await save('old-first,old-second')
      return 'old'
    })
    oauthWithCherryInMock.mockImplementationOnce(() => new Promise(() => {}))
    render(<CherryInOauth providerId="xuelang" />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: /授权/ }))
    expect(addApiKey).toHaveBeenCalledWith('old-first', 'OAuth')
    fireEvent.click(screen.getByRole('button', { name: /取消/ }))
    fireEvent.click(screen.getByRole('button', { name: /授权/ }))
    expect(oauthWithCherryInMock).toHaveBeenCalledTimes(2)
    await act(async () => {
      release()
    })
    expect(addApiKey).toHaveBeenCalledTimes(1)
    expect(updateProvider).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /授权/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /取消/ })).toBeEnabled()
  })

  it('ignores a late Xuelang balance response after a newer login starts', async () => {
    let release!: (balance: typeof DEFAULT_BALANCE) => void
    useProviderMock.mockReturnValue({
      provider: { id: 'xuelang', name: '雪浪工匠', apiKeys: [], isEnabled: false },
      addApiKey: vi.fn().mockResolvedValue(undefined),
      updateProvider: vi.fn().mockResolvedValue(undefined),
      deleteApiKey: vi.fn()
    })
    ipcApiRequestMock.mockImplementation((route: string) => {
      if (route === 'cherryin.get_balance')
        return new Promise((resolve) => {
          release = resolve
        })
      return Promise.resolve(false)
    })
    oauthWithCherryInMock.mockImplementationOnce(async (save) => {
      await save('old-key')
      return 'old-key'
    })
    oauthWithCherryInMock.mockImplementationOnce(() => new Promise(() => {}))
    render(<CherryInOauth providerId="xuelang" />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: /授权/ }))
    await waitFor(() =>
      expect(ipcApiRequestMock).toHaveBeenCalledWith('cherryin.get_balance', {
        apiHost: 'https://api.xuelanglm.com',
        providerId: 'xuelang'
      })
    )
    fireEvent.click(screen.getByRole('button', { name: /取消/ }))
    fireEvent.click(screen.getByRole('button', { name: /授权/ }))
    await act(async () => {
      release(DEFAULT_BALANCE)
    })
    expect(toast.success).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /授权/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /取消/ })).toBeEnabled()
    expect(ipcApiRequestMock.mock.calls.filter(([route]) => route === 'oauth.has_token')).toHaveLength(1)
  })

  it('renders the logged-in card with balance and footer attribution', async () => {
    useProviderMock.mockReturnValue({
      provider: {
        id: 'cherryin',
        name: 'CherryIN',
        apiKeys: [{ id: 'oauth-1', label: 'OAuth', isEnabled: true }],
        isEnabled: true
      },
      updateProvider: vi.fn(),
      addApiKey: vi.fn(),
      deleteApiKey: vi.fn()
    })

    render(<CherryInOauth providerId="cherryin" />)

    await waitFor(() => {
      expect(ipcApiRequestMock).toHaveBeenCalledWith('cherryin.get_balance', { apiHost: 'https://open.cherryin.ai' })
    })

    expect(screen.getByText('Siin')).toBeInTheDocument()
    expect(screen.getByText('siin@gmail.com')).toBeInTheDocument()
    expect(screen.getByText('Pro')).toBeInTheDocument()
    expect(screen.getByText('$128.50')).toBeInTheDocument()
    expect(screen.getByText(/open\.cherryin\.ai/)).toBeInTheDocument()
  })

  it('renders Xuelang with independent token, host, branding, i18n and no top-up', async () => {
    useProviderMock.mockReturnValue({
      provider: {
        id: 'xuelang',
        name: '雪浪工匠',
        apiKeys: [{ id: 'oauth-1', label: 'OAuth', isEnabled: true }],
        isEnabled: true
      },
      updateProvider: vi.fn(),
      addApiKey: vi.fn(),
      deleteApiKey: vi.fn()
    })

    render(<CherryInOauth providerId="xuelang" />)

    await waitFor(() => {
      expect(ipcApiRequestMock).toHaveBeenCalledWith('oauth.has_token', { providerId: 'xuelang' })
      expect(ipcApiRequestMock).toHaveBeenCalledWith('cherryin.get_balance', {
        apiHost: 'https://api.xuelanglm.com',
        providerId: 'xuelang'
      })
    })
    expect(screen.getByTestId('xuelang-avatar')).toBeInTheDocument()
    expect(screen.getByText(/雪浪工匠|Xuelang/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /充值|Top Up/i })).not.toBeInTheDocument()
  })

  it('provisions missing Xuelang OAuth API keys from its existing token', async () => {
    const addApiKey = vi.fn().mockResolvedValue(undefined)
    const updateProvider = vi.fn().mockResolvedValue(undefined)
    provisionOAuthApiKeysMock.mockResolvedValue('managed-1,managed-2')
    useProviderMock.mockReturnValue({
      provider: {
        id: 'xuelang',
        name: '雪浪工匠',
        apiKeys: [{ id: 'manual-1', label: 'Manual', isEnabled: true }],
        isEnabled: true
      },
      updateProvider,
      addApiKey,
      deleteApiKey: vi.fn()
    })
    const user = userEvent.setup()

    render(<CherryInOauth providerId="xuelang" />)
    await user.click(await screen.findByRole('button', { name: /重新领取凭据|Recover credentials/i }))

    expect(provisionOAuthApiKeysMock).toHaveBeenCalledWith('xuelang')
    expect(addApiKey).toHaveBeenNthCalledWith(1, 'managed-1', 'OAuth')
    expect(addApiKey).toHaveBeenNthCalledWith(2, 'managed-2', 'OAuth')
    expect(updateProvider).toHaveBeenCalledWith({ isEnabled: true })
    expect(oauthWithCherryInMock).not.toHaveBeenCalled()
  })

  it('maps Xuelang provisioning error codes to dedicated i18n messages', async () => {
    provisionOAuthApiKeysMock.mockRejectedValue(
      Object.assign(new Error('subscription missing'), { code: 'NO_ACTIVE_SUBSCRIPTION' })
    )
    useProviderMock.mockReturnValue({
      provider: { id: 'xuelang', name: '雪浪工匠', apiKeys: [], isEnabled: true },
      updateProvider: vi.fn(),
      addApiKey: vi.fn(),
      deleteApiKey: vi.fn()
    })
    ipcApiRequestMock.mockImplementation((route: string) =>
      route === 'oauth.has_token' ? Promise.resolve(true) : Promise.resolve(undefined)
    )
    const user = userEvent.setup()

    render(<CherryInOauth providerId="xuelang" />)
    await user.click(await screen.findByRole('button', { name: /重新领取凭据|Recover credentials/i }))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(i18n.t('settings.provider.oauth.error_codes.NO_ACTIVE_SUBSCRIPTION'))
    )
  })

  it('keeps balance fetch failures quiet and shows the empty balance state', async () => {
    ipcApiRequestMock.mockImplementation((route: string) => {
      if (route === 'cherryin.get_balance') {
        return Promise.reject(new Error('Failed to get balance: HTTP 401 Unauthorized'))
      }
      if (route === 'oauth.has_token') return Promise.resolve(true)
      return Promise.resolve(undefined)
    })
    useProviderMock.mockReturnValue({
      provider: {
        id: 'cherryin',
        name: 'CherryIN',
        apiKeys: [{ id: 'oauth-1', label: 'OAuth', isEnabled: true }],
        isEnabled: true
      },
      updateProvider: vi.fn(),
      addApiKey: vi.fn(),
      deleteApiKey: vi.fn()
    })

    render(<CherryInOauth providerId="cherryin" />)

    await waitFor(() => {
      expect(ipcApiRequestMock).toHaveBeenCalledWith('cherryin.get_balance', { apiHost: 'https://open.cherryin.ai' })
    })
    expect(toast.error).not.toHaveBeenCalled()
    expect(screen.getByText('-')).toBeInTheDocument()
  })

  it('renders the logged-out card when there is no OAuth token', () => {
    useProviderMock.mockReturnValue({
      provider: {
        id: 'cherryin',
        name: 'CherryIN',
        apiKeys: [],
        isEnabled: true
      },
      updateProvider: vi.fn(),
      addApiKey: vi.fn(),
      deleteApiKey: vi.fn()
    })
    ipcApiRequestMock.mockImplementation((route: string) =>
      route === 'oauth.has_token' ? Promise.resolve(false) : Promise.resolve(undefined)
    )

    render(<CherryInOauth providerId="cherryin" />)

    const loginButton = screen.getByRole('button', { name: /CherryIN|授权/i })
    const tagline = screen.getByText(/登录后即可使用所有模型服务|all model services/i)

    expect(loginButton).toBeInTheDocument()
    expect(screen.getByTestId('cherryin-avatar')).toBeInTheDocument()
    expect(tagline.compareDocumentPosition(loginButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('cancels a preset-derived CherryIN login through its registered OAuth provider', async () => {
    let rejectSignIn: (error: unknown) => void = () => {}
    oauthWithCherryInMock.mockImplementationOnce(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectSignIn = reject
        })
    )
    useProviderMock.mockReturnValue({
      provider: { id: 'custom-cherryin', presetProviderId: 'cherryin', name: 'CherryIN', apiKeys: [], isEnabled: true },
      updateProvider: vi.fn(),
      addApiKey: vi.fn(),
      deleteApiKey: vi.fn()
    })
    ipcApiRequestMock.mockImplementation((route: string, input?: { providerId?: string }) => {
      if (route === 'oauth.has_token') return Promise.resolve(false)
      if (route === 'oauth.cancel_sign_in' && input?.providerId === 'cherryin') {
        rejectSignIn(new IpcError(oauthErrorCodes.SIGN_IN_CANCELLED))
        return Promise.resolve(undefined)
      }
      return Promise.resolve(undefined)
    })
    const user = userEvent.setup()

    render(<CherryInOauth providerId="custom-cherryin" />)

    const loginButton = screen.getByRole('button', { name: /CherryIN|授权/i })
    await user.click(loginButton)

    expect(loginButton).toBeDisabled()
    expect(loginButton.querySelector('.animate-spin')).toBeInTheDocument()
    const cancelButton = screen.getByRole('button', { name: /取消|Cancel/i })
    expect(cancelButton).toBeEnabled()
    expect(oauthWithCherryInMock).toHaveBeenCalledWith(expect.any(Function), {
      oauthServer: 'https://open.cherryin.ai',
      requestId: expect.any(String)
    })

    const requestId = oauthWithCherryInMock.mock.calls[0][1].requestId
    await user.click(cancelButton)

    await waitFor(() => expect(loginButton).toBeEnabled())
    expect(ipcApiRequestMock).toHaveBeenCalledWith('oauth.has_token', { providerId: 'cherryin' })
    expect(ipcApiRequestMock).toHaveBeenCalledWith('oauth.cancel_sign_in', {
      providerId: 'cherryin',
      requestId
    })
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('restores the login action and reports an OAuth failure', async () => {
    oauthWithCherryInMock.mockRejectedValueOnce(new Error('login failed'))
    useProviderMock.mockReturnValue({
      provider: { id: 'cherryin', name: 'CherryIN', apiKeys: [], isEnabled: true },
      updateProvider: vi.fn(),
      addApiKey: vi.fn(),
      deleteApiKey: vi.fn()
    })
    ipcApiRequestMock.mockImplementation((route: string) =>
      route === 'oauth.has_token' ? Promise.resolve(false) : Promise.resolve(undefined)
    )
    const user = userEvent.setup()

    render(<CherryInOauth providerId="cherryin" />)

    const loginButton = screen.getByRole('button', { name: /CherryIN|授权/i })
    await user.click(loginButton)

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(loginButton).toBeEnabled()
    expect(screen.queryByRole('button', { name: /取消|Cancel/i })).not.toBeInTheDocument()
  })

  it('超时后使用已有登录超时文案并恢复雪浪登录按钮', async () => {
    oauthWithCherryInMock.mockRejectedValueOnce(new Error('OAuth flow timed out'))
    useProviderMock.mockReturnValue({
      provider: { id: 'xuelang', name: '雪浪工匠', apiKeys: [], isEnabled: true },
      updateProvider: vi.fn(),
      addApiKey: vi.fn(),
      deleteApiKey: vi.fn()
    })
    ipcApiRequestMock.mockImplementation((route: string) =>
      route === 'oauth.has_token' ? Promise.resolve(false) : Promise.resolve(undefined)
    )
    const user = userEvent.setup()
    render(<CherryInOauth providerId="xuelang" />)
    const loginButton = screen.getByRole('button', { name: i18n.t('settings.provider.oauth.xuelang.login_button') })
    await user.click(loginButton)
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(i18n.t('settings.provider.org_service.login_timeout')))
    expect(loginButton).toBeEnabled()
    expect(screen.queryByRole('button', { name: i18n.t('common.cancel') })).not.toBeInTheDocument()
  })

  it('logs Xuelang out through its independent provider session', async () => {
    const deleteApiKey = vi.fn().mockResolvedValue(undefined)
    useProviderMock.mockReturnValue({
      provider: {
        id: 'xuelang',
        name: '雪浪工匠',
        apiKeys: [{ id: 'oauth-xuelang', label: 'OAuth', isEnabled: true }],
        isEnabled: true
      },
      updateProvider: vi.fn(),
      addApiKey: vi.fn(),
      deleteApiKey
    })

    render(<CherryInOauth providerId="xuelang" />)
    const logoutButton = await screen.findByRole('button', { name: /退出登录|Logout/i })
    await act(async () => {
      fireEvent.click(logoutButton)
    })

    await waitFor(() => expect(deleteApiKey).toHaveBeenCalledWith('oauth-xuelang'))
    expect(ipcApiRequestMock).toHaveBeenCalledWith('cherryin.logout', {
      apiHost: 'https://api.xuelanglm.com',
      providerId: 'xuelang'
    })
  })

  it('logs out and removes every OAuth-labelled key after confirmation', async () => {
    const deleteApiKey = vi.fn().mockResolvedValue(undefined)

    useProviderMock.mockReturnValue({
      provider: {
        id: 'cherryin',
        name: 'CherryIN',
        apiKeys: [
          { id: 'oauth-1', label: 'OAuth', isEnabled: true },
          { id: 'oauth-2', label: 'OAuth', isEnabled: true },
          { id: 'manual-1', label: 'Manual', isEnabled: true }
        ],
        isEnabled: true
      },
      updateProvider: vi.fn(),
      addApiKey: vi.fn(),
      deleteApiKey
    })

    render(<CherryInOauth providerId="cherryin" />)

    const logoutButton = await screen.findByRole('button', { name: /退出登录|Logout/i })
    // The global popup.confirm mock auto-invokes onOk (the "confirmed" path) and resolves true.
    await act(async () => {
      fireEvent.click(logoutButton)
    })

    expect(popup.confirm).toHaveBeenCalled()
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalled()
    })

    expect(ipcApiRequestMock).toHaveBeenCalledWith('cherryin.logout', { apiHost: 'https://open.cherryin.ai' })
    expect(ipcApiRequestMock).toHaveBeenCalledWith('oauth.has_token', { providerId: 'cherryin' })
    expect(deleteApiKey).toHaveBeenCalledTimes(2)
    expect(deleteApiKey).toHaveBeenNthCalledWith(1, 'oauth-1')
    expect(deleteApiKey).toHaveBeenNthCalledWith(2, 'oauth-2')
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('shows a warning instead of success when OAuth key cleanup partially fails', async () => {
    const deleteApiKey = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('delete failed'))

    useProviderMock.mockReturnValue({
      provider: {
        id: 'cherryin',
        name: 'CherryIN',
        apiKeys: [
          { id: 'oauth-1', label: 'OAuth', isEnabled: true },
          { id: 'oauth-2', label: 'OAuth', isEnabled: true }
        ],
        isEnabled: true
      },
      updateProvider: vi.fn(),
      addApiKey: vi.fn(),
      deleteApiKey
    })

    render(<CherryInOauth providerId="cherryin" />)

    const logoutButton = await screen.findByRole('button', { name: /退出登录|Logout/i })
    // The global popup.confirm mock auto-invokes onOk (the "confirmed" path) and resolves true.
    await act(async () => {
      fireEvent.click(logoutButton)
    })

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalled()
    })
    expect(deleteApiKey).toHaveBeenCalledTimes(2)
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('refreshes the balance once after returning from top-up', async () => {
    useProviderMock.mockReturnValue({
      provider: {
        id: 'cherryin',
        name: 'CherryIN',
        apiKeys: [{ id: 'oauth-1', label: 'OAuth', isEnabled: true }],
        isEnabled: true
      },
      updateProvider: vi.fn(),
      addApiKey: vi.fn(),
      deleteApiKey: vi.fn()
    })

    render(<CherryInOauth providerId="cherryin" />)
    await screen.findByText('$128.50')

    ipcApiRequestMock.mockClear()
    ipcApiRequestMock.mockImplementation((route: string) => {
      if (route === 'cherryin.get_balance') return Promise.resolve(TOPPED_UP_BALANCE)
      if (route === 'oauth.has_token') return Promise.resolve(true)
      return Promise.resolve(undefined)
    })

    fireEvent.focus(window)
    expect(ipcApiRequestMock).not.toHaveBeenCalled()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /充值|Top Up/i }))
    expect(ipcApiRequestMock).toHaveBeenCalledWith(
      'system.shell.open_external_website',
      'https://open.cherryin.ai/console/topup'
    )
    ipcApiRequestMock.mockClear()

    fireEvent.focus(window)
    await screen.findByText('$256.00')
    expect(ipcApiRequestMock).toHaveBeenCalledTimes(1)
    expect(ipcApiRequestMock).toHaveBeenCalledWith('cherryin.get_balance', {
      apiHost: 'https://open.cherryin.ai'
    })

    ipcApiRequestMock.mockClear()
    fireEvent.focus(window)
    expect(ipcApiRequestMock).not.toHaveBeenCalled()
  })
})
