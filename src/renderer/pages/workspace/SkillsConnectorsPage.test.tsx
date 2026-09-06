// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  openSettingsTab: vi.fn()
}))

vi.mock('@renderer/components/resourceCatalog/catalog', () => ({
  SkillCatalogHeaderActions: () => <div>skill actions</div>,
  SkillCatalogView: () => <div>skill catalog</div>
}))

vi.mock('@renderer/hooks/resourceCatalog', () => ({
  useResourceCatalogController: () => ({})
}))

vi.mock('@renderer/services/mainWindowNavigation', () => ({
  openSettingsTab: mocks.openSettingsTab
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'workspace.skillsConnectors.title': 'Skills & Connectors',
        'settings.skills.title': 'Skills',
        'workspace.resources.connectors': 'Connectors',
        'workspace.resources.connectorsDescription': 'Manage existing connectors.',
        'title.mcp-servers': 'MCP Servers',
        'workspace.resources.mcpDescription': 'Manage MCP servers.',
        'settings.channels.title': 'Channels',
        'workspace.resources.channelsDescription': 'Manage message channels.'
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
    render(<SkillsConnectorsPage />)

    expect(screen.getByRole('tab', { name: 'Skills' })).toBeVisible()
    expect(screen.getByText('skill catalog')).toBeVisible()
    expect(screen.getByText('skill actions')).toBeVisible()

    await user.click(screen.getByRole('tab', { name: 'Connectors' }))
    expect(screen.getByRole('heading', { name: 'Connectors' })).toBeVisible()
  })

  it('opens the existing connector settings pages', async () => {
    const user = userEvent.setup()
    render(<SkillsConnectorsPage />)

    await user.click(screen.getByRole('tab', { name: 'Connectors' }))
    await user.click(screen.getByRole('button', { name: /MCP Servers/ }))
    expect(mocks.openSettingsTab).toHaveBeenLastCalledWith('/settings/mcp/servers')

    await user.click(screen.getByRole('button', { name: /Channels/ }))
    expect(mocks.openSettingsTab).toHaveBeenLastCalledWith('/settings/channels')
  })
})
