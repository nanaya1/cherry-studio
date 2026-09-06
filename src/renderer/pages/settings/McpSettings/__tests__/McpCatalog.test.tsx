// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Bailian' })).toHaveClass('sr-only')
    expect(screen.getByText('provider detail bailian 1')).toBeVisible()
    expect(screen.getByRole('button', { name: /ModelScope/ })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Back' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    expect(screen.getByText('installed catalog false')).toBeVisible()
  })
})
