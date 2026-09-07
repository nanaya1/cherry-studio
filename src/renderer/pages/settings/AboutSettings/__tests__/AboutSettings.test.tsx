import '@testing-library/jest-dom/vitest'

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  popupInfo: vi.fn(),
  request: vi.fn()
}))

vi.mock('@renderer/ipc', () => ({
  ipcApi: { request: mocks.request }
}))

vi.mock('@renderer/services/popup', () => ({
  popup: { info: mocks.popupInfo }
}))

vi.mock('@renderer/hooks/useAppUpdateState', () => ({
  useAppUpdateState: () => ({
    appUpdateState: {
      available: false,
      checking: false,
      downloaded: false,
      downloading: false,
      downloadProgress: 0,
      info: null
    },
    updateAppUpdateState: vi.fn()
  })
}))

vi.mock('@renderer/hooks/useMiniAppPopup', () => ({
  useMiniAppPopup: () => ({ openSmartMiniApp: vi.fn() })
}))

vi.mock('@renderer/hooks/useOpenReleaseNotes', () => ({
  useOpenReleaseNotes: () => vi.fn()
}))

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'light' })
}))

vi.mock('@renderer/components/UpdateDialogPopup', () => ({
  default: { show: vi.fn() }
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('../DiagnosticBundleDialog', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div>diagnostic-dialog-open</div> : null)
}))

vi.mock('../../FeedbackDialog', () => ({
  FeedbackDialog: () => null
}))

// Forwards alt so empty-alt decorative logos stay hidden even without the wrapper.
vi.mock('@renderer/components/icons/LogoAvatar', () => ({
  default: ({ logo, alt }: { logo: string; alt?: string }) => <img src={logo} alt={alt} />
}))

import { AboutSettings } from '..'

const HIDDEN_TITLES = [
  'docs.title',
  'settings.about.website.title',
  'settings.about.feedback.title',
  'settings.about.enterprise.title',
  'settings.about.contact.title',
  'settings.about.careers.title',
  'settings.about.releases.title',
  'settings.general.auto_check_update.title',
  'settings.general.test_plan.title'
] as const

const REPOSITORY_BUTTON_LABEL = 'settings.about.repository'

async function renderAboutSettings() {
  render(<AboutSettings />)
  await waitFor(() => expect(mocks.request).toHaveBeenCalledWith('app.get_info'))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.request.mockImplementation(async (route: string) => {
    if (route === 'app.get_info') return { isPortable: false, version: '2.0.0' }
    return undefined
  })
})

describe('AboutSettings update check', () => {
  it('shows the coming soon dialog without requesting an update', async () => {
    const user = userEvent.setup()
    await renderAboutSettings()

    await user.click(screen.getByRole('button', { name: 'settings.about.checkUpdate.label' }))

    expect(mocks.popupInfo).toHaveBeenCalledWith({ title: '敬请期待', icon: null })
    expect(mocks.request).not.toHaveBeenCalledWith('app.updater.check_for_update')
  })
})

describe('AboutSettings diagnostics and debug entries', () => {
  it('keeps diagnostics and debug with debug listed after diagnostics', async () => {
    const user = userEvent.setup()
    await renderAboutSettings()

    const diagnostics = screen.getByRole('button', { name: 'settings.about.diagnostics.entry.button' })
    const debug = screen.getByRole('button', { name: 'settings.about.debug.open' })
    const buttons = screen.getAllByRole('button')
    expect(buttons.indexOf(debug)).toBe(buttons.indexOf(diagnostics) + 1)

    await user.click(diagnostics)
    expect(screen.getByText('diagnostic-dialog-open')).toBeInTheDocument()
  })
})

describe('AboutSettings hidden entries', () => {
  it('hides the GitHub repo controls and all other entry rows that were removed from the page', async () => {
    await renderAboutSettings()

    expect(screen.queryByRole('button', { name: REPOSITORY_BUTTON_LABEL })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'settings.about.releases.title' })).not.toBeInTheDocument()
    // The version badge should be a non-interactive badge now, not a button.
    expect(screen.queryByRole('button', { name: /v2\.0\.0/ })).not.toBeInTheDocument()

    for (const title of HIDDEN_TITLES) {
      expect(screen.queryByText(title)).not.toBeInTheDocument()
    }
  })
})
