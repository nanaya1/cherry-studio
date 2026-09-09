// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/components/resourceCatalog/catalog', () => ({
  RecommendedSkillCatalogView: ({ search }: { search: string }) => <div>recommended skills: {search}</div>,
  SkillCatalogHeaderActions: () => <div>installed skill actions</div>,
  SkillCatalogView: () => <div>installed skills</div>
}))

vi.mock('@renderer/hooks/resourceCatalog', () => ({
  useResourceCatalogController: () => ({
    gridProps: {
      allResources: [{ type: 'skill' }, { type: 'skill' }, { type: 'assistant' }]
    }
  })
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'workspace.skillsConnectors.title': 'Skills & Connectors',
        'settings.skills.title': 'Skills',
        'workspace.resources.connectors': 'Connectors',
        'workspace.resources.connectorsDescription': 'Manage existing connectors.',
        'workspace.skill_catalog.all_skills': 'All skills',
        'workspace.skill_catalog.my_installed': 'My installed',
        'workspace.skill_catalog.recommended': 'Recommended skills'
      })[key] ?? key
  })
}))

import SkillsConnectorsPage from './SkillsConnectorsPage'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SkillsConnectorsPage', () => {
  it('shows recommended skills by default and preserves access to installed skills', async () => {
    const user = userEvent.setup()
    render(<SkillsConnectorsPage connectorView={<div>connector catalog</div>} />)

    expect(screen.getByRole('tab', { name: 'Skills' })).toBeVisible()
    expect(screen.getByText('recommended skills:')).toBeVisible()
    expect(screen.getByRole('button', { name: /My installed/ })).toHaveTextContent('2')

    await user.click(screen.getByRole('button', { name: /My installed/ }))
    expect(screen.getByText('installed skills')).toBeVisible()
    expect(screen.queryByText('installed skill actions')).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Skills' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'All skills' }))
    expect(screen.getByText('recommended skills:')).toBeVisible()

    await user.click(screen.getByRole('tab', { name: 'Connectors' }))
    expect(screen.getByText('connector catalog')).toBeVisible()
  })
})
