import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ProfileSettings } from '../ProfileSettings'

const usePersonalAccountDetails = vi.hoisted(() => vi.fn())
const useSWR = vi.hoisted(() => vi.fn())
vi.mock('swr', () => ({ default: useSWR }))
vi.mock('@renderer/hooks/usePersonalAccountDetails', () => ({ usePersonalAccountDetails }))
vi.mock('@renderer/components/app/SidebarAccountMenu', () => ({ SidebarAccountMenu: () => null }))

vi.mock('@renderer/components/UserProfileEditor', () => ({
  UserProfileEditor: ({ showNameEditor }: { showNameEditor: boolean }) => (
    <>
      <button type="button" aria-label="Avatar editor" />
      {showNameEditor && <button type="button">Edit local name</button>}
    </>
  )
}))
vi.mock('../SubscriptionSettings', () => ({
  SubscriptionSettings: () => <div>Subscription and quota</div>
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

describe('ProfileSettings', () => {
  it('offers local profile editing with subscriptions hidden', () => {
    useSWR.mockReturnValue({ data: { signedIn: false } })
    usePersonalAccountDetails.mockReturnValue({ data: null })
    render(<ProfileSettings />)

    expect(screen.getByRole('button', { name: 'Avatar editor' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit local name' })).toBeInTheDocument()
    expect(screen.getByText('workspace.localUser')).toBeInTheDocument()
    expect(screen.queryByText('Subscription and quota')).not.toBeInTheDocument()
  })

  it('shows the account display name and username when signed in', () => {
    useSWR.mockReturnValue({ data: { signedIn: true } })
    usePersonalAccountDetails.mockReturnValue({ data: { displayName: '测试用户', username: 'test-user' } })
    render(<ProfileSettings />)

    expect(screen.getByText('测试用户')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit local name' })).not.toBeInTheDocument()
    expect(screen.getByText('test-user')).toBeInTheDocument()
  })

  it('does not label a signed-in space as local when account details are unavailable', () => {
    useSWR.mockReturnValue({ data: { signedIn: true } })
    usePersonalAccountDetails.mockReturnValue({ data: null })
    render(<ProfileSettings />)

    expect(screen.queryByText('workspace.localUser')).not.toBeInTheDocument()
    expect(screen.queryByText('settings.provider.oauth.logged_in')).not.toBeInTheDocument()
  })
})
