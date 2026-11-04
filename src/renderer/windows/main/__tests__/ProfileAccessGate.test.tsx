import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { EnterpriseVerificationStatus } from '@shared/ipc/schemas/enterprise'

const boundary = vi.hoisted(() => ({ request: vi.fn() }))

// Use real primitives: a lightweight Dialog fake cannot prove the non-dismissable contract.
vi.mock('@cherrystudio/ui', async () => ({
  ...(await import('@cherrystudio/ui/components/primitives/dialog')),
  ...(await import('@cherrystudio/ui/components/primitives/button'))
}))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request: boundary.request } }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      (
        ({
          'profile_access.title': 'Account access paused',
          'profile_access.credentials_invalid': 'Sign in again. Your local data will not be deleted.',
          'profile_access.account_disabled': 'Contact your administrator to restore account access.',
          'profile_access.identity_changed': 'Confirm your account before continuing.',
          'profile_access.quit': 'Quit application',
          'profile_access.login_again': 'Sign in again',
          'profile_access.other_account': 'Use another account'
        }) as Record<string, string>
      )[key] ?? key
  })
}))

import { ProfileAccessGate } from '../ProfileAccessGate'

const blocked = (
  reason: EnterpriseVerificationStatus['reason'] = 'credentials-invalid'
): EnterpriseVerificationStatus => ({
  owner: 'owner-a',
  revision: 3,
  state: 'blocked',
  reason
})

describe('ProfileAccessGate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    boundary.request.mockResolvedValue({ state: 'switching', revocationWarning: null })
  })

  it('cannot be dismissed by Escape or outside input and never logs out in the background', async () => {
    const user = userEvent.setup()
    render(<ProfileAccessGate status={blocked()} />)
    const dialog = screen.getByRole('dialog', { name: 'Account access paused' })
    await user.keyboard('{Escape}')
    fireEvent.pointerDown(document.body)
    fireEvent.click(document.body)
    expect(dialog).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()
    expect(boundary.request).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Sign in again' }))
    expect(boundary.request).toHaveBeenCalledExactlyOnceWith('enterprise.session.logout')
  })

  it('offers another-account login for disabled accounts and uses normal application quit', async () => {
    const user = userEvent.setup()
    render(<ProfileAccessGate status={blocked('account-disabled')} />)
    expect(screen.getByText('Contact your administrator to restore account access.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Use another account' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Quit application' }))
    expect(boundary.request).toHaveBeenCalledExactlyOnceWith('app.quit')
  })

  it('does not show a global prompt for temporary unavailability or healthy verification', () => {
    const { rerender } = render(<ProfileAccessGate status={{ owner: 'owner-a', revision: 2, state: 'unavailable' }} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    rerender(<ProfileAccessGate status={{ owner: 'owner-a', revision: 3, state: 'verified' }} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(boundary.request).not.toHaveBeenCalled()
  })
})
