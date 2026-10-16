import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'

import KnowledgePageDetailSection from '../../sections/KnowledgePageDetailSection'

vi.unmock('@cherrystudio/ui')
const { context } = vi.hoisted(() => ({
  context: {
    org: { catalog: { owned: [{ id: 'orgkb:copy', localBaseId: 'local-1' }] }, refresh: vi.fn() },
    orgSession: 1,
    selectedBase: { id: 'local-1', name: 'Local one' },
    selectedBaseId: 'local-1',
    baseNavigationVersion: 1
  }
}))
vi.mock('../../KnowledgePageProvider', () => ({ useKnowledgePage: () => context }))
vi.mock('../../hooks/useKnowledgeSyncStatus', () => ({ useKnowledgeSyncStatus: () => ({ refresh: vi.fn() }) }))
vi.mock('@renderer/hooks/useKnowledgeItems', () => ({
  useKnowledgeItems: () => ({ items: [] }),
  useDeleteKnowledgeItem: () => ({}),
  useReindexKnowledgeItem: () => ({})
}))
vi.mock('../DetailHeader', () => ({ default: () => null }))
vi.mock('../../panels/dataSource/DataSourcePanel', () => ({ default: () => null }))
vi.mock('../KnowledgeSharingPanel', () => ({
  default: ({ baseId }: { baseId: string }) => <p data-testid="records">{baseId}</p>
}))

it('从本地详情打开对应副本记录，切换知识库后关闭且未关联库不能打开', async () => {
  const user = userEvent.setup()
  const view = render(<KnowledgePageDetailSection />)
  expect(screen.queryByTestId('records')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: /Share records|Sharing records|分享记录|knowledge.org.shares/i }))
  expect(screen.getByTestId('records')).toHaveTextContent('orgkb:copy')
  context.selectedBaseId = 'local-2'
  context.selectedBase = { id: 'local-2', name: 'Local two' }
  view.rerender(<KnowledgePageDetailSection />)
  expect(screen.queryByTestId('records')).not.toBeInTheDocument()
  expect(
    screen.getByRole('button', { name: /Share records|Sharing records|分享记录|knowledge.org.shares/i })
  ).toBeDisabled()
})
