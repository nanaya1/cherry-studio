import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useKnowledgeInspection } from '../../hooks/useKnowledgeInspection'
import KnowledgeInspectionDetail from '../KnowledgeInspectionDetail'
import KnowledgeInspectionNavigator from '../KnowledgeInspectionNavigator'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request } }))
vi.mock('@renderer/components/FilePreview/plugins/pdf/PdfFilePreview', () => ({
  default: ({ fileName }: { fileName: string }) => <div>PDF: {fileName}</div>
}))
vi.unmock('@cherrystudio/ui')

const base = {
  id: 'orgkb:base',
  name: '共享知识库',
  ownerName: '创建者',
  ownerId: 41,
  description: null,
  updateTime: null,
  qaAuthorized: false
}
const file = { id: 'orgkb:file', name: '说明.txt', directory: false, parseStatus: 'ready', updateTime: null }
const relation = {
  id: 'orgkb:share',
  sharerId: 42,
  sharerName: '真实分享人',
  recipientId: 43,
  recipientName: '真实领取人',
  status: 'exhausted',
  receiptCount: 0,
  maxViews: 1,
  viewCount: 1,
  createTime: null,
  updateTime: null,
  expiresAt: null
}
const page = (items: unknown[], total = items.length) => ({ items, total, page: 1, pageSize: 20 })

beforeEach(async () => {
  await i18n.changeLanguage('en-us')
  request.mockReset()
  request.mockImplementation(async (route, input) => {
    if (route.endsWith('.detail')) return base
    if (route.endsWith('.spaces')) return page([base], 21)
    if (route.endsWith('.files'))
      return page([
        file,
        { ...file, id: 'pending', name: '处理中.txt', parseStatus: 'parsing' },
        { ...file, id: 'folder', name: '资料目录', directory: true, parseStatus: null }
      ])
    if (route.endsWith('.content')) return { content: '<script>解析正文</script>', totalChars: 30, truncated: true }
    if (route.endsWith('.chunks')) return page([{ id: 'chunk', content: '分块内容', chunkIndex: input.page - 1 }], 21)
    if (route.endsWith('.invitations')) return page([{ ...relation, status: 'active' }])
    if (route.endsWith('.links')) return page([relation])
    if (route.endsWith('.receipts')) return page([])
    throw new Error('Unexpected route ' + route)
  })
})

