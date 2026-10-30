import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProtocolMcpInstallRequest, ProtocolMcpServerInstall } from '@shared/data/types/mcpProtocolInstall'
import type { McpServer } from '@shared/data/types/mcpServer'

import McpServersList from '../McpServersList'

const mocks = vi.hoisted(() => ({
  addMcpServer: vi.fn(),
  ipcRequest: vi.fn(),
  navigate: vi.fn(),
  quickCreateOnCreate: undefined as undefined | ((dto: unknown) => Promise<void>),
  pendingProtocolInstalls: [] as ProtocolMcpInstallRequest[],
  protocolInstallRequestId: 'request-1',
  refetch: vi.fn()
}))

vi.mock('@cherrystudio/ui', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useDndReorder: () => ({ onSortEnd: vi.fn() })
  }
})

vi.mock('@renderer/hooks/useMcpServer', () => ({
  useMcpServers: () => ({
    mcpServers: [],
    addMcpServer: mocks.addMcpServer,
    reorderMcpServers: vi.fn(),
    refetch: mocks.refetch
  })
}))

vi.mock('@renderer/ipc', () => ({
  ipcApi: { request: mocks.ipcRequest }
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useMatches: () => [],
  getRouteApi: () => ({
    useSearch: () => ({ protocolInstallRequestId: mocks.protocolInstallRequestId })
  })
}))

vi.mock('@renderer/components/CollapsibleSearchBar', () => ({ default: () => null }))
vi.mock('@renderer/pages/settings/DependenciesSettings/EnvironmentDependencies', () => ({ default: () => null }))
vi.mock('../AddMcpServerModal', () => ({ default: () => null }))
vi.mock('../QuickCreateMcpServerDialog', () => ({
  default: ({ onCreate }: { onCreate: (dto: unknown) => Promise<void> }) => {
    mocks.quickCreateOnCreate = onCreate
    return null
  }
}))
vi.mock('../McpServerCard', () => ({ default: () => null }))

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<object>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key })
  }
})

const protocolServers: ProtocolMcpServerInstall[] = [
  {
    name: 'first-server',
    type: 'stdio',
    command: 'npx',
    installSource: 'protocol',
    isActive: false,
    isTrusted: false,
    installedAt: 1
  },
  {
    name: 'second-server',
    type: 'stdio',
    command: 'uvx',
    installSource: 'protocol',
    isActive: false,
    isTrusted: false,
    installedAt: 2
  }
]

