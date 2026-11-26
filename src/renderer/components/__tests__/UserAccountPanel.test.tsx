import { MockUsePreferenceUtils } from '@test-mocks/renderer/usePreference'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '@renderer/i18n/resolver'

import { UserAccountPanel } from '../UserAccountPanel'

vi.unmock('@cherrystudio/ui')

beforeEach(async () => {
  vi.clearAllMocks()
  MockUsePreferenceUtils.resetMocks()
  await i18n.changeLanguage('zh-CN')
})

describe('UserAccountPanel', () => {
  it('opens profile settings from the saved local nickname without requesting a cloud account', async () => {
    MockUsePreferenceUtils.setPreferenceValue('app.user.name', 'MEA local profile')
    render(<UserAccountPanel />)
    const user = userEvent.setup()

    const profile = screen.getByRole('button', { name: '用户名' })
    expect(profile).toHaveTextContent('MEA local profile')
    await user.click(profile)

    const request = vi.mocked(window.api.ipcApi.request)
    expect(request).toHaveBeenCalledWith('navigation.open_route_in_main', { path: '/settings/profile' })
    expect(request.mock.calls.filter(([route]) => route.startsWith('cherry_cloud.'))).toEqual([])
  })

  it('closes the entire account menu after selecting an appearance mode', async () => {
    function AccountMenu() {
      const [open, setOpen] = useState(true)
      return open ? (
        <UserAccountPanel onRequestClose={() => setOpen(false)} />
      ) : (
        <button type="button">Open account menu</button>
      )
    }
    const user = userEvent.setup()
    render(<AccountMenu />)

    await user.hover(screen.getByRole('button', { name: '外观' }))
    await user.click(await screen.findByRole('button', { name: '浅色', pressed: false }))

    expect(screen.getByRole('button', { name: 'Open account menu' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '用户名' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '外观' })).not.toBeInTheDocument()
  })
})
