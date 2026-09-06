// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

import McpMarketList from '../McpMarketList'

describe('McpMarketList', () => {
  it('expands the catalog search on demand and filters market cards', async () => {
    const user = userEvent.setup()
    render(<McpMarketList variant="catalog" toolbarStart={<div>Discover tabs</div>} />)

    const collapsedSearch = screen.getByRole('button', { name: 'settings.mcp.search.tooltip' })
    expect(collapsedSearch).toBeVisible()
    await user.click(collapsedSearch)

    const search = screen.getByRole('searchbox', { name: 'settings.mcp.search.tooltip' })
    expect(search).toHaveAttribute('tabindex', '0')
    expect(screen.getByText('MCP World')).toBeVisible()
    expect(screen.getByText('Model Context Protocol Servers')).toBeVisible()

    await user.type(search, 'world')

    expect(screen.getByText('MCP World')).toBeVisible()
    expect(screen.queryByText('Model Context Protocol Servers')).not.toBeInTheDocument()
  })
})
