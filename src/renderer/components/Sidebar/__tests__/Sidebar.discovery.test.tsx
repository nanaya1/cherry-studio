import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Sidebar } from '../Sidebar'

vi.unmock('@cherrystudio/ui')

describe('Sidebar application discovery', () => {
  it('keeps an empty favorites list without adding a second launcher', () => {
    render(<Sidebar width={200} setWidth={vi.fn()} entries={[]} active={{ activeItem: '' }} />)

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
