import { MockUsePreferenceUtils } from '@test-mocks/renderer/usePreference'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type ReactType from 'react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { POPUP_EXIT_MS, popupService } from '@renderer/services/popup'
import type * as ImageUtils from '@renderer/utils/image'

const mocks = vi.hoisted(() => ({
  appEdition: 'cn' as 'cn' | 'global',
  ipcRequest: vi.fn(
    async (route: string): Promise<unknown> =>
      route === 'cherry_cloud.status.get' ? { phase: 'signed-out', displayName: null } : undefined
  ),
  statusListener: null as ((status: { phase: string; displayName: string | null }) => void) | null
}))

type PopoverContextValue = {
  open: boolean
  onOpenChange?: (open: boolean) => void
}

vi.mock('@cherrystudio/ui', () => {
  const React = require('react') as typeof ReactType
  const PopoverContext = React.createContext<PopoverContextValue>({ open: false })

  return {
    Avatar: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
      <div data-testid="avatar" {...props}>
        {children}
      </div>
    ),
    AvatarImage: ({ src, ...props }: { src?: string; [key: string]: unknown }) => (
      <img data-testid="avatar-image" src={src} alt="" {...props} />
    ),
    AvatarFallback: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
      <span data-testid="avatar-fallback" {...props}>
        {children}
      </span>
    ),
    Button: ({ children, loading, ...props }: { children?: ReactNode; loading?: boolean; [key: string]: unknown }) => (
      <button type="button" aria-busy={loading || undefined} disabled={loading || undefined} {...props}>
        {children}
      </button>
    ),
    Center: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
      <div data-testid="center" {...props}>
        {children}
      </div>
    ),
    ColFlex: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
      <div data-testid="col-flex" {...props}>
        {children}
      </div>
    ),
    Dialog: ({ children, open }: { children?: ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }) =>
      open ? <div data-testid="dialog">{children}</div> : null,
    DialogContent: ({
      children,
      closeOnOverlayClick,
      ...props
    }: {
      children?: ReactNode
      closeOnOverlayClick?: boolean
      [key: string]: unknown
    }) => {
      void closeOnOverlayClick
      return (
        <div data-testid="dialog-content" {...props}>
          {children}
        </div>
      )
    },
    DialogHeader: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
      <div data-testid="dialog-header" {...props}>
        {children}
      </div>
    ),
    DialogTitle: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
      <h2 data-testid="dialog-title" {...props}>
        {children}
      </h2>
    ),
    EmojiAvatar: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
      <div data-testid="emoji-avatar" {...props}>
        {children}
      </div>
    ),
    Input: (props: { [key: string]: unknown }) => <input {...props} />,
    Popover: ({
      children,
      open = false,
      onOpenChange
    }: {
      children?: ReactNode
      open?: boolean
      onOpenChange?: (open: boolean) => void
    }) => <PopoverContext value={{ open, onOpenChange }}>{children}</PopoverContext>,
    PopoverContent: ({
      children,
      align,
      sideOffset,
      ...props
    }: {
      children?: ReactNode
      align?: string
      sideOffset?: number
      [key: string]: unknown
    }) => {
      const context = React.use(PopoverContext)
      void align
      void sideOffset

      return context.open ? (
        <div data-testid="popover-content" {...props}>
          {children}
        </div>
      ) : null
    },
    PopoverTrigger: ({ children }: { children: ReactNode; asChild?: boolean }) => {
      const context = React.use(PopoverContext)
      // The real trigger opens the popover on click; wire that here so tests can
      // reach the file-upload / emoji controls inside PopoverContent.
      return (
        <div data-testid="popover-trigger" onClick={() => context.onOpenChange?.(true)}>
          {children}
        </div>
      )
    },
    RowFlex: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
      <div data-testid="row-flex" {...props}>
        {children}
      </div>
    )
  }
})

// This suite renders the real popup through the store + host, so opt out of the global mock.
vi.mock('@renderer/services/popup', async (importOriginal) => await importOriginal())

vi.mock('@renderer/ipc', () => ({
  ipcApi: { request: mocks.ipcRequest },
  useIpcOn: (_event: string, listener: (status: { phase: string; displayName: string | null }) => void) => {
    mocks.statusListener = listener
  }
}))

vi.mock('@renderer/utils/appEdition', () => ({
  getAppEdition: () => mocks.appEdition
}))

vi.mock('@renderer/utils/naming', () => ({
  isEmoji: (value: string) => value === '🙂'
}))

// Canvas isn't available in jsdom; stub the renderer normalize step to fixed bytes.
vi.mock('@renderer/utils/image', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageUtils>()),
  prepareEntityImageBytes: vi.fn(async () => new Uint8Array([1, 2, 3]))
}))

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn()
  },
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

import { PopupHost } from '@renderer/components/PopupHost'

import UserPopup from '../UserPopup'

function showUserPopup() {
  render(<PopupHost />)

  // show() adds an entry to the popup store and synchronously notifies PopupHost;
  // wrap it so the resulting useSyncExternalStore re-render runs inside act().
  act(() => {
    void UserPopup.show()
  })
}

