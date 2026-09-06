// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/hooks/useMcpServer', () => ({
  useMcpServers: () => ({ mcpServers: [{ id: 'installed-server' }] })
}))

vi.mock('../BuiltinMcpServerList', () => ({
  default: ({ variant }: { variant: string }) => <div>builtin {variant}</div>
}))

vi.mock('../McpMarketList', () => ({
  default: ({ variant }: { variant: string }) => <div>market {variant}</div>
}))

vi.mock('../McpServersList', () => ({
  default: ({ variant, showTitle }: { variant: string; showTitle: boolean }) => (
    <div>
      installed {variant} {String(showTitle)}
    </div>
  )
}))

vi.mock('../McpProviderSettings', () => ({
  default: ({ provider, existingServers }: { provider: { key: string }; existingServers: unknown[] }) => (
    <div>
      provider detail {provider.key} {existingServers.length}
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
        'common.back': 'Back',
        'settings.mcp.builtinServers': 'Built-in Servers',
        'settings.mcp.discover': 'Discover',
        'settings.mcp.marketplaces': 'Marketplaces',
        'settings.mcp.myServers': 'My MCP',
        'settings.mcp.providers': 'Providers',
        'settings.provider.api_key.label': 'API Key'
      })[key] ?? key
  })
}))

import McpCatalog from '../McpCatalog'

afterEach(cleanup)

describe('McpCatalog', () => {
  it('presents discovery, provider, and installed MCP views from the settings sources', async () => {
    const user = userEvent.setup()
    render(<McpCatalog />)

    expect(screen.getByRole('tab', { name: 'Discover' })).toBeVisible()
    expect(screen.getByRole('tab', { name: 'Providers' })).toBeVisible()
    expect(screen.getByRole('tab', { name: 'My MCP' })).toBeVisible()
    expect(screen.getByText('builtin catalog')).toBeVisible()

    await user.click(screen.getByRole('tab', { name: 'Marketplaces' }))
    expect(screen.getByText('market catalog')).toBeVisible()

    await user.click(screen.getByRole('button', { name: /Bailian/ }))
    expect(screen.getByText('provider detail bailian 1')).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('button', { name: /ModelScope/ })).toBeVisible()

    expect(screen.getByText('installed catalog false')).toBeVisible()
  })
})
