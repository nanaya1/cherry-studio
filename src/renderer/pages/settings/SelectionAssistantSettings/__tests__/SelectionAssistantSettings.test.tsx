import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import SelectionAssistantSettings from '../SelectionAssistantSettings'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  setSelectionEnabled: vi.fn(),
  preferences: {
    'feature.selection.enabled': true,
    'feature.selection.trigger_mode': 'selected',
    'feature.selection.compact': false,
    'feature.selection.auto_close': false,
    'feature.selection.auto_pin': false,
    'feature.selection.follow_toolbar': true,
    'feature.selection.remember_win_size': true,
    'feature.selection.action_window_opacity': 100,
    'feature.selection.filter_mode': 'default',
    'feature.selection.filter_list': [],
    'feature.selection.action_items': []
  } as Record<string, unknown>
}))

vi.mock('@data/hooks/usePreference', () => ({
  usePreference: (key: string) => [
    mocks.preferences[key],
    key === 'feature.selection.enabled' ? mocks.setSelectionEnabled : vi.fn()
  ]
}))

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'light' })
}))

vi.mock('@renderer/ipc', () => ({
  ipcApi: { request: (...args: unknown[]) => mocks.request(...args) }
}))

vi.mock('@renderer/utils/platform', () => ({
  isLinux: false,
  isMac: true,
  isWin: false
}))

vi.mock('@renderer/components/selection/SelectionToolbarView', () => ({
  default: () => null
}))

vi.mock('../components/SelectionActionsList', () => ({
  default: () => null
}))

vi.mock('../components/SelectionFilterListModal', () => ({
  default: () => null
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => children
}))

vi.mock('react-i18next', () => ({
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
  useTranslation: () => ({ t: (key: string) => key })
}))

describe('SelectionAssistantSettings', () => {
  beforeEach(() => {
    mocks.request.mockReset()
    mocks.setSelectionEnabled.mockReset()
  })

  it('shows the accessibility guide when an enabled macOS app loses permission', async () => {
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'system.mac.is_process_trusted') return false
      return undefined
    })

    render(<SelectionAssistantSettings />)

    expect(await screen.findByRole('dialog')).toBeVisible()
    expect(screen.getByText('selection.settings.enable.mac_process_trust_hint.title')).toBeVisible()
    await waitFor(() => expect(mocks.setSelectionEnabled).toHaveBeenCalledWith(false))
  })
})
