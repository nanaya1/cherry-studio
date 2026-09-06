import { render, screen, waitFor } from '@testing-library/react'
import React, { useEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { QuickPanelProvider } from '../QuickPanelProvider'
import { QuickPanelView } from '../QuickPanelView'
import type { QuickPanelListItem } from '../types'
import { useQuickPanel } from '../useQuickPanel'

vi.mock('i18next', () => ({
  t: (key: string, fallback?: string) => fallback ?? key
}))

vi.mock('@renderer/utils/style', () => ({
  classNames: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' ')
}))

vi.mock('@renderer/components/VirtualList', () => ({
  DynamicVirtualList: ({ children, list }: any) => (
    <div data-testid="quick-panel-virtual-list">
      {list.map((item: QuickPanelListItem, index: number) => (
        <React.Fragment key={item.id ?? index}>{children(item, index)}</React.Fragment>
      ))}
    </div>
  )
}))

const items: QuickPanelListItem[] = [{ id: 'a', label: 'Slash Action', icon: 'a' }]

/**
 * Reproduces the `deferQuickPanel` mount order:
 *   1. provider is up
 *   2. imperative `quickPanel.open(...)` fires (root suggestion onActiveChange
 *      hits QuickPanelProvider.open synchronously before the view is mounted)
 *   3. THEN <QuickPanelView> mounts (after `editorReady` flips)
 *
 * The view must pick up the open() result on its first render.
 */
function PreOpenHarness({ showView }: { showView: boolean }) {
  const { open } = useQuickPanel()

  useEffect(() => {
    open({ list: items, symbol: '/', title: 'Actions' })
  }, [open])

  return showView ? <QuickPanelView /> : null
}

function withProvider(node: React.ReactElement) {
  return <QuickPanelProvider>{node}</QuickPanelProvider>
}

describe('QuickPanelView deferred mount (deferQuickPanel path)', () => {
  it('shows the panel when QuickPanelView mounts after a pre-mount imperative open', async () => {
    const { rerender } = render(withProvider(<PreOpenHarness showView={false} />))
    rerender(withProvider(<PreOpenHarness showView={true} />))

    await waitFor(() => expect(screen.getByTestId('quick-panel')).toHaveClass('visible'))
    expect(screen.getByText('Slash Action')).toBeInTheDocument()
  })

  it('keeps the panel mounted with inert=false and overflow-visible after late mount', async () => {
    const { rerender } = render(withProvider(<PreOpenHarness showView={false} />))
    rerender(withProvider(<PreOpenHarness showView={true} />))

    const panel = await screen.findByTestId('quick-panel')
    expect(panel).not.toHaveAttribute('inert')
    expect(panel).toHaveClass('overflow-visible')
    expect(panel).toHaveClass('pointer-events-auto')
  })
})
