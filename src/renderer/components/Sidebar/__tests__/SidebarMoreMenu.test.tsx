// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Languages, Paintbrush, Shapes } from 'lucide-react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SidebarMoreMenu } from '../SidebarMoreMenu'
import type { ResolvedSidebarEntry, SidebarActiveState } from '../types'

vi.mock('@cherrystudio/ui', () => {
  const React = require('react') as typeof ReactType

  return {
    MenuItem: ({
      icon,
      label,
      onClick,
      active
    }: {
      icon?: ReactNode
      label: string
      onClick?: () => void
      active?: boolean
    }) => (
      <button type="button" data-active={active ? 'true' : 'false'} onClick={onClick}>
        {icon}
        <span>{label}</span>
      </button>
    ),
    Popover: ({ children, open }: { children: ReactNode; open: boolean }) => (
      <div data-testid="popover-root" data-open={open ? 'true' : 'false'}>
        {children}
      </div>
    ),
    PopoverTrigger: ({ children }: { children: ReactElement }) =>
      React.cloneElement(children as ReactElement<{ 'data-testid'?: string }>, {
        'data-testid': 'more-trigger'
      }),
    PopoverContent: ({ children }: { children: ReactNode }) => <div data-testid="popover-content">{children}</div>
  }
})

vi.mock('../Tooltip', () => ({
  SidebarTooltip: ({ children }: { children: ReactNode }) => children
}))

import type ReactType from 'react'
import type { ReactElement, ReactNode } from 'react'

const activeState: SidebarActiveState = { activeItem: '' }

const entry = (id: string, overrides: Partial<ResolvedSidebarEntry> = {}): ResolvedSidebarEntry => ({
  key: id,
  label: id,
  renderIcon: (size) => <Shapes size={size} />,
  isActive: () => false,
  onOpen: vi.fn(),
  ...overrides
})

const entries: ResolvedSidebarEntry[] = [
  entry('workspace:resources', { label: 'Resource Center' }),
  entry('app:translate', {
    label: 'Translate',
    renderIcon: (size) => <Languages size={size} />,
    isActive: (active) => active.activeItem === 'translate'
  }),
  entry('app:paintings', {
    label: 'Paintings',
    renderIcon: (size) => <Paintbrush size={size} />
  }),
  entry('app:knowledge', { label: 'Knowledge' })
]

afterEach(() => {
  vi.clearAllMocks()
})

describe('SidebarMoreMenu', () => {
  it('renders a labeled full-layout trigger that opens a panel listing every entry', async () => {
    const user = userEvent.setup()

    render(<SidebarMoreMenu label="More" entries={entries} active={activeState} layout="full" />)

    const trigger = screen.getByRole('button', { name: 'More' })
    expect(trigger).toHaveTextContent('More')

    await user.click(trigger)

    const panel = screen.getByTestId('popover-content')
    expect(panel).toBeInTheDocument()
    expect(withinPanel(panel)).toEqual(['Resource Center', 'Translate', 'Paintings', 'Knowledge'])
  })

  it('renders an icon-only tooltip-wrapped trigger in icon layout', () => {
    render(<SidebarMoreMenu label="More" entries={entries} active={activeState} layout="icon" />)

    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument()
    expect(screen.queryByText('More')).not.toBeInTheDocument()
  })

  it('marks the trigger active and highlights the active row', () => {
    render(<SidebarMoreMenu label="More" entries={entries} active={{ activeItem: 'translate' }} layout="full" />)

    const translateRow = screen.getAllByRole('button', { name: 'Translate' })[0]
    expect(translateRow).toHaveAttribute('data-active', 'true')
    expect(screen.getAllByRole('button', { name: 'More' })[0]).toHaveAttribute('data-active', 'true')
  })

  it('closes the panel and opens the entry when a row is clicked', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()

    render(
      <SidebarMoreMenu label="More" entries={entries} active={activeState} layout="full" onOpenChange={onOpenChange} />
    )

    await user.click(screen.getByRole('button', { name: 'More' }))
    const paintRow = screen.getAllByRole('button', { name: 'Paintings' })[0]
    await user.click(paintRow)

    expect(entries[2].onOpen).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenLastCalledWith(false)
      expect(screen.getByTestId('popover-root')).toHaveAttribute('data-open', 'false')
    })
  })
})

function withinPanel(panel: HTMLElement) {
  return Array.from(panel.querySelectorAll('button span'))
    .map((span) => span.textContent)
    .filter((text): text is string => Boolean(text))
}
