// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  refetchMcpServers: vi.fn()
}))

vi.mock('@renderer/hooks/useOrgConnectors', () => ({
  useOrgConnectors: () => ({
    connectors: [
      {
        slug: 'weather',
        name: 'Weather',
        description: 'Weather connector',
        type: 'sse',
        baseUrl: 'https://enterprise.example/sse',
        config: {}
      }
    ],
    loading: false,
    error: null,
    install: mocks.install,
    installing: new Set<string>(),
    refetch: vi.fn()
  })
}))

vi.mock('@renderer/hooks/useMcpServer', () => ({
  useMcpServers: () => ({
    mcpServers: [],
    refetch: mocks.refetchMcpServers
  })
}))

vi.mock('@renderer/components/CollapsibleSearchBar', () => ({
  default: () => null
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

import OrgConnectorList from '../OrgConnectorList'

describe('OrgConnectorList', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.install.mockResolvedValue(undefined)
    mocks.refetchMcpServers.mockResolvedValue(undefined)
  })

  it('refreshes My MCP after installing an organization connector', async () => {
    const user = userEvent.setup()
    render(<OrgConnectorList />)
    await waitFor(() => expect(mocks.refetchMcpServers).toHaveBeenCalled())
    mocks.refetchMcpServers.mockClear()

    await user.click(screen.getByRole('button', { name: 'settings.mcp.install' }))

    await waitFor(() => expect(mocks.install).toHaveBeenCalledWith('weather'))
    expect(mocks.refetchMcpServers).toHaveBeenCalledOnce()
  })
})
