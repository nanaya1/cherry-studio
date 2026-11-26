import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ProfileSettings } from '../ProfileSettings'

vi.mock('@renderer/components/UserProfileEditor', () => ({
  UserProfileEditor: () => <button type="button" aria-label="Avatar editor" />
}))
vi.mock('../SubscriptionSettings', () => ({
  SubscriptionSettings: () => <div>Subscription and quota</div>
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

describe('ProfileSettings', () => {
  it('offers local profile editing with subscriptions hidden', () => {
    render(<ProfileSettings />)

    expect(screen.getByRole('button', { name: 'Avatar editor' })).toBeInTheDocument()
    expect(screen.queryByText('Subscription and quota')).not.toBeInTheDocument()
  })
})
