import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type * as CherryStudioUi from '@cherrystudio/ui'

vi.mock('@cherrystudio/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof CherryStudioUi>()
  return actual
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

import { AssistantPresetPreviewDialog } from '../AssistantPresetPreviewDialog'

const preset = {
  description: 'Build a focused assistant',
  group: ['Featured'],
  name: 'Focused Assistant',
  prompt: 'Stay concise'
}

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  if (!HTMLElement.prototype.hasPointerCapture) {
    HTMLElement.prototype.hasPointerCapture = () => false
  }
  if (!HTMLElement.prototype.releasePointerCapture) {
    HTMLElement.prototype.releasePointerCapture = () => {}
  }
  if (!HTMLElement.prototype.setPointerCapture) {
    HTMLElement.prototype.setPointerCapture = () => {}
  }
})

afterEach(cleanup)

describe('AssistantPresetPreviewDialog overlay close', () => {
  it('closes when clicking the overlay while idle', () => {
    const onOpenChange = vi.fn()

    render(
      <AssistantPresetPreviewDialog
        preset={preset}
        open
        onOpenChange={onOpenChange}
        onAdd={vi.fn()}
        onOpenChat={vi.fn()}
      />
    )

    const overlay = document.querySelector('[data-slot="dialog-overlay"]')
    expect(overlay).toBeInTheDocument()

    fireEvent.click(overlay!)

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('keeps the dialog open when clicking the overlay while adding', () => {
    const onOpenChange = vi.fn()

    render(
      <AssistantPresetPreviewDialog
        preset={preset}
        open
        adding
        onOpenChange={onOpenChange}
        onAdd={vi.fn()}
        onOpenChat={vi.fn()}
      />
    )

    const overlay = document.querySelector('[data-slot="dialog-overlay"]')
    expect(overlay).toBeInTheDocument()

    fireEvent.click(overlay!)

    expect(onOpenChange).not.toHaveBeenCalled()
  })
})

// Phase-1 (MEA resource-icons): the preset header must use the Bot fallback, not the emoji glyph.
describe('MEA resource-icons: hide preset emoji in preview header', () => {
  it('renders the Bot icon, not the emoji glyph, in the preview header', () => {
    render(
      <AssistantPresetPreviewDialog preset={preset} open onOpenChange={vi.fn()} onAdd={vi.fn()} onOpenChat={vi.fn()} />
    )

    // Regression: the emoji fallback (🤖) must not be rendered when no preset emoji is set.
    expect(screen.queryByText('🤖')).not.toBeInTheDocument()
  })
})
