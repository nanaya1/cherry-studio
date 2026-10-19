import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  request: vi.fn(),
  showInfo: vi.fn(),
  search: {} as Record<string, unknown>,
  showDoctor: vi.fn()
}))

vi.mock('@renderer/components/doctor', () => ({
  DoctorPopup: { show: (...args: unknown[]) => mocks.showDoctor(...args) }
}))

vi.mock('@renderer/ipc', () => ({
  ipcApi: { request: mocks.request }
}))

vi.mock('@renderer/services/popup', () => ({
  popup: { info: (...args: unknown[]) => mocks.showInfo(...args) }
}))

vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ pathname: '/settings/about' }),
  useNavigate: () => mocks.navigate,
  useSearch: () => mocks.search
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
  useTranslation: () => ({
    t: (key: string) => (key === 'settings.doctor.entry.title' ? 'System diagnostics' : key)
  })
}))

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

// Forwards alt so empty-alt decorative logos stay hidden even without the wrapper.
vi.mock('@renderer/components/icons/LogoAvatar', () => ({
  default: ({ logo, alt }: { logo: string; alt?: string }) => <img src={logo} alt={alt} />
}))

import { AboutSettings } from '..'

async function renderAboutSettings() {
  render(<AboutSettings />)
  await waitFor(() => expect(mocks.request).toHaveBeenCalledWith('app.get_info'))
}

describe('AboutSettings diagnostics entry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.search = {}
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'app.get_info') return { isPortable: false, version: '2.0.0' }
      return undefined
    })
  })

  it('does not index the removed system diagnostics row', async () => {
    const { entries } = await import('../about.search')

    const diagnosticsEntry = entries.find((entry) => entry.anchorId === 'diagnostics')
    expect(diagnosticsEntry).toBeUndefined()
    expect(entries).toContainEqual({
      anchorId: 'debug-tools',
      titleKey: 'settings.about.debug.title',
      groupKey: 'settings.about.label'
    })
  })

  it('keeps system diagnostics out of About and opens the existing debug panel action', async () => {
    const user = userEvent.setup()
    await renderAboutSettings()

    expect(screen.queryByText('System diagnostics')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'settings.about.debug.open' }))
    expect(mocks.request).toHaveBeenCalledWith('system.toggle_dev_tools')
  })

  it('opens an externally requested Doctor panel and consumes only that query', async () => {
    mocks.search = { doctor: 'report', focusId: 'support' }

    await renderAboutSettings()

    await waitFor(() => expect(mocks.showDoctor).toHaveBeenCalledWith({ initialPanel: 'report' }))
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/settings/about',
      search: expect.any(Function),
      replace: true
    })

    const updateSearch = mocks.navigate.mock.calls[0][0].search as (
      previous: Record<string, unknown>
    ) => Record<string, unknown>
    expect(updateSearch({ doctor: 'report', focusId: 'support' })).toEqual({ focusId: 'support' })
  })

  it('keeps the manual update placeholder without exposing Cherry update controls or links', async () => {
    const user = userEvent.setup()
    await renderAboutSettings()

    expect(screen.getByText('MEA Cowork 企业版')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'settings.about.feedback.button' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'settings.about.feedback.dialog.title' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'settings.about.releases.button' })).not.toBeInTheDocument()
    expect(screen.queryByText('settings.general.auto_check_update.title')).not.toBeInTheDocument()
    expect(screen.queryByText('settings.general.test_plan.title')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'settings.about.checkUpdate.label' }))

    expect(mocks.showInfo).toHaveBeenCalledWith({ title: '敬请期待', icon: null })
    expect(mocks.request).not.toHaveBeenCalledWith('app.updater.check_for_update')
    expect(mocks.showDoctor).not.toHaveBeenCalled()
  })
})

describe('AboutSettings repository controls accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.search = {}
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'app.get_info') return { isPortable: false, version: '2.0.0' }
      return undefined
    })
  })

  it('keeps Cherry repository controls hidden and marks the app logo as decorative', async () => {
    await renderAboutSettings()

    expect(screen.queryByRole('button', { name: 'settings.about.repository' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cherry Studio' })).not.toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
})
