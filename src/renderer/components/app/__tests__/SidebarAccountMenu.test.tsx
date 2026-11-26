import { fireEvent, render, screen } from '@testing-library/react'
import { SWRConfig } from 'swr'
import { describe, expect, it, vi } from 'vitest'

import { SidebarAccountMenu } from '../SidebarAccountMenu'

const mocks = vi.hoisted(() => ({ request: vi.fn(), show: vi.fn() }))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request: mocks.request } }))
vi.mock('../../UserPopup', () => ({ default: { show: mocks.show } }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

describe('SidebarAccountMenu', () => {
  it.each([false, true])('opens the independent login popup from the account menu (signedIn=%s)', async (signedIn) => {
    mocks.request.mockResolvedValue({ signedIn })
    const close = vi.fn()
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <SidebarAccountMenu name="Test user" close={close} />
      </SWRConfig>
    )
    const label = signedIn ? 'switch_account' : 'login'
    const action = await screen.findByRole('button', { name: `settings.provider.org_service.${label}` })
    const editProfile = screen.queryByRole('button', { name: 'settings.provider.org_service.edit_local_profile' })
    if (signedIn) expect(editProfile).not.toBeInTheDocument()
    else expect(editProfile).toBeInTheDocument()
    fireEvent.click(action)
    expect(close).toHaveBeenCalledOnce()
    expect(mocks.show).toHaveBeenLastCalledWith({ loginOnly: true })
  })

  it('requests the logout confirmation after closing the menu', async () => {
    mocks.request.mockResolvedValueOnce({ signedIn: true }).mockResolvedValueOnce('cancelled')
    const close = vi.fn()
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <SidebarAccountMenu name="Test user" close={close} />
      </SWRConfig>
    )
    fireEvent.click(await screen.findByRole('button', { name: 'settings.provider.org_service.logout' }))
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
