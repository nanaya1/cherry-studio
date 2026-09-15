import { oauthWithCherryIn, provisionOAuthApiKeys } from '@renderer/services/oauth'
import { popup } from '@renderer/services/popup'
import { toast } from '@renderer/services/toast'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import CherryInOauth from '../ProviderSpecific/CherryInOauth'

const useProviderMock = vi.fn()
const ipcApiRequestMock = vi.fn()

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
  beforeEach(() => {
    vi.clearAllMocks()
    ipcApiRequestMock.mockImplementation((route: string) => {
      if (route === 'cherryin.get_balance') return Promise.resolve(DEFAULT_BALANCE)
      if (route === 'oauth.has_token') return Promise.resolve(true)
      return Promise.resolve(undefined)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
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
      expect(ipcApiRequestMock).toHaveBeenCalledWith('cherryin.get_balance', {
        apiHost: 'https://open.cherryin.ai',
        providerId: 'cherryin'
      })
    })

    expect(screen.getByText('Siin')).toBeInTheDocument()
    expect(screen.getByText('siin@gmail.com')).toBeInTheDocument()
    expect(screen.getByText('Pro')).toBeInTheDocument()
    expect(screen.getByText('$128.50')).toBeInTheDocument()
    expect(screen.getByText(/open\.cherryin\.ai/)).toBeInTheDocument()
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
      expect(ipcApiRequestMock).toHaveBeenCalledWith('cherryin.get_balance', {
        apiHost: 'https://open.cherryin.ai',
        providerId: 'cherryin'
      })
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

    expect(ipcApiRequestMock).toHaveBeenCalledWith('cherryin.logout', {
      apiHost: 'https://open.cherryin.ai',
      providerId: 'cherryin'
    })
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
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)

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
    expect(openSpy).toHaveBeenCalledWith('https://open.cherryin.ai/console/topup', '_blank')

    fireEvent.focus(window)
    await screen.findByText('$256.00')
    expect(ipcApiRequestMock).toHaveBeenCalledTimes(1)
    expect(ipcApiRequestMock).toHaveBeenCalledWith('cherryin.get_balance', {
      apiHost: 'https://open.cherryin.ai',
      providerId: 'cherryin'
    })

    ipcApiRequestMock.mockClear()
    fireEvent.focus(window)
    expect(ipcApiRequestMock).not.toHaveBeenCalled()
  })

  it('renders the xuelang gateway card with its own host and branding', async () => {
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
      expect(ipcApiRequestMock).toHaveBeenCalledWith('cherryin.get_balance', {
        apiHost: 'https://api.xuelanglm.com',
        providerId: 'xuelang'
      })
    })
    expect(ipcApiRequestMock).toHaveBeenCalledWith('oauth.has_token', { providerId: 'xuelang' })
    expect(screen.getByTestId('xuelang-avatar')).toBeInTheDocument()
    expect(screen.getByText(/雪浪工匠|Xuelang/)).toBeInTheDocument()
  })
})

describe('CherryInOauth — fail closed for unknown/copied providers', () => {
  it('renders nothing and makes no gateway calls for an unknown provider', () => {
    useProviderMock.mockReturnValue({
      provider: { id: 'unknown-gw', name: 'Unknown', isEnabled: true }
    })

    const { container } = render(<CherryInOauth providerId="unknown-gw" />)

    // Unknown providers must not fall back to CherryIN — no login flow, no
    // balance fetch, no token check.
    expect(container).toBeEmptyDOMElement()
    expect(ipcApiRequestMock).not.toHaveBeenCalled()
    expect(oauthWithCherryIn).not.toHaveBeenCalled()
  })

  it('renders nothing and makes no gateway calls for a copied xuelang provider', () => {
    useProviderMock.mockReturnValue({
      provider: { id: 'copied-xuelang', name: '雪浪工匠 (副本)', presetProviderId: 'xuelang', isEnabled: true }
    })

    const { container } = render(<CherryInOauth providerId="copied-xuelang" />)

    expect(container).toBeEmptyDOMElement()
    expect(ipcApiRequestMock).not.toHaveBeenCalled()
    expect(oauthWithCherryIn).not.toHaveBeenCalled()
  })
})

