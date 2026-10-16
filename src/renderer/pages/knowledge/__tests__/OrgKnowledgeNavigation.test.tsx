import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { beforeEach, expect, it, vi } from 'vitest'

import KnowledgePage from '../KnowledgePage'
import { KnowledgePageProvider, useKnowledgePage } from '../KnowledgePageProvider'
import KnowledgePageNavigatorSection from '../sections/KnowledgePageNavigatorSection'

vi.unmock('@cherrystudio/ui')
vi.mock('../components/KnowledgeSharingPanel', () => ({
  default: ({ baseId }: { baseId: string }) => <div data-testid="members">{baseId}</div>
}))
const { catalog } = vi.hoisted(() => ({
  catalog: {
    public: [{ id: 'orgkb:public', name: '公共资料', description: '', documentCount: 1 }],
    shared: [],
    owned: [{ id: 'orgkb:owned', name: '我的服务端副本', description: '', documentCount: 1 }]
  }
}))
vi.mock('@renderer/hooks/useOrgKnowledge', () => ({
  useOrgKnowledge: () => ({ catalog, loading: false, error: null, refresh: vi.fn() })
}))
vi.mock('@renderer/hooks/useKnowledgeBase', () => ({
  useKnowledgeBases: () => ({ bases: [], isLoading: false }),
  useCreateKnowledgeBase: () => ({}),
  useRestoreKnowledgeBase: () => ({}),
  useUpdateKnowledgeBase: () => ({}),
  useDeleteKnowledgeBase: () => ({})
}))
vi.mock('../hooks/useKnowledgeGroups', () => ({
  useKnowledgeGroups: () => ({ groups: [] }),
  useCreateKnowledgeGroup: () => ({}),
  useUpdateKnowledgeGroup: () => ({}),
  useDeleteKnowledgeGroup: () => ({})
}))
beforeEach(async () => {
  await i18n.changeLanguage('en-us')
})

function Selection() {
  const { selectedOrgBase, category } = useKnowledgePage()
  return <output>{`${category}:${selectedOrgBase?.id ?? ''}`}</output>
}

it('owned 副本仅在本地管理区出现，切换类别和本地选择不会残留副本详情', async () => {
  const user = userEvent.setup()
  render(
    <KnowledgePageProvider onBaseIdChange={vi.fn()}>
      <KnowledgePageNavigatorSection />
      <Selection />
    </KnowledgePageProvider>
  )
  expect(screen.queryByRole('region', { name: 'Knowledge bases I shared' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '我的服务端副本' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Shared with me' }))
  expect(screen.queryByRole('button', { name: '我的服务端副本' })).not.toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('shared:')
  await user.click(screen.getByRole('button', { name: 'Local' }))
  expect(screen.getByRole('status')).toHaveTextContent('local:')
})

it('本地库为空时不展示独立副本管理入口', () => {
  render(<KnowledgePage onBaseIdChange={vi.fn()} />)
  expect(screen.queryByRole('button', { name: '我的服务端副本' })).not.toBeInTheDocument()
  expect(screen.queryByTestId('members')).not.toBeInTheDocument()
})

it('本地为空时仍可切换公共与分享类别，组织空态不出现创建操作', async () => {
  const user = userEvent.setup()
  render(
    <KnowledgePageProvider onBaseIdChange={vi.fn()}>
      <KnowledgePageNavigatorSection />
    </KnowledgePageProvider>
  )
  await user.click(screen.getByRole('button', { name: 'Public' }))
  expect(screen.getByRole('button', { name: '公共资料' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '公共资料' }))
  expect(screen.getByRole('button', { name: '公共资料' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.queryByRole('button', { name: /Create|Add/ })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Shared with me' }))
  expect(screen.getByText('No knowledge bases in this category')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Add with share code' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Pending invitations/ })).toBeInTheDocument()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})
