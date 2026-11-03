// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  install: vi.fn(),
  refetchMcpServers: vi.fn(),
  connectorsState: {
    connectors: [
      {
        slug: 'weather',
        name: 'Weather',
        description: 'Weather connector',
        type: 'sse' as const,
        baseUrl: 'https://enterprise.example/sse',
        config: {}
      }
    ],
    loading: false,
    error: null as string | null,
    installing: new Set<string>(),
    refetch: vi.fn()
  }
}))

vi.mock('@renderer/hooks/useOrgConnectors', () => ({
  useOrgConnectors: () => ({
    connectors: mocks.connectorsState.connectors,
    loading: mocks.connectorsState.loading,
    error: mocks.connectorsState.error,
    install: mocks.install,
    installing: mocks.connectorsState.installing,
    refetch: mocks.connectorsState.refetch
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
    mocks.connectorsState.connectors = [
      {
        slug: 'weather',
        name: 'Weather',
        description: 'Weather connector',
        type: 'sse',
        baseUrl: 'https://enterprise.example/sse',
        config: {}
      }
    ]
    mocks.connectorsState.loading = false
    mocks.connectorsState.error = null
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

  // [enterprise] 刷新失败（已成功加载过）保留旧卡片，错误以非阻塞提示呈现，不整屏覆盖
  it('keeps the previous connector cards with a non-blocking notice when a refresh fails after a successful load', () => {
    mocks.connectorsState.connectors = [
      {
        slug: 'weather',
        name: 'Weather',
        description: 'Weather connector',
        type: 'sse',
        baseUrl: 'https://enterprise.example/sse',
        config: {}
      }
    ]
    mocks.connectorsState.error = '企业服务请求失败 (500)'

    render(<OrgConnectorList />)

    // 旧卡片仍可见（未被整屏错误替换）
    expect(screen.getByText('Weather')).toBeVisible()
    // 非阻塞错误提示（role=alert）
    const alert = screen.getByRole('alert')
    expect(within(alert).getByText('企业服务请求失败 (500)')).toBeVisible()
  })
})