describe('UserPopup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    MockUsePreferenceUtils.resetMocks()
    mocks.appEdition = 'cn'
    mocks.statusListener = null
    mocks.ipcRequest.mockImplementation(async (route: string) => {
      if (route === 'cherry_cloud.status.get') return { phase: 'signed-out', displayName: null }
      if (route === 'enterprise.status.get') {
        return {
          phase: 'signed-out',
          authMode: 'official-direct',
          displayName: null,
          phone: null,
          role: null
        }
      }
      if (route === 'enterprise.status.orgUnavailable') return { unavailable: false }
      return undefined
    })
  })

  afterEach(() => {
    // Unmount the host before draining so settling leftover entries triggers no React
    // update on a still-mounted host, then flush the shared singleton store. Fake timers
    // fire the exit phase synchronously (no wall-clock wait).
    cleanup()
    vi.useFakeTimers()
    for (const entry of [...popupService.getSnapshot()]) {
      popupService.settle(entry.instanceId, {})
    }
    vi.advanceTimersByTime(POPUP_EXIT_MS)
    vi.useRealTimers()
  })

  it('keeps the local profile name and avatar editable when the org account is signed in', async () => {
    mocks.ipcRequest.mockImplementation(async (route: string) => {
      if (route === 'enterprise.status.get') {
        return {
          phase: 'signed-in',
          authMode: 'official-direct',
          displayName: '测试用户',
          phone: '13900000000',
          role: ''
        }
      }
      if (route === 'enterprise.status.orgUnavailable') return { unavailable: false }
      return undefined
    })
    MockUsePreferenceUtils.setPreferenceValue('app.user.name', '本地用户')
    MockUsePreferenceUtils.setPreferenceValue('app.user.avatar', 'file:///tmp/local.png')

    showUserPopup()

    // The org displayName must not replace the local profile name, and the input
    // stays editable (the org sign-in state must not lock the local profile).
    const input = await screen.findByDisplayValue('本地用户')
    expect(input).not.toBeDisabled()
    expect(input).not.toHaveValue('测试用户')
    expect(screen.queryByPlaceholderText('settings.general.user_name.placeholder')).toBeInTheDocument()
    // The first-char avatar derived from the org displayName must not render.
    expect(screen.queryByTestId('avatar-fallback')).not.toBeInTheDocument()
    // The local avatar preference is used instead.
    expect(screen.getByTestId('avatar-image')).toHaveAttribute('src', 'file:///tmp/local.png')
  })

  it('renders image avatars with object-cover cropping', async () => {
    const avatar = 'file:///tmp/wide-avatar.png'
    MockUsePreferenceUtils.setPreferenceValue('app.user.avatar', avatar)

    showUserPopup()

    const image = await screen.findByTestId('avatar-image')
    expect(image).toHaveClass('object-cover')
    expect(image).toHaveAttribute('src', avatar)
  })

  it('lets a space be typed inside the name and stores the name without surrounding whitespace', async () => {
    const user = userEvent.setup()
    MockUsePreferenceUtils.setPreferenceValue('app.user.name', '')
    showUserPopup()

    const input = await screen.findByPlaceholderText('settings.general.user_name.placeholder')
    await user.type(input, 'John Doe ')

    expect(input).toHaveValue('John Doe ')
    expect(MockUsePreferenceUtils.getPreferenceValue('app.user.name')).toBe('John Doe')
  })

  it('follows the stored name until the draft is typed', async () => {
    const user = userEvent.setup()
    MockUsePreferenceUtils.setPreferenceValue('app.user.name', 'Before')
    showUserPopup()
    const input = await screen.findByPlaceholderText('settings.general.user_name.placeholder')
    expect(input).toHaveValue('Before')

    // The mocked hook has no subscription, so re-render through an unrelated interaction.
    MockUsePreferenceUtils.setPreferenceValue('app.user.name', 'After')
    fireEvent.click(await screen.findByTestId('popover-trigger'))
    expect(input).toHaveValue('After')

    await user.type(input, ' X')

    expect(input).toHaveValue('After X')
    expect(MockUsePreferenceUtils.getPreferenceValue('app.user.name')).toBe('After X')
  })

  it('only customizes avatar picker popover width and padding', async () => {
    showUserPopup()

    fireEvent.click(await screen.findByTestId('popover-trigger'))

    const popoverContent = screen.getByTestId('popover-content')

    expect(popoverContent).toHaveClass('w-auto', 'p-2')
    expect(popoverContent).not.toHaveClass(
      'border',
      'border-border',
      'bg-popover',
      'text-popover-foreground',
      'shadow-lg'
    )
  })

  it('accepts and uploads a WebP avatar as raw bytes via profile.set_avatar', async () => {
    showUserPopup()

    // Open the avatar popover to reveal the upload control + hidden file input.
    const trigger = await screen.findByTestId('popover-trigger')
    fireEvent.click(trigger)

    // jsdom's File lacks arrayBuffer(); add it so the handler can read the bytes.
    const file = Object.assign(new File(['webp'], 'a.webp', { type: 'image/webp' }), {
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
    })
    const input = screen.getByTestId('dialog-content').querySelector('input[type="file"]') as HTMLInputElement
    expect(input.accept.split(/,\s*/)).toContain('image/webp')
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => {
      expect(mocks.ipcRequest).toHaveBeenCalledWith('profile.set_avatar', {
        kind: 'image',
        data: expect.any(Uint8Array)
      })
    })
  })

  it('rejects an oversize avatar at pick time without calling profile.set_avatar', async () => {
    showUserPopup()

    const trigger = await screen.findByTestId('popover-trigger')
    fireEvent.click(trigger)

    const file = Object.assign(new File(['png'], 'a.png', { type: 'image/png' }), {
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
    })
    Object.defineProperty(file, 'size', { value: 11 * 1024 * 1024 })
    const input = screen.getByTestId('dialog-content').querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => {
      expect(mocks.ipcRequest).not.toHaveBeenCalledWith(
        'profile.set_avatar',
        expect.objectContaining({ kind: 'image' })
      )
    })
  })

  it('starts enterprise browser authorization', async () => {
    const user = userEvent.setup()
    mocks.ipcRequest.mockImplementation(async (route: string) => {
      if (route === 'enterprise.status.get')
        return { phase: 'signed-out', authMode: 'official-direct', displayName: null, phone: null, role: null }
      if (route === 'enterprise.login.start')
        return { phase: 'authorizing', authMode: 'official-direct', displayName: null, phone: null, role: null }
      if (route === 'enterprise.status.orgUnavailable') return { unavailable: false }
      return undefined
    })
    showUserPopup()

    const loginButton = await screen.findByRole('button', { name: 'settings.provider.org_service.login' })
    await user.click(loginButton)

    expect(mocks.ipcRequest).toHaveBeenCalledWith('enterprise.login.start')
    // Returns to the login action once the start request resolves (status unchanged → signed-out).
    expect(await screen.findByRole('button', { name: 'settings.provider.org_service.login' })).toBeEnabled()
  })

  it('shows the enterprise login action regardless of edition', async () => {
    mocks.appEdition = 'global'
    mocks.ipcRequest.mockImplementation(async (route: string) => {
      if (route === 'enterprise.status.get')
        return { phase: 'signed-out', authMode: 'official-direct', displayName: null, phone: null, role: null }
      if (route === 'enterprise.status.orgUnavailable') return { unavailable: false }
      return undefined
    })
    showUserPopup()

    await waitFor(() => expect(mocks.ipcRequest).toHaveBeenCalledWith('enterprise.status.get'))

    expect(screen.getByRole('button', { name: 'settings.provider.org_service.login' })).toBeInTheDocument()
  })

  it('revokes the current enterprise session and returns to the login action', async () => {
    const user = userEvent.setup()
    let loggedOut = false
    mocks.ipcRequest.mockImplementation(async (route: string) => {
      if (route === 'enterprise.status.get') {
        return loggedOut
          ? { phase: 'signed-out', authMode: 'official-direct', displayName: null, phone: null, role: null }
          : { phase: 'signed-in', authMode: 'official-direct', displayName: 'Sora', phone: '13900000000', role: '' }
      }
      if (route === 'enterprise.session.logout') {
        loggedOut = true
        return { phase: 'signed-out', authMode: 'official-direct', displayName: null, phone: null, role: null }
      }
      if (route === 'enterprise.status.orgUnavailable') return { unavailable: false }
      return undefined
    })
    showUserPopup()

    const logoutButton = await screen.findByRole('button', { name: 'settings.provider.org_service.logout' })
    expect(screen.getByRole('status')).toHaveTextContent('13900000000')
    expect(logoutButton).toHaveAttribute('variant', 'outline')
    await user.click(logoutButton)

    expect(mocks.ipcRequest).toHaveBeenCalledWith('enterprise.session.logout')
    expect(await screen.findByRole('button', { name: 'settings.provider.org_service.login' })).toBeEnabled()
  })

  it('offers a retry when the enterprise account status cannot be loaded', async () => {
    let statusAttempts = 0
    mocks.ipcRequest.mockImplementation(async (route: string) => {
      if (route === 'enterprise.status.get') {
        statusAttempts += 1
        if (statusAttempts === 1) throw new Error('service unavailable')
        return { phase: 'signed-in', authMode: 'official-direct', displayName: 'Sora', phone: '13900000000', role: '' }
      }
      if (route === 'enterprise.status.orgUnavailable') return { unavailable: false }
      return undefined
    })
    showUserPopup()

    expect(await screen.findByRole('alert')).toHaveTextContent('error.http.503')
    await userEvent.click(screen.getByRole('button', { name: 'common.retry' }))

    expect(await screen.findByRole('status')).toHaveTextContent('13900000000')
    expect(statusAttempts).toBe(2)
  })
})
