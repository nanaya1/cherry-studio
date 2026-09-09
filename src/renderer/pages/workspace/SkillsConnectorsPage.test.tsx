// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

type MockSkillController = {
  gridProps: {
    onOpenSkillMarketplace: () => void
    onOpenSystemSkills: () => void
    onCreate: (type: string) => void
  }
  dialogs: {
    skillMarketplaceOpen: boolean
    systemSkillOpen: boolean
    skillImportOpen: boolean
  }
}

vi.mock('@renderer/components/resourceCatalog/catalog', () => ({
  RecommendedSkillCatalogView: ({ search }: { search: string }) => <div>recommended skills: {search}</div>,
  SkillCatalogDialogs: ({ controller }: { controller: MockSkillController }) => (
    <div>
      skill dialogs: {controller.dialogs.skillMarketplaceOpen ? 'marketplace' : ''}
      {controller.dialogs.systemSkillOpen ? 'system' : ''}
      {controller.dialogs.skillImportOpen ? 'import' : ''}
    </div>
  ),
  SkillCatalogHeaderActions: ({ controller }: { controller: MockSkillController }) => (
    <div>
      <button type="button" onClick={controller.gridProps.onOpenSkillMarketplace}>
        marketplace
      </button>
      <button type="button" onClick={controller.gridProps.onOpenSystemSkills}>
        system
      </button>
      <button type="button" onClick={() => controller.gridProps.onCreate('skill')}>
        import
      </button>
    </div>
  ),
  SkillCatalogView: ({ showDialogs }: { showDialogs?: boolean }) => (
    <div>installed skills: {showDialogs === false ? 'shared dialogs' : 'own dialogs'}</div>
  )
}))

vi.mock('@renderer/hooks/resourceCatalog', () => ({
  useResourceCatalogController: () => {
    const [skillMarketplaceOpen, setSkillMarketplaceOpen] = useState(false)
    const [systemSkillOpen, setSystemSkillOpen] = useState(false)
    const [skillImportOpen, setSkillImportOpen] = useState(false)
    return {
      gridProps: {
        allResources: [{ type: 'skill' }, { type: 'skill' }, { type: 'assistant' }],
        onOpenSkillMarketplace: () => setSkillMarketplaceOpen(true),
        onOpenSystemSkills: () => setSystemSkillOpen(true),
        onCreate: () => setSkillImportOpen(true)
      },
      dialogs: { skillMarketplaceOpen, systemSkillOpen, skillImportOpen }
    }
  }
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
    expect(screen.getByText('skill dialogs:')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /My installed/ })).toHaveTextContent('2')

    await user.click(screen.getByRole('button', { name: 'marketplace' }))
    expect(screen.getByText(/skill dialogs: marketplace/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'system' }))
    expect(screen.getByText(/skill dialogs: marketplacesystem/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'import' }))
    expect(screen.getByText(/skill dialogs: marketplacesystemimport/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /My installed/ }))
    expect(screen.getByText('installed skills: shared dialogs')).toBeVisible()
    expect(screen.queryByText('installed skill actions')).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Skills' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'All skills' }))
    expect(screen.getByText('recommended skills:')).toBeVisible()

    await user.click(screen.getByRole('tab', { name: 'Connectors' }))
    expect(screen.getByText('connector catalog')).toBeVisible()
  })
})
