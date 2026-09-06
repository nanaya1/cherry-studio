import '@testing-library/jest-dom/vitest'

import { LATEST_PRIVACY_POLICY_VERSION } from '@shared/utils/constants'
import { mockUseMultiplePreferences, MockUsePreferenceUtils } from '@test-mocks/renderer/usePreference'
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const onboardingModule = vi.hoisted(() => ({ evaluations: 0 }))

vi.mock('../onboarding/OnboardingPage', () => {
  onboardingModule.evaluations += 1
  return { default: () => <div data-testid="onboarding-page">onboarding</div> }
})

vi.mock('../privacy/PrivacyPolicyUpdateGate', () => ({
  PrivacyPolicyUpdateGate: () => <div data-testid="privacy-policy-gate">privacy-policy-gate</div>
}))

const tabsProviderMock = vi.hoisted(() => ({ lastInitialDefaultTab: null as unknown }))

vi.mock('@renderer/components/layout/TabsProvider', () => ({
  TabsProvider: ({ children, initialDefaultTab }: { children: ReactNode; initialDefaultTab?: unknown }) => {
    tabsProviderMock.lastInitialDefaultTab = initialDefaultTab
    return <div data-testid="tabs-provider">{children}</div>
  }
}))

vi.mock('@renderer/components/layout/AppShell', () => ({
  AppShell: () => <div data-testid="app-shell">app-shell</div>
}))

vi.mock('@renderer/hooks/useWindowRuntime', () => ({ useWindowRuntime: () => {} }))
vi.mock('@renderer/hooks/tab', () => ({ useMainWindowNavigation: () => {} }))
vi.mock('@renderer/hooks/useStorageMonitorNotification', () => ({ useStorageMonitorNotification: () => {} }))
vi.mock('@renderer/components/ConversationNotificationRuntime', () => ({
  ConversationNotificationRuntime: () => null
}))
vi.mock('../hooks/useAutoBackupEvents', () => ({ useAutoBackupEvents: () => {} }))
vi.mock('../hooks/useTopicNamingErrorNotification', () => ({ useTopicNamingErrorNotification: () => {} }))
vi.mock('../hooks/useAppUpdateHandler', () => ({ useAppUpdateHandler: () => {} }))
vi.mock('@renderer/components/PopupHost', () => ({ PopupHost: () => null }))
vi.mock('@renderer/components/ToastHost', () => ({ default: () => null }))
vi.mock('@renderer/components/ThemeProvider', () => ({
  ThemeProvider: () => {
    throw new Error('theme provider boom')
  }
}))

import MainApp, { MainWindowContent } from '../MainApp'

function appendBootSpinner() {
  const spinner = document.createElement('div')
  spinner.id = 'spinner'
  document.body.appendChild(spinner)
}

describe('MainWindowContent', () => {
  beforeEach(() => {
    MockUsePreferenceUtils.resetMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('does not load onboarding after first-run setup is completed or skipped', () => {
    for (const status of ['completed', 'skipped'] as const) {
      MockUsePreferenceUtils.setPreferenceValue('app.onboarding.provider_setup.status', status)

      const view = render(<MainWindowContent />)

      expect(screen.getByTestId('tabs-provider')).toBeInTheDocument()
      expect(screen.getByTestId('app-shell')).toBeInTheDocument()
      expect(screen.queryByTestId('onboarding-page')).not.toBeInTheDocument()
      expect(screen.getByTestId('privacy-policy-gate')).toBeInTheDocument()
      expect(onboardingModule.evaluations).toBe(0)
      view.unmount()
    }
  })

  it('skips first-run provider setup without loading onboarding', async () => {
    const updateOnboardingPreferences = vi.fn().mockResolvedValue(undefined)
    mockUseMultiplePreferences.mockImplementationOnce(() => [
      { providerSetupStatus: 'pending', policyVersion: '' },
      updateOnboardingPreferences
    ])
    appendBootSpinner()

    render(<MainWindowContent />)

    await waitFor(() =>
      expect(updateOnboardingPreferences).toHaveBeenCalledWith({
        providerSetupStatus: 'skipped',
        policyVersion: LATEST_PRIVACY_POLICY_VERSION
      })
    )
    expect(screen.queryByTestId('onboarding-page')).not.toBeInTheDocument()
    expect(onboardingModule.evaluations).toBe(0)
    expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument()
    expect(screen.queryByTestId('privacy-policy-gate')).not.toBeInTheDocument()
    expect(document.getElementById('spinner')).toBeNull()
  })

  it('lands on the new-task page as the startup default tab regardless of sidebar favorites', () => {
    MockUsePreferenceUtils.setPreferenceValue('app.onboarding.provider_setup.status', 'completed')
    MockUsePreferenceUtils.setPreferenceValue('ui.sidebar.favorites', [
      { type: 'app', id: 'agents' },
      { type: 'app', id: 'translate' }
    ])
    MockUsePreferenceUtils.setPreferenceValue('feature.paintings.default_provider', 'zhipu')

    render(<MainWindowContent />)

    expect(tabsProviderMock.lastInitialDefaultTab).toMatchObject({ url: '/app/new-task' })
  })

  it('lands on the new-task page when no sidebar app is visible', () => {
    MockUsePreferenceUtils.setPreferenceValue('app.onboarding.provider_setup.status', 'completed')
    MockUsePreferenceUtils.setPreferenceValue('ui.sidebar.favorites', [])
    MockUsePreferenceUtils.setPreferenceValue('feature.paintings.default_provider', 'zhipu')

    render(<MainWindowContent />)

    expect(tabsProviderMock.lastInitialDefaultTab).toMatchObject({ url: '/app/new-task' })
  })
})

describe('MainApp top-level error boundary', () => {
  it('shows the window fatal fallback instead of a white screen when a provider throws', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    appendBootSpinner()

    render(<MainApp />)

    expect(screen.getByRole('alert')).toHaveTextContent('theme provider boom')
    expect(document.getElementById('spinner')).toBeNull()
    consoleError.mockRestore()
  })
})
