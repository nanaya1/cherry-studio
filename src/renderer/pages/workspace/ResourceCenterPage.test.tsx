// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

const resourceCatalogViewMock = vi.fn()

vi.mock('@renderer/components/resourceCatalog/catalog', () => ({
  ResourceCatalogView: (props: { resourceType: string; showManagementActions?: boolean }) => {
    resourceCatalogViewMock(props)
    return <div>{`${props.resourceType} catalog`}</div>
  }
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'workspace.resources.title': 'Resource Center',
        'common.assistant_other': 'Assistants',
        'common.agent_other': 'Agents'
      })[key] ?? key
  })
}))

import ResourceCenterPage from './ResourceCenterPage'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ResourceCenterPage', () => {
  it('switches between the existing resource catalogs', async () => {
    const user = userEvent.setup()
    render(<ResourceCenterPage />)

    expect(screen.getByRole('heading', { name: 'Resource Center' })).toBeVisible()
    expect(screen.getByText('assistant catalog')).toBeVisible()
    expect(resourceCatalogViewMock).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'assistant', showManagementActions: false })
    )

    await user.click(screen.getByRole('tab', { name: 'Agents' }))
    expect(screen.getByText('agent catalog')).toBeVisible()
    expect(resourceCatalogViewMock).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'agent', showManagementActions: false })
    )
  })
})
