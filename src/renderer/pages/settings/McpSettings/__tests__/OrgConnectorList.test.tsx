// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  refetchMcpServers: vi.fn(),
  config: {} as Record<string, string>
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
        config: mocks.config
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
    mocks.config = {}
    mocks.install.mockResolvedValue(undefined)
    mocks.refetchMcpServers.mockResolvedValue(undefined)
  })

  it('shows configured icon and falls back to initial on image failure', () => {
    mocks.config = { logoUrl: 'data:image/png;base64,aGVsbG8=' }
    const { container } = render(<OrgConnectorList />)
    const image = container.querySelector('img')!
    expect(image).toHaveAttribute('src', mocks.config.logoUrl)
    fireEvent.error(image)
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('W')).toBeInTheDocument()
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
