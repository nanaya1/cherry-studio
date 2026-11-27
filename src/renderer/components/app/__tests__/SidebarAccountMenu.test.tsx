import { fireEvent, render, screen } from '@testing-library/react'
import { SWRConfig } from 'swr'
import { describe, expect, it, vi } from 'vitest'

import { SidebarAccountMenu } from '../SidebarAccountMenu'

const mocks = vi.hoisted(() => ({ request: vi.fn(), show: vi.fn() }))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request: mocks.request } }))
vi.mock('../../UserPopup', () => ({ default: { show: mocks.show } }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

describe('SidebarAccountMenu', () => {
  it.each([false, true])('shows only the relevant profile action (signedIn=%s)', async (signedIn) => {
    mocks.request.mockResolvedValue({ signedIn })
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <SidebarAccountMenu profile />
      </SWRConfig>
    )
    const login = 'settings.provider.org_service.login'
    const logout = 'settings.provider.org_service.logout'
    expect(await screen.findByRole('button', { name: signedIn ? logout : login })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: signedIn ? login : logout })).not.toBeInTheDocument()
  })
  it('opens the independent login popup from the guest account menu', async () => {
    mocks.request.mockResolvedValue({ signedIn: false })
    const close = vi.fn()
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <SidebarAccountMenu close={close} />
      </SWRConfig>
    )
    const label = 'login'
    const action = await screen.findByRole('button', { name: `settings.provider.org_service.${label}` })
    expect(screen.queryByRole('button', { name: 'settings.provider.org_service.logout' })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'settings.provider.org_service.edit_local_profile' })
    ).not.toBeInTheDocument()
    fireEvent.click(action)
    expect(close).toHaveBeenCalledOnce()
    expect(mocks.show).toHaveBeenLastCalledWith({ loginOnly: true })
  })

  it('requests the logout confirmation after closing the menu', async () => {
    mocks.request.mockResolvedValueOnce({ signedIn: true }).mockResolvedValueOnce('cancelled')
    const close = vi.fn()
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <SidebarAccountMenu close={close} />
      </SWRConfig>
    )
    const logout = await screen.findByRole('button', { name: 'settings.provider.org_service.logout' })
    expect(screen.queryByRole('button', { name: 'settings.provider.org_service.login' })).not.toBeInTheDocument()
    fireEvent.click(logout)
    expect(close).toHaveBeenCalledOnce()
    expect(mocks.request).toHaveBeenLastCalledWith(
      'enterprise.personal.change_account',
      expect.objectContaining({
        credentials: null,
        confirmation: expect.objectContaining({ proceed: 'settings.provider.org_service.logout' })
      })
    )
  })
})