describe('企业全部管理查看页面', () => {
  it('点击共享分页的页码后显示该页文件', async () => {
    const user = userEvent.setup()
    request.mockImplementation(async (route, input) => {
      if (route.endsWith('.detail')) return base
      if (route.endsWith('.files'))
        return { ...page([{ ...file, name: `第 ${input.page} 页.txt` }], 41), page: input.page }
      throw new Error('Unexpected route ' + route)
    })
    render(<KnowledgeInspectionDetail base={base} />)
    await user.click(await screen.findByRole('button', { name: '3' }))
    expect(await screen.findByText('第 3 页.txt')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '3' })).toHaveAttribute('aria-current', 'page')
  })
  it('有原件的文件打开转换预览，并可切换解析正文', async () => {
    const user = userEvent.setup()
    request.mockImplementation(async (route) => {
      if (route.endsWith('.detail')) return base
      if (route.endsWith('.files')) return page([{ ...file, hasOriginalFile: true }])
      if (route.endsWith('.preview'))
        return { fileName: file.name, minioPreviewUrl: 'https://storage.test/preview.pdf' }
      if (route.endsWith('.content')) return { content: '解析正文', totalChars: 4, truncated: false }
      throw new Error('Unexpected route ' + route)
    })
    render(<KnowledgeInspectionDetail base={base} />)
    await user.click(await screen.findByRole('row', { name: 'Open 说明.txt' }))
    expect(await screen.findByText('PDF: 说明.txt')).toBeInTheDocument()
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sharing relationships' })).not.toBeInTheDocument()
    expect(request).toHaveBeenCalledWith('enterprise.knowledge.inspection.preview', {
      baseId: base.id,
      fileId: file.id
    })
    await user.click(screen.getByRole('button', { name: 'Parsed content' }))
    expect(await screen.findByText('解析正文')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('row', { name: 'Open 说明.txt' })).toBeVisible()
  })
  it('只提供就绪文档的正文和分块读取，内容按纯文本展示', async () => {
    const user = userEvent.setup()
    render(<KnowledgeInspectionDetail base={base} />)
    await screen.findByText('说明.txt')
    expect(screen.queryByText(/Q&A: (?:Not authorized|Authorized)/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Management viewing grants read access/)).not.toBeInTheDocument()
    act(() => screen.getByText('Management view · Read only').focus())
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/Management viewing grants read access/)
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    const folder = screen.getByRole('row', { name: 'Open 资料目录' })
    expect(within(folder).getAllByRole('gridcell')[2]).toHaveTextContent(/^—$/)
    expect(screen.getByText('处理中.txt').closest('[role="row"]')).not.toHaveAttribute('tabindex')
    await user.click(screen.getByRole('row', { name: 'Open 说明.txt' }))
    expect(await screen.findByText('<script>解析正文</script>')).toBeInTheDocument()
    expect(screen.getByText(/Text is truncated/)).toBeInTheDocument()
    expect(document.querySelector('script')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Chunks' }))
    await screen.findByText('分块内容')
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('enterprise.knowledge.inspection.chunks', {
        baseId: base.id,
        fileId: file.id,
        page: 2
      })
    )
    expect(request.mock.calls.every(([route]) => route.startsWith('enterprise.knowledge.inspection.'))).toBe(true)
    expect(screen.queryByRole('button', { name: /Upload|Delete|Download|Share code/i })).not.toBeInTheDocument()
  })
  it('链接无人领取可展开空状态，邀请显示实际分享人与领取人', async () => {
    const user = userEvent.setup()
    render(<KnowledgeInspectionDetail base={base} />)
    await screen.findByText('说明.txt')
    await user.click(screen.getByRole('button', { name: 'Sharing relationships' }))
    await screen.findByText('真实领取人')
    expect(screen.getAllByText('真实分享人')).toHaveLength(2)
    expect(screen.getByText('Usage limit reached')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Recipients (0)' }))
    await screen.findByText('No recipients yet.')
    expect(request).toHaveBeenCalledWith('enterprise.knowledge.inspection.receipts', {
      baseId: base.id,
      shareId: relation.id,
      page: 1
    })
  })
  it('身份或选中空间变化后丢弃迟到正文响应', async () => {
    const user = userEvent.setup()
    let resolve!: (value: unknown) => void
    request.mockImplementation(async (route) => {
      if (route.endsWith('.detail')) return base
      if (route.endsWith('.files')) return page([file])
      if (route.endsWith('.content'))
        return new Promise((done) => {
          resolve = done
        })
      return page([])
    })
    const view = render(<KnowledgeInspectionDetail key="old" base={base} />)
    await user.click(await screen.findByRole('row', { name: 'Open 说明.txt' }))
    view.rerender(<KnowledgeInspectionDetail key="new" base={{ ...base, id: 'orgkb:new' }} />)
    await act(async () => resolve({ content: '旧身份机密', totalChars: 5, truncated: false }))
    expect(screen.queryByText('旧身份机密')).not.toBeInTheDocument()
  })
  it('管理列表支持搜索分页，失败显示错误而不是空结果', async () => {
    const user = userEvent.setup()
    const select = vi.fn()
    render(<KnowledgeInspectionNavigator selected={null} onSelect={select} />)
    await user.click(await screen.findByRole('button', { name: /共享知识库/ }))
    expect(select).toHaveBeenLastCalledWith(base)
    await user.click(screen.getByRole('button', { name: 'Next' }))
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('enterprise.knowledge.inspection.spaces', { page: 2, keyword: '' })
    )
    request.mockRejectedValueOnce(new Error('读取失败'))
    await user.type(screen.getByRole('searchbox', { name: 'Search knowledge bases' }), '  客户  ')
    await user.click(screen.getByRole('button', { name: /^Search$/ }))
    await screen.findByRole('alert')
    expect(screen.getByText('读取失败')).toBeInTheDocument()
    expect(screen.queryByText('No knowledge bases in this category')).not.toBeInTheDocument()
  })
})

it('身份、权限和分类变化均清除企业范围及选中项', () => {
  const { result, rerender } = renderHook(
    ({ authorized, session, category }) => useKnowledgeInspection(authorized, session, category),
    { initialProps: { authorized: true, session: 1, category: 'shared' } }
  )
  act(() => {
    result.current.setScope('all')
    result.current.select(base)
  })
  expect(result.current.active).toBe(true)
  rerender({ authorized: true, session: 2, category: 'shared' })
  expect(result.current).toMatchObject({ scope: 'mine', selected: null, active: false })
  act(() => result.current.setScope('all'))
  rerender({ authorized: false, session: 2, category: 'shared' })
  expect(result.current).toMatchObject({ scope: 'mine', selected: null, active: false })
  rerender({ authorized: true, session: 3, category: 'public' })
  expect(result.current.active).toBe(false)
})