describe('CherryInOauth — login status only via an enabled OAuth-labelled key', () => {
  it('does not show the logged-in card when only a manual key exists alongside a token', async () => {
    useProviderMock.mockReturnValue({
      provider: {
        id: 'xuelang',
        name: '雪浪工匠',
        apiKeys: [{ id: 'manual-1', label: 'Manual', isEnabled: true }],
        isEnabled: true
      },
      updateProvider: vi.fn(),
      addApiKey: vi.fn(),
      deleteApiKey: vi.fn()
    })
    ipcApiRequestMock.mockImplementation((route: string) =>
      route === 'oauth.has_token' ? Promise.resolve(true) : Promise.resolve(undefined)
    )

    render(<CherryInOauth providerId="xuelang" />)

    // A residual token with only a manual key must NOT read as logged in:
    // no balance fetch, no logged-in balance text.
    await screen.findByRole('button', { name: /重新领取凭据|Recover credentials/i })
    expect(screen.queryByText('$128.50')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /重新领取凭据|Recover credentials/i })).toBeInTheDocument()
  })

  it('recovers managed credentials without reopening OAuth when a token exists but no OAuth key does', async () => {
    const addApiKey = vi.fn().mockResolvedValue(undefined)
    const updateProvider = vi.fn().mockResolvedValue(undefined)
    vi.mocked(provisionOAuthApiKeys).mockResolvedValue('managed-1, managed-2')
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
    ipcApiRequestMock.mockImplementation((route: string) => {
      if (route === 'oauth.has_token') return Promise.resolve(true)
      if (route === 'cherryin.get_balance') return Promise.resolve(DEFAULT_BALANCE)
      return Promise.resolve(undefined)
    })

    render(<CherryInOauth providerId="xuelang" />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /重新领取凭据|Recover credentials/i }))

    await waitFor(() => {
      expect(provisionOAuthApiKeys).toHaveBeenCalledWith('xuelang')
    })
    expect(addApiKey).toHaveBeenNthCalledWith(1, 'managed-1', 'OAuth')
    expect(addApiKey).toHaveBeenNthCalledWith(2, 'managed-2', 'OAuth')
    expect(updateProvider).toHaveBeenCalledWith({ isEnabled: true })
    expect(oauthWithCherryIn).not.toHaveBeenCalled()
  })

  it('shows an expired-session state when an OAuth key remains without a token', async () => {
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
    ipcApiRequestMock.mockImplementation((route: string) =>
      route === 'oauth.has_token' ? Promise.resolve(false) : Promise.resolve(undefined)
    )

    render(<CherryInOauth providerId="xuelang" />)

    expect(await screen.findByText(/会话已失效|Session expired/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /雪浪工匠授权登录|Authorize with Xuelang/i })).toBeInTheDocument()
  })

  it('does not show the logged-in card when the OAuth key is disabled', async () => {
    useProviderMock.mockReturnValue({
      provider: {
        id: 'xuelang',
        name: '雪浪工匠',
        apiKeys: [{ id: 'oauth-1', label: 'OAuth', isEnabled: false }],
        isEnabled: true
      },
      updateProvider: vi.fn(),
      addApiKey: vi.fn(),
      deleteApiKey: vi.fn()
    })
    ipcApiRequestMock.mockImplementation((route: string) =>
      route === 'oauth.has_token' ? Promise.resolve(true) : Promise.resolve(undefined)
    )

    render(<CherryInOauth providerId="xuelang" />)

    await screen.findByRole('button', { name: /重新领取凭据|Recover credentials/i })
    expect(screen.queryByText('$128.50')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /重新领取凭据|Recover credentials/i })).toBeInTheDocument()
  })
})
