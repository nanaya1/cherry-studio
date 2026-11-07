import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

const useInfiniteQueryMock = vi.hoisted(() => vi.fn())

vi.mock('@cherrystudio/ui', async () => ({
  ...(await import('../../../../packages/ui/src/components/primitives/button'))
}))
vi.mock('@data/hooks/useDataApi', () => ({
  useInfiniteQuery: useInfiniteQueryMock
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

import IndustrialVideoKnowledgePicker from './IndustrialVideoKnowledgePicker'

afterEach(() => {
  cleanup()
  useInfiniteQueryMock.mockReset()
})

it('没有本地知识库时显示空状态且不重复渲染标题', () => {
  useInfiniteQueryMock.mockReturnValue({
    pages: [],
    error: undefined,
    isLoading: false,
    hasNext: false,
    loadNext: vi.fn()
  })

  render(<IndustrialVideoKnowledgePicker disabled={false} onSelect={vi.fn()} />)

  expect(screen.getByText('industrial_video.no_knowledge_bases')).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'industrial_video.local_knowledge' })).not.toBeInTheDocument()
})

it('以主从双栏选择知识库和文件', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  useInfiniteQueryMock.mockImplementation((path: string) => {
    if (path === '/knowledge-bases') {
      return {
        pages: [{ items: [{ id: 'base-1', name: '产品资料库' }] }],
        error: undefined,
        isLoading: false,
        hasNext: false,
        loadNext: vi.fn()
      }
    }
    return {
      pages: [{ items: [{ id: 'file-1', type: 'file', data: { source: '/资料/产品手册.pdf' } }] }],
      error: undefined,
      isLoading: false,
      hasNext: false,
      loadNext: vi.fn()
    }
  })

  render(<IndustrialVideoKnowledgePicker disabled={false} onSelect={onSelect} />)

  expect(screen.getByText('chat.save.knowledge.select.base.placeholder')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '产品资料库' }))
  expect(screen.getByRole('button', { name: '产品资料库' })).toHaveAttribute('aria-pressed', 'true')
  await user.click(screen.getByRole('button', { name: '产品手册.pdf' }))
  expect(onSelect).toHaveBeenCalledWith('file-1', '产品手册.pdf')
})

it('显示文件夹名并支持进入文件夹和返回上级', async () => {
  const user = userEvent.setup()
  const onSelect = vi.fn()
  useInfiniteQueryMock.mockImplementation((path: string, options?: { query?: { groupId?: string | null } }) => {
    if (path === '/knowledge-bases') {
      return {
        pages: [{ items: [{ id: 'base-1', name: '产品资料库' }] }],
        error: undefined,
        isLoading: false,
        hasNext: false,
        loadNext: vi.fn()
      }
    }
    const items = options?.query?.groupId
      ? [{ id: 'file-1', type: 'file', data: { source: '/资料/产品素材/说明书.pdf' } }]
      : [{ id: 'directory-1', type: 'directory', data: { source: '/资料/产品素材' } }]
    return { pages: [{ items }], error: undefined, isLoading: false, hasNext: false, loadNext: vi.fn() }
  })

  render(<IndustrialVideoKnowledgePicker disabled={false} onSelect={onSelect} />)
  await user.click(screen.getByRole('button', { name: '产品资料库' }))

  expect(screen.getByRole('button', { name: '产品素材' })).toBeInTheDocument()
  expect(screen.queryByText('/资料/产品素材')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '产品素材' }))
  expect(screen.getByRole('button', { name: /knowledge.data_source.back_to_parent/ })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: '说明书.pdf' }))
  expect(onSelect).toHaveBeenCalledWith('file-1', '说明书.pdf')
})
