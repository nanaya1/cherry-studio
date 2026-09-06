// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/components/resourceCatalog/catalog', () => ({
  SkillCatalogView: () => <div>skill catalog</div>
}))

vi.mock('@renderer/hooks/resourceCatalog', () => ({
  useResourceCatalogController: () => ({})
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'workspace.skillsConnectors.title': 'Skills & Connectors',
        'settings.skills.title': 'Skills',
        'workspace.resources.connectors': 'Connectors',
        'workspace.resources.connectorsDescription': 'Manage existing connectors.'
      })[key] ?? key
  })
}))

import SkillsConnectorsPage from './SkillsConnectorsPage'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SkillsConnectorsPage', () => {
  it('shows the skill catalog by default and switches to the connector page', async () => {
    const user = userEvent.setup()
    render(<SkillsConnectorsPage connectorView={<div>connector catalog</div>} />)

    expect(screen.getByRole('tab', { name: 'Skills' })).toBeVisible()
    expect(screen.getByText('skill catalog')).toBeVisible()

    await user.click(screen.getByRole('tab', { name: 'Connectors' }))
    expect(screen.getByText('connector catalog')).toBeVisible()
  })
})
