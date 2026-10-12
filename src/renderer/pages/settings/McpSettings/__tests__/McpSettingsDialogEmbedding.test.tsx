// Regression test for the catalog/dialog embedding of McpSettings:
// outside '/settings/mcp/settings/$serverId' the strict routeApi.useSearch throws
// "Invariant failed: Could not find an active match" and crashes the whole page.
// These tests run the REAL router with a match chain that does NOT contain the
// route (the /app/skills-connectors embedding scenario), unlike McpSettings.test.tsx
// which mocks @tanstack/react-router entirely.
import '@testing-library/jest-dom/vitest'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as UI from '@cherrystudio/ui'
import type { McpServer } from '@shared/data/types/mcpServer'

import McpSettings from '../McpSettings'

vi.mock('@cherrystudio/ui', async (importOriginal) => importOriginal<typeof UI>())

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  updateMcpServer: vi.fn()
}))

vi.mock('@renderer/hooks/useMcpServer', () => ({
  useMcpServer: () => ({
    server: serverFixture(),
    isLoading: false,
    updateMcpServer: mocks.updateMcpServer
  }),
  useMcpServerMutations: () => ({ updateMcpServer: mocks.updateMcpServer })
}))

vi.mock('@renderer/ipc', () => ({
  ipcApi: { on: vi.fn(() => vi.fn()), request: mocks.request }
}))

vi.mock('@renderer/data/hooks/useCache', () => ({ useSharedCacheValue: () => undefined }))
vi.mock('@renderer/hooks/useMcpRuntimeStatus', () => ({
  useMcpRuntimeStatus: () => ({ state: 'disabled', lastError: undefined })
}))
vi.mock('@renderer/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'light' }) }))
vi.mock('@renderer/components/CollapsibleSearchBar', () => ({ default: () => null }))
vi.mock('@renderer/components/Scrollbar', () => ({ default: ({ children }: { children: ReactNode }) => children }))
vi.mock('@renderer/components/SettingsPrimitives', () => ({
  SettingContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingDivider: () => <hr />,
  SettingTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))
vi.mock('@renderer/pages/settings/McpSettings/McpDescription', () => ({ default: () => null }))
vi.mock('../McpPrompt', () => ({ default: () => null }))
vi.mock('../McpResource', () => ({ default: () => null }))
vi.mock('../McpTool', () => ({ default: () => null }))
vi.mock('../McpServerFields', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    McpEndpointField: () => null,
    McpIdentityFields: () => <span>Server name</span>,
    McpRuntimeFields: () => null,
    McpTransportFields: () => null
  }
})

const server: McpServer = {
  id: 'catalog-server-id',
  name: 'catalog-server',
  type: 'stdio',
  command: 'printf',
  installSource: 'protocol',
  isActive: false,
  isTrusted: false
}
const serverFixture = () => server

// Render inside a router whose active match chain does NOT contain
// '/settings/mcp/settings/$serverId' — exactly the catalog embedding situation.
function renderOutsideSettingsRoute(ui: ReactNode) {
  const rootRoute = createRootRoute()
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/app/skills-connectors',
    component: () => <>{ui}</>
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/app/skills-connectors'] })
  })
  return render(<RouterProvider router={router} />)
}

describe('McpSettings outside its route (catalog dialog embedding)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.request.mockResolvedValue([])
    mocks.updateMcpServer.mockResolvedValue(undefined)
  })

  it('does not throw the strict useSearch invariant when embedded outside its route', async () => {
    renderOutsideSettingsRoute(<McpSettings serverId={server.id} />)

    // The invariant crashes the subtree; the router's error screen replaces it.
    // A correct implementation renders the server name instead.
    expect(await screen.findByText('catalog-server', {}, { timeout: 2000 })).toBeInTheDocument()
    expect(screen.queryByText(/Invariant failed/)).not.toBeInTheDocument()
  })
})
