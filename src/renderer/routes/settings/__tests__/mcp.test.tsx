import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { act, cleanup, render, screen } from '@testing-library/react'
import i18next from 'i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import SettingsPage from '@renderer/pages/settings/SettingsPage'
import {
  OPEN_MAIN_ROUTE_EVENT,
  type OpenMainRouteEvent,
  openSettingsTab
} from '@renderer/services/mainWindowNavigation'

import { skillsConnectorsSearchSchema } from '../../app/skills-connectors'
import { Route } from '../mcp'
import { redirectToMcpServers } from '../mcp.index'
import { redirectToMcpProvider } from '../mcp/$'
import { redirectToMcpCatalog } from '../mcp/builtin'
import { redirectToMcpSources } from '../mcp/marketplaces'
import { Route as ServersRoute } from '../mcp/servers'
import { Route as DetailRoute } from '../mcp/settings.$serverId'

vi.mock('@cherrystudio/ui', async (importOriginal) => importOriginal())
vi.mock('@renderer/pages/settings/McpSettings/McpServersList', () => ({ default: () => <h1>Server content</h1> }))
vi.mock('@renderer/pages/settings/McpSettings/McpSettings', () => ({ default: () => <h1>Server details</h1> }))
vi.mock('@renderer/pages/workspace/SkillsConnectorsPage', () => ({ default: () => null }))
vi.mock('@renderer/pages/settings/McpSettings/McpCatalog', () => ({ default: () => null }))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request: vi.fn().mockResolvedValue(undefined) } }))

function createMcpRouter(initialEntry: string) {
  const root = createRootRoute()
  const settings = createRoute({ getParentRoute: () => root, path: '/settings', component: SettingsPage })
  const prompts = createRoute({
    getParentRoute: () => settings,
    path: 'prompts',
    component: () => <h1>Prompt content</h1>
  })
  const mcp = createRoute({ getParentRoute: () => settings, path: '/mcp', component: Route.options.component })
  const index = createRoute({ getParentRoute: () => mcp, path: '/', beforeLoad: redirectToMcpServers })
  const servers = createRoute({
    getParentRoute: () => mcp,
    path: 'servers',
    validateSearch: ServersRoute.options.validateSearch,
    component: ServersRoute.options.component
  })
  const detail = createRoute({
    getParentRoute: () => mcp,
    path: 'settings/$serverId',
    validateSearch: DetailRoute.options.validateSearch,
    component: DetailRoute.options.component
  })
  const builtin = createRoute({
    getParentRoute: () => mcp,
    path: 'builtin',
    beforeLoad: redirectToMcpCatalog
  })
  const markets = createRoute({
    getParentRoute: () => mcp,
    path: 'marketplaces',
    beforeLoad: redirectToMcpSources
  })
  const provider = createRoute({
    getParentRoute: () => mcp,
    path: '$',
    beforeLoad: ({ params }) => redirectToMcpProvider(params._splat)
  })
  const marketplace = createRoute({
    getParentRoute: () => root,
    path: '/app/skills-connectors',
    validateSearch: (search) => skillsConnectorsSearchSchema.parse(search),
    component: () => <h1>Connector content</h1>
  })
  return createRouter({
    routeTree: root.addChildren([
      settings.addChildren([prompts, mcp.addChildren([index, servers, detail, builtin, markets, provider])]),
      marketplace
    ]),
    history: createMemoryHistory({ initialEntries: [initialEntry] })
  })
}

beforeEach(async () => {
  await i18next.changeLanguage('en-us')
  vi.stubGlobal('scrollTo', vi.fn())
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('MCP navigation', () => {
  it.each(['/settings/mcp/servers', '/settings/mcp/servers?mcpStandalone=true'])(
    'shows the server list without a second sidebar at %s',
    async (path) => {
      const router = createMcpRouter(path)
      await router.load()
      render(<RouterProvider router={router} />)
      expect(await screen.findByRole('heading', { name: 'Server content' })).toBeVisible()
      expect(screen.getByRole('button', { name: 'Search settings' })).toBeVisible()
      expect(screen.queryByText('Builtin Servers')).not.toBeInTheDocument()
      expect(screen.queryByText('ModelScope')).not.toBeInTheDocument()
    }
  )

  it('keeps list and detail navigation available after opening management and returning from other settings', async () => {
    const router = createMcpRouter('/settings/prompts')
    await router.load()
    render(<RouterProvider router={router} />)
    let navigation: Promise<unknown> | undefined
    const listener = (event: Event) => {
      event.preventDefault()
      const [to, search] = (event as OpenMainRouteEvent).detail.path.split('?')
      navigation = router.navigate({ to, search: Object.fromEntries(new URLSearchParams(search)) })
    }
    window.addEventListener(OPEN_MAIN_ROUTE_EVENT, listener)
    try {
      await act(async () => {
        openSettingsTab('/settings/mcp/servers')
        await navigation
      })
    } finally {
      window.removeEventListener(OPEN_MAIN_ROUTE_EVENT, listener)
    }
    expect(await screen.findByRole('heading', { name: 'Server content' })).toBeVisible()
    await act(async () => {
      await router.navigate({ to: '/settings/mcp/settings/$serverId', params: { serverId: 'server-1' } })
    })
    expect(await screen.findByRole('heading', { name: 'Server details' })).toBeVisible()
    await act(async () => {
      await router.navigate({ to: '/settings/prompts' })
    })
    expect(screen.queryByRole('button', { name: /^ModelContextProtocol MCP$/ })).not.toBeInTheDocument()
    await act(async () => {
      await router.navigate({ to: '/settings/mcp/servers' })
    })
    expect(await screen.findByRole('heading', { name: 'Server content' })).toBeVisible()
    expect(screen.queryByText('Builtin Servers')).not.toBeInTheDocument()
  })

  it.each([
    ['/settings/mcp/builtin', { tab: 'connector', connectorView: 'builtin' }],
    ['/settings/mcp/marketplaces', { tab: 'connector', connectorView: 'marketplace' }],
    ['/settings/mcp/bailian', { tab: 'connector', connectorView: 'providers', connectorProvider: 'bailian' }],
    ['/settings/mcp/modelscope', { tab: 'connector', connectorView: 'providers', connectorProvider: 'modelscope' }]
  ])('opens the corresponding connector view for the old discovery URL %s', async (path, search) => {
    const router = createMcpRouter(path)
    await router.load()
    render(<RouterProvider router={router} />)
    expect(await screen.findByRole('heading', { name: 'Connector content' })).toBeVisible()
    expect(router.state.location.pathname).toBe('/app/skills-connectors')
    expect(router.state.matches.at(-1)?.search).toMatchObject(search)
  })
})
