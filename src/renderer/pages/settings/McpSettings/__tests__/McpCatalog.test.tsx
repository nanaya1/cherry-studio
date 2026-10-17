// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
// import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { orgSessionMock } = vi.hoisted(() => ({
  orgSessionMock: { authMode: 'management-exchange' }
}))

vi.mock('@renderer/hooks/useOrgAccountSession', () => ({
  useOrgAccountSession: () => ({ status: { authMode: orgSessionMock.authMode } })
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

import McpCatalog from '../McpCatalog'

afterEach(() => {
  cleanup()
  orgSessionMock.authMode = 'management-exchange'
})

describe('McpCatalog', () => {
  // 上游原契约按登录模式显示发现、公共、服务商与我的 MCP，并允许在发现页切换市场。
  // MEA 连接器目录只保留内置服务器与我的 MCP 两个入口。
  it('only presents built-in servers and My MCP', async () => {
    const user = userEvent.setup()
    render(<McpCatalog />)

    expect(screen.getByRole('tab', { name: 'Built-in Servers' })).toBeVisible()
    expect(screen.getByRole('tab', { name: 'My MCP' })).toBeVisible()
    expect(screen.queryByRole('tab', { name: 'Discover' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Organization' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Providers' })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Marketplaces' })).not.toBeInTheDocument()
    expect(screen.getByText('builtin catalog')).toBeVisible()

    await user.click(screen.getByRole('tab', { name: 'My MCP' }))
    expect(screen.getByText('installed catalog false')).toBeVisible()

    await user.click(screen.getByRole('tab', { name: 'Built-in Servers' }))
    expect(screen.getByText('builtin catalog')).toBeVisible()
  })
})
