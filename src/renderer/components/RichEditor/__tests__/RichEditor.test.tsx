import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/hooks/useCodeStyle', () => ({
  useCodeStyle: () => ({ activeShikiTheme: 'one-light' })
}))

import RichEditor from '../RichEditor'

describe('RichEditor toolbar', () => {
  it('prevents list buttons from taking focus before the command runs', () => {
    render(<RichEditor initialContent="first" autoFocus={false} />)

    const bulletButton = screen.getByTestId('toolbar-bulletList')
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    bulletButton.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
  })
})

describe('RichEditor accessibility', () => {
  // Asserted on the attribute rather than through `getByRole('textbox', { name })`: ProseMirror
  // leaves the contenteditable without an explicit `role`, and giving every editor in the app one
  // changes how assistive tech navigates rich content — a separate decision from naming this one.
  it('names the editing surface for callers with no visible label', () => {
    const { container } = render(<RichEditor initialContent="" autoFocus={false} ariaLabel="Content" />)

    expect(container.querySelector('[contenteditable="true"]')).toHaveAttribute('aria-label', 'Content')
  })

  it('leaves the editing surface unnamed when no label is supplied', () => {
    const { container } = render(<RichEditor initialContent="" autoFocus={false} />)

    expect(container.querySelector('[contenteditable="true"]')).not.toHaveAttribute('aria-label')
  })
})