describe('McpServersList protocol install', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.protocolInstallRequestId = 'request-1'
    mocks.pendingProtocolInstalls = [{ requestId: 'request-1', servers: protocolServers }]
    mocks.ipcRequest.mockImplementation(async (route: string, input?: { requestId: string }) => {
      if (route === 'mcp.protocol_install.list_pending') {
        return mocks.pendingProtocolInstalls
      }

      const request = mocks.pendingProtocolInstalls.find(({ requestId }) => requestId === input?.requestId)
      if (route === 'mcp.protocol_install.install') {
        if (!request) throw new Error('request not found')
        mocks.pendingProtocolInstalls = mocks.pendingProtocolInstalls.filter(
          ({ requestId }) => requestId !== input?.requestId
        )
        return request.servers.map((server) => ({ ...server, id: `${server.name}-id` }))
      }

      if (route === 'mcp.protocol_install.cancel') {
        mocks.pendingProtocolInstalls = mocks.pendingProtocolInstalls.filter(
          ({ requestId }) => requestId !== input?.requestId
        )
        return undefined
      }

      throw new Error(`unexpected route: ${route}`)
    })
    mocks.refetch.mockResolvedValue(undefined)
    mocks.addMcpServer.mockResolvedValue({ id: 'created-server-id' })
  })

  it('keeps the connector catalog open after quick creation', async () => {
    render(<McpServersList variant="catalog" />)

    await waitFor(() => expect(mocks.quickCreateOnCreate).toBeDefined())
    await mocks.quickCreateOnCreate!({ name: 'created-server' })

    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('opens the editor after quick creation from settings', async () => {
    render(<McpServersList />)

    await waitFor(() => expect(mocks.quickCreateOnCreate).toBeDefined())
    await mocks.quickCreateOnCreate!({ name: 'created-server' })

    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/settings/mcp/settings/created-server-id' })
  })

  it('waits for install confirmation, creates in order, and requests run confirmation for the last server', async () => {
    const user = userEvent.setup()
    render(<McpServersList />)

    expect(await screen.findByText('first-server')).toBeInTheDocument()
    expect(screen.getByText('second-server')).toBeInTheDocument()
    expect(mocks.ipcRequest).toHaveBeenCalledWith('mcp.protocol_install.list_pending')

    await user.click(screen.getByRole('button', { name: 'settings.mcp.install' }))

    await waitFor(() =>
      expect(mocks.ipcRequest).toHaveBeenCalledWith('mcp.protocol_install.install', { requestId: 'request-1' })
    )
    expect(mocks.refetch).toHaveBeenCalledOnce()
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/settings/mcp/settings/$serverId',
      params: { serverId: 'second-server-id' },
      search: { autoEnable: 'true' }
    })
  })

  it('restores a pending request after remount and removes it only after cancellation', async () => {
    const user = userEvent.setup()
    const view = render(<McpServersList />)

    expect(await screen.findByText('first-server')).toBeInTheDocument()
    view.unmount()
    render(<McpServersList />)
    expect(await screen.findByText('first-server')).toBeInTheDocument()
    expect(mocks.ipcRequest.mock.calls.filter(([route]) => route === 'mcp.protocol_install.list_pending')).toHaveLength(
      2
    )

    await user.click(screen.getByRole('button', { name: 'common.cancel' }))
    await waitFor(() =>
      expect(mocks.ipcRequest).toHaveBeenCalledWith('mcp.protocol_install.cancel', { requestId: 'request-1' })
    )
    expect(screen.queryByText('first-server')).not.toBeInTheDocument()
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('keeps a new request queued until the current install completes', async () => {
    const user = userEvent.setup()
    let resolveInstall!: (servers: McpServer[]) => void
    const installRequest = new Promise<McpServer[]>((resolve) => {
      resolveInstall = resolve
    })
    const request = mocks.ipcRequest.getMockImplementation()!
    mocks.ipcRequest.mockImplementation((route: string, input?: { requestId: string }) =>
      route === 'mcp.protocol_install.install' ? installRequest : request(route, input)
    )

    const view = render(<McpServersList />)
    expect(await screen.findByText('first-server')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'settings.mcp.install' }))

    mocks.pendingProtocolInstalls = [
      ...mocks.pendingProtocolInstalls,
      {
        requestId: 'request-2',
        servers: [
          {
            name: 'queued-server',
            type: 'stdio',
            command: 'node',
            installSource: 'protocol',
            isActive: false,
            isTrusted: false,
            installedAt: 3
          }
        ]
      }
    ]
    mocks.protocolInstallRequestId = 'request-2'
    view.rerender(<McpServersList />)

    await waitFor(() =>
      expect(
        mocks.ipcRequest.mock.calls.filter(([route]) => route === 'mcp.protocol_install.list_pending')
      ).toHaveLength(2)
    )
    expect(screen.queryByText('queued-server')).not.toBeInTheDocument()

    mocks.pendingProtocolInstalls = mocks.pendingProtocolInstalls.filter(({ requestId }) => requestId !== 'request-1')
    await act(async () => resolveInstall(protocolServers.map((server) => ({ ...server, id: `${server.name}-id` }))))

    expect(await screen.findByText('queued-server')).toBeInTheDocument()
    expect(mocks.navigate).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'common.cancel' }))
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({
        to: '/settings/mcp/settings/$serverId',
        params: { serverId: 'second-server-id' },
        search: { autoEnable: 'true' }
      })
    )
  })
})
