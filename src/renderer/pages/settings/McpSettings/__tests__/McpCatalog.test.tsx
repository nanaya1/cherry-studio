// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
// import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as UI from '@cherrystudio/ui'

const { orgSessionMock } = vi.hoisted(() => ({
  orgSessionMock: { phase: 'signed-in', authMode: 'management-exchange' }
}))

vi.mock('@renderer/hooks/useOrgAccountSession', () => ({
  useOrgAccountSession: () => ({ status: orgSessionMock })
}))

vi.mock('@renderer/hooks/useMcpServer', () => ({
  useMcpServers: () => ({ mcpServers: [{ id: 'installed-server' }] })
}))

vi.mock('../BuiltinMcpServerList', () => ({
  default: ({ variant, toolbarStart }: { variant: string; toolbarStart: ReactNode }) => (
    <div>
      {toolbarStart}
      builtin {variant}
    </div>
  )
}))

vi.mock('../McpMarketList', () => ({
  default: ({ variant, toolbarStart }: { variant: string; toolbarStart: ReactNode }) => (
    <div>
      {toolbarStart}
      market {variant}
    </div>
  )
}))

vi.mock('../OrgConnectorList', () => ({
  default: ({ variant }: { variant: string }) => <div>organization {variant}</div>
}))

vi.mock('../McpServersList', () => ({
  default: ({ variant, showTitle }: { variant: string; showTitle: boolean }) => (
    <div>
      installed {variant} {String(showTitle)}
    </div>
  )
}))

vi.mock('../McpProviderSettings', () => ({
  default: ({
    provider,
    existingServers,
    onBack
  }: {
    provider: { key: string }
    existingServers: unknown[]
    onBack: () => void
  }) => (
    <div>
      provider detail {provider.key} {existingServers.length}
      <button type="button" onClick={onBack}>
        Back
      </button>
    </div>
  )
}))

vi.mock('../providers/config', () => ({
  providers: [
    { key: 'bailian', nameKey: 'Bailian' },
    { key: 'modelscope', nameKey: 'ModelScope' }
  ],
  getProviderDisplayName: (provider: { nameKey: string }) => provider.nameKey,
  getMcpProviderLogo: () => undefined
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'common.close': 'Close',
        'settings.mcp.builtinServers': 'Built-in Servers',
        'settings.mcp.discover': 'Discover',
        'settings.mcp.marketplaces': 'Marketplaces',
        'settings.mcp.myServers': 'My MCP',
        'settings.mcp.providers': 'Providers',
        'settings.provider.api_key.label': 'API Key',
        'workspace.skillsConnectors.sources.org': 'Organization'
      })[key] ?? key
  })
}))

vi.mock('@cherrystudio/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof UI>())
}))

import McpCatalog from '../McpCatalog'

afterEach(() => {
  cleanup()
  orgSessionMock.authMode = 'management-exchange'
  orgSessionMock.phase = 'signed-in'
})

describe('McpCatalog', () => {
  it.each([
    ['signed-out', 'management-exchange'],
    ['signed-in', 'official-direct']
  ])('hides public MCP for %s / %s', (phase, authMode) => {
    Object.assign(orgSessionMock, { phase, authMode })
    render(<McpCatalog />)

    expect(screen.queryByRole('tab', { name: 'Organization' })).not.toBeInTheDocument()
  })

  it('allows signed-in management OAuth accounts to open public MCP', async () => {
    orgSessionMock.authMode = 'management-oauth'
    const user = userEvent.setup()
    render(<McpCatalog />)

    await user.click(screen.getByRole('tab', { name: 'Organization' }))
    expect(screen.getByRole('tab', { name: 'Organization' })).toHaveAttribute('aria-selected', 'true')
  })

  // 公共目录恢复后，发现和服务商入口仍须保持隐藏。
  it('presents public MCP alongside built-in servers and My MCP without other catalogs', async () => {
    const user = userEvent.setup()
    render(<McpCatalog />)

    expect(screen.getByRole('tab', { name: 'Built-in Servers' })).toBeVisible()
    expect(screen.getByRole('tab', { name: 'My MCP' })).toBeVisible()
    expect(screen.queryByRole('tab', { name: 'Discover' })).not.toBeInTheDocument()
    expect(screen.getByText('builtin catalog')).toBeVisible()
    await user.click(screen.getByRole('tab', { name: 'Organization' }))
    expect(screen.getByRole('tab', { name: 'Organization' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Built-in Servers' })).toHaveAttribute('aria-selected', 'false')
    expect(screen.queryByRole('tab', { name: 'Providers' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Marketplaces' })).not.toBeInTheDocument()
    expect(screen.getByRole('tabpanel')).toHaveTextContent('organization catalog')

    await user.click(screen.getByRole('tab', { name: 'My MCP' }))
    expect(screen.getByText('installed catalog false')).toBeVisible()

    await user.click(screen.getByRole('tab', { name: 'Built-in Servers' }))
    expect(screen.getByText('builtin catalog')).toBeVisible()
  })
})
