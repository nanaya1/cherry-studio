import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import OrgKnowledgeDetail from '../OrgKnowledgeDetail'

const { request, wordPreview, spreadsheetPreview, powerPointPreview } = vi.hoisted(() => ({
  request: vi.fn(),
  wordPreview: vi.fn(() => null),
  spreadsheetPreview: vi.fn(() => null),
  powerPointPreview: vi.fn(() => null)
}))
// 入口验证公开的内存输入契约；解码与渲染由各真实组件的 base64 测试覆盖。
vi.mock('@renderer/components/FilePreview/plugins/word/WordFilePreview', () => ({ default: wordPreview }))
vi.mock('@renderer/components/FilePreview/plugins/spreadsheet/SpreadsheetFilePreview', () => ({
  default: spreadsheetPreview
}))
vi.mock('@renderer/components/FilePreview/plugins/powerpoint/PowerPointFilePreview', () => ({
  default: powerPointPreview
}))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request } }))
vi.unmock('@cherrystudio/ui')
// jsdom 无布局测量；保留真实文件行与交互，仅绕过虚拟滚动。
vi.mock('@renderer/components/VirtualList', () => ({
  DynamicVirtualList: ({ list, children }: { list: unknown[]; children: (item: unknown) => ReactNode }) => (
    <div role="rowgroup">
      {list.map((entry, index) => (
        <div key={index}>{children(entry)}</div>
      ))}
    </div>
  )
}))
vi.mock('@renderer/components/FilePreview/plugins/pdf/PdfFilePreview', () => ({
  default: ({ fileName, base64 }: { fileName: string; base64: string }) => (
    <div title={fileName} data-pdf-base64={base64} />
  )
}))

const base = { id: 'orgkb:base', name: '企业资料', description: '服务端说明', documentCount: 2 }
const item = {
  id: 'orgkb:item',
  baseId: base.id,
  type: 'file',
  title: '说明.pdf',
  status: 'ready',
  parentId: null,
  documentId: 'orgkb:document',
  fileId: 'orgkb:file',
  hasOriginalFile: true,
  createdAt: '',
  updatedAt: ''
}

const officeFormats = [
  {
    extension: 'docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    preview: wordPreview
  },
  {
    extension: 'xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    preview: spreadsheetPreview
  },
  {
    extension: 'pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    preview: powerPointPreview
  }
]

beforeEach(async () => {
  wordPreview.mockClear()
  spreadsheetPreview.mockClear()
  powerPointPreview.mockClear()
  await i18n.changeLanguage('en-us')
  request.mockReset()
  request.mockImplementation(async (route, input) => {
    if (route === 'enterprise.knowledge.items')
      return input.cursor
        ? { items: [{ ...item, id: 'orgkb:item2', title: '第二页' }], total: 2, nextCursor: null }
        : { items: [item], total: 2, nextCursor: 'page2' }
    if (route === 'enterprise.knowledge.read')
      return { title: item.title, content: '解析正文', documentId: item.documentId, totalChars: 4, truncated: false }
    if (route === 'enterprise.knowledge.preview')
      return { kind: 'inline', fileName: item.title, mimeType: 'application/pdf', content: '', base64: 'JVBERi0=' }
    if (route === 'enterprise.knowledge.chunks')
      return { chunks: [{ id: 'chunk', content: '分块内容', chunkIndex: 0 }], total: 1, nextCursor: null }
    return { chunks: [] }
  })
})

it('公共文件失败状态悬浮显示服务端错误原文', async () => {
  const message = '解析失败：文件内容无法识别 <script>text</script>'
  request.mockResolvedValue({ items: [{ ...item, status: 'failed', error: message }], total: 1, nextCursor: null })
  const user = userEvent.setup()
  render(<OrgKnowledgeDetail base={base} owned={false} publicLibrary />)
  await screen.findByText(item.title)
  await user.hover(await screen.findByText(i18n.t('knowledge.data_source.status.error')))
  expect(await screen.findByRole('tooltip')).toHaveTextContent(message)
  expect(document.querySelector('script')).toBeNull()
})

describe('云端删除交互', () => {
  it('本人云端文件确认后删除，刷新列表并保留本机资料', async () => {
    let deleted = false
    request.mockImplementation(async (route) => {
      if (route === 'enterprise.knowledge.delete_file') {
        deleted = true
        return { ok: true }
      }
      if (route === 'enterprise.knowledge.items')
        return { items: deleted ? [] : [item], total: deleted ? 0 : 1, nextCursor: null }
      return { chunks: [] }
    })
    const user = userEvent.setup()
    render(<OrgKnowledgeDetail base={base} owned />)
    await screen.findByText(item.title)
    await user.click(screen.getByRole('button', { name: i18n.t('common.more') }))
    await user.click(await screen.findByRole('menuitem', { name: i18n.t('knowledge.data_source.actions.delete') }))
    expect(request).not.toHaveBeenCalledWith('enterprise.knowledge.delete_file', expect.anything())
    expect(await screen.findByText(i18n.t('knowledge.org.delete_file_notice'))).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: i18n.t('common.delete') }))
    await waitFor(() => expect(screen.queryByText(item.title)).not.toBeInTheDocument())
    expect(request).toHaveBeenCalledWith('enterprise.knowledge.delete_file', { baseId: base.id, fileId: item.fileId })
    expect(request.mock.calls.some(([route]) => route === 'knowledge.delete_items')).toBe(false)
  })

  it('本人云端文件多选后逐个删除，刷新列表并保留本机资料', async () => {
    const secondItem = { ...item, id: 'orgkb:item2', title: '会议记录.pdf', fileId: 'orgkb:file2' }
    const deletedFileIds = new Set<string>()
    request.mockImplementation(async (route, input) => {
      if (route === 'enterprise.knowledge.delete_file') {
        deletedFileIds.add(input.fileId)
        return { ok: true }
      }
      if (route === 'enterprise.knowledge.items') {
        const items = [item, secondItem].filter((entry) => !deletedFileIds.has(entry.fileId))
        return { items, total: items.length, nextCursor: null }
      }
      return { chunks: [] }
    })
    const user = userEvent.setup()
    render(<OrgKnowledgeDetail base={base} owned />)
    await screen.findByText(item.title)
    await screen.findByText(secondItem.title)

    for (const checkbox of screen.getAllByRole('checkbox', {
      name: i18n.t('knowledge.data_source.table.select_row')
    })) {
      await user.click(checkbox)
    }
    await user.click(screen.getByRole('button', { name: i18n.t('knowledge.data_source.bulk.delete') }))
    expect(await screen.findByText(i18n.t('knowledge.org.delete_file_notice'))).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: i18n.t('common.delete') }))

    await waitFor(() => expect(screen.queryByText(item.title)).not.toBeInTheDocument())
    expect(screen.queryByText(secondItem.title)).not.toBeInTheDocument()
    expect(request).toHaveBeenCalledWith('enterprise.knowledge.delete_file', { baseId: base.id, fileId: item.fileId })
    expect(request).toHaveBeenCalledWith('enterprise.knowledge.delete_file', {
      baseId: base.id,
      fileId: secondItem.fileId
    })
    expect(request.mock.calls.some(([route]) => route === 'knowledge.delete_items')).toBe(false)
  })

  it('服务端删除失败时保留文件', async () => {
    request.mockImplementation(async (route) => {
      if (route === 'enterprise.knowledge.delete_file') throw new Error('permission denied')
      return { items: [item], total: 1, nextCursor: null }
    })
    const user = userEvent.setup()
    render(<OrgKnowledgeDetail base={base} owned />)
    await screen.findByText(item.title)
    await user.click(screen.getByRole('button', { name: i18n.t('common.more') }))
    await user.click(await screen.findByRole('menuitem', { name: i18n.t('knowledge.data_source.actions.delete') }))
    await user.click(await screen.findByRole('button', { name: i18n.t('common.delete') }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('enterprise.knowledge.delete_file', expect.anything()))
    expect(screen.getByText(item.title)).toBeInTheDocument()
    expect(request.mock.calls.filter(([route]) => route === 'enterprise.knowledge.items')).toHaveLength(1)
  })

  it('非本人云端库隐藏删除操作', async () => {
    const user = userEvent.setup()
    render(<OrgKnowledgeDetail base={base} owned={false} />)
    await screen.findByText(item.title)
    await user.click(screen.getByRole('button', { name: i18n.t('common.more') }))
    expect(
      screen.queryByRole('menuitem', { name: i18n.t('knowledge.data_source.actions.delete') })
    ).not.toBeInTheDocument()
  })
})

describe('公共库分页浏览', () => {
  it('页大小菜单即时开关、Escape恢复焦点，不请求或改变当前页', async () => {
    request.mockImplementation(async (_route, input) => ({
      items: [{ ...item, title: input.cursor ? '第二页' : '首页' }],
      total: 128,
      nextCursor: '3'
    }))
    HTMLElement.prototype.hasPointerCapture ??= () => false
    HTMLElement.prototype.releasePointerCapture ??= () => {}
    HTMLElement.prototype.setPointerCapture ??= () => {}
    HTMLElement.prototype.scrollIntoView ??= () => {}
    const user = userEvent.setup()
    render(<OrgKnowledgeDetail base={base} owned={false} publicLibrary />)
    await screen.findByText('首页')
    await user.click(screen.getByRole('button', { name: '2' }))
    await screen.findByText('第二页')
    const callsBeforeOpen = request.mock.calls.length
    const trigger = screen.getByRole('combobox', { name: 'Items per page' })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await user.click(trigger)
      const menu = await screen.findByRole('listbox')
      // 性能契约：此实例不播放进入/退出动画，也不等待转场完成才卸载。
      expect(menu).toHaveClass('data-[state=open]:animate-none!', 'data-[state=closed]:animate-none!')
      expect(menu).toHaveStyle({ transition: 'none' })
      expect(screen.getAllByRole('option')).toHaveLength(3)
      await user.keyboard('{Escape}')
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
      expect(trigger).toHaveFocus()
    }
    await user.keyboard('{ArrowDown}')
    await screen.findByRole('listbox')
    await user.keyboard('{Escape}')
    expect(trigger).toHaveFocus()
    expect(request).toHaveBeenCalledTimes(callsBeforeOpen)
    expect(screen.getByRole('button', { name: '2' })).toHaveAttribute('aria-current', 'page')
  })

  it('分页位于表格后独占整行靠右，并使用两条等高竖分隔线', async () => {
    render(<OrgKnowledgeDetail base={base} owned={false} publicLibrary />)
    await screen.findByText(item.title)
    const pagination = screen.getByRole('navigation', { name: i18n.t('knowledge.org.documents') })
    const grid = screen.getByRole('grid')
    // 布局回归契约：DOM顺序在表格之后，全宽右对齐，覆盖共享组件的mx-auto。
    expect(grid.compareDocumentPosition(pagination) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(pagination).toHaveClass('mx-0', 'w-full', 'justify-end')
    const separators = pagination.querySelectorAll('[aria-hidden="true"].h-4.w-px.shrink-0.self-center.bg-border')
    expect(separators).toHaveLength(2)
    expect([...separators].every((separator) => separator.className === separators[0].className)).toBe(true)
  })

  it('数字直接跳页并在20/50/100切换后回首页', async () => {
    request.mockImplementation(async (_route, input) => ({
      items: [{ ...item, title: `第${input.cursor ?? 1}页-${input.pageSize}条` }],
      total: 128,
      nextCursor: Number(input.cursor ?? 1) * input.pageSize < 128 ? String(Number(input.cursor ?? 1) + 1) : null
    }))
    // jsdom 缺少真实 Select 依赖的指针捕获与滚动API。
    HTMLElement.prototype.hasPointerCapture ??= () => false
    HTMLElement.prototype.releasePointerCapture ??= () => {}
    HTMLElement.prototype.setPointerCapture ??= () => {}
    HTMLElement.prototype.scrollIntoView ??= () => {}
    const user = userEvent.setup()
    render(<OrgKnowledgeDetail base={base} owned={false} publicLibrary />)
    await screen.findByText('第1页-20条')
    expect(screen.queryByRole('button', { name: '4' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '7' }))
    await screen.findByText('第7页-20条')
    expect(screen.getByRole('button', { name: '7' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled()
    for (const size of [50, 100, 20]) {
      const callsBeforeChange = request.mock.calls.length
      await user.click(screen.getByRole('combobox', { name: 'Items per page' }))
      await user.click(await screen.findByRole('option', { name: `${size} per page` }))
      await screen.findByText(`第1页-${size}条`)
      expect(request).toHaveBeenCalledTimes(callsBeforeChange + 1)
      expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
      expect(screen.getByRole('button', { name: '1' })).toHaveAttribute('aria-current', 'page')
      expect(request).toHaveBeenLastCalledWith('enterprise.knowledge.items', {
        baseId: base.id,
        cursor: null,
        parentId: null,
        publicLibrary: true,
        pageSize: size
      })
      await user.click(screen.getByRole('button', { name: '2' }))
      await screen.findByText(`第2页-${size}条`)
    }
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
  })

  it('旧目录迟到空响应不把新目录第二页回退到首页', async () => {
    const directory = {
      ...item,
      id: 'orgkb:dir',
      fileId: 'orgkb:dir-file',
      type: 'directory',
      title: '新目录',
      documentId: null
    }
    let resolve!: (value: unknown) => void
    request.mockImplementation(async (_route, input) => {
      if (!input.parentId && input.cursor)
        return new Promise((done) => {
          resolve = done
        })
      return {
        items: input.parentId ? [{ ...item, title: input.cursor ? '新目录第二页' : '新目录首页' }] : [directory],
        total: 40,
        nextCursor: input.cursor ? null : '2'
      }
    })
    const user = userEvent.setup()
    const { rerender } = render(<OrgKnowledgeDetail base={base} owned={false} publicLibrary />)
    await screen.findByText('新目录')
    await user.click(screen.getByRole('button', { name: '2' }))
    rerender(<OrgKnowledgeDetail base={{ ...base, id: 'orgkb:other' }} owned={false} publicLibrary />)
    await user.click(await screen.findByText('新目录'))
    await screen.findByText('新目录首页')
    await user.click(screen.getByRole('button', { name: '2' }))
    await screen.findByText('新目录第二页')
    await act(async () => resolve({ items: [], total: 0, nextCursor: null }))
    expect(screen.getByText('新目录第二页')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '2' })).toHaveAttribute('aria-current', 'page')
  })

  it('仅请求当前页，显示总数，支持前后切换及分类重置', async () => {
    request.mockImplementation(async (_route, input) => ({
      items: input.cursor ? [{ ...item, title: '第二页' }] : [item],
      total: 40,
      nextCursor: input.cursor ? null : '2'
    }))
    const user = userEvent.setup()
    const { rerender } = render(<OrgKnowledgeDetail base={base} owned={false} publicLibrary />)
    await screen.findByText(item.title)
    expect(screen.getByText(i18n.t('knowledge.org.pagination_total', { total: 40 }))).toBeInTheDocument()
    expect(request.mock.calls.filter(([route]) => route === 'enterprise.knowledge.items')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Next page' }))
    await screen.findByText('第二页')
    expect(screen.queryByText(item.title)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled()
    expect(screen.getByText('2', { exact: true })).toHaveAttribute('aria-current', 'page')
    expect(request).toHaveBeenLastCalledWith('enterprise.knowledge.items', {
      baseId: base.id,
      cursor: '2',
      parentId: null,
      publicLibrary: true,
      pageSize: 20
    })
    await user.click(screen.getByRole('button', { name: 'Previous' }))
    await screen.findByText(item.title)
    await user.click(screen.getByRole('button', { name: 'Next page' }))
    await screen.findByText('第二页')
    rerender(<OrgKnowledgeDetail base={base} owned={false} />)
    await screen.findByText(item.title)
    rerender(<OrgKnowledgeDetail base={base} owned={false} publicLibrary />)
    await screen.findByText(item.title)
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
  })

  it('公共目录不自动遍历，进出目录重置到第一页', async () => {
    const directory = {
      ...item,
      id: 'orgkb:folder',
      fileId: 'orgkb:folder-file',
      type: 'directory',
      title: '公共目录',
      documentId: null
    }
    request.mockImplementation(async (_route, input) => ({
      items: input.parentId
        ? [{ ...item, title: input.cursor ? '目录第二页' : '目录第一页' }]
        : input.cursor
          ? [directory]
          : [item],
      total: 101,
      nextCursor: input.cursor ? null : '2'
    }))
    const user = userEvent.setup()
    render(<OrgKnowledgeDetail base={base} owned={false} publicLibrary />)
    await screen.findByText(item.title)
    await user.click(screen.getByRole('button', { name: 'Next page' }))
    await user.click(await screen.findByText(directory.title))
    await screen.findByText('目录第一页')
    expect(request.mock.calls.filter(([, input]) => input.parentId && input.cursor)).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Next page' }))
    await screen.findByText('目录第二页')
    await user.click(screen.getByRole('button', { name: i18n.t('knowledge.data_source.back_to_parent') }))
    await screen.findByText(item.title)
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
  })

  it('数据减少导致请求页为空时回首页', async () => {
    request.mockImplementation(async (_route, input) => ({
      items: input.cursor ? [] : [item],
      total: input.cursor ? 1 : 40,
      nextCursor: input.cursor ? null : '2'
    }))
    const user = userEvent.setup()
    render(<OrgKnowledgeDetail base={base} owned={false} publicLibrary />)
    await screen.findByText(item.title)
    await user.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled())
    expect(await screen.findByText(item.title)).toBeInTheDocument()
  })
})

describe('组织知识库只读详情', () => {
  it('显示云端知识库更新时间', async () => {
    render(<OrgKnowledgeDetail base={{ ...base, updatedAt: '2026-10-17T00:00:00Z' }} owned={false} />)
    await screen.findByText(item.title)
    expect(screen.getByText(/^Updated /)).not.toHaveTextContent('—')
  })

  it('生产详情直接 A→B→A rerender 时重置预览与分页，旧预览晚返回不进入新库', async () => {
    let resolvePreview!: (value: unknown) => void
    const original = request.getMockImplementation()!
    request.mockImplementation((route, input) => {
      if (route === 'enterprise.knowledge.items')
        return Promise.resolve({
          items: [{ ...item, baseId: input.baseId, title: `${input.baseId}-${input.cursor ?? 'root'}.pdf` }],
          total: 2,
          nextCursor: input.cursor ? null : 'page2'
        })
      if (route === 'enterprise.knowledge.preview')
        return new Promise((resolve) => {
          resolvePreview = resolve
        })
      return original(route, input)
    })
    const user = userEvent.setup()
    const next = { ...base, id: 'orgkb:B', name: '乙库' }
    const { rerender } = render(<OrgKnowledgeDetail base={base} owned={false} />)
    await user.click(await screen.findByText(`${base.id}-root.pdf`))
    rerender(<OrgKnowledgeDetail base={next} owned={false} />)
    expect(screen.queryByLabelText(`${base.id}-root.pdf`)).not.toBeInTheDocument()
    expect(await screen.findByText(`${next.id}-root.pdf`)).toBeInTheDocument()
    await act(async () => resolvePreview({ kind: 'text', fileName: '旧文件', content: '甲库敏感正文' }))
    expect(screen.queryByText('甲库敏感正文')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next page' }))
    await screen.findByText(`${next.id}-page2.pdf`)
    rerender(<OrgKnowledgeDetail base={base} owned={false} />)
    expect(await screen.findByText(`${base.id}-root.pdf`)).toBeInTheDocument()
    expect(screen.queryByText(`${next.id}-page2.pdf`)).not.toBeInTheDocument()
  })

  it('准备新增资料晚返回时不打开已离开的库', async () => {
    let finish!: (value: unknown) => void
    const original = request.getMockImplementation()!
    request.mockImplementation((route, input) =>
      route === 'enterprise.knowledge.prepare_added_files'
        ? new Promise((resolve) => {
            finish = resolve
          })
        : original(route, input)
    )
    const { rerender } = render(<OrgKnowledgeDetail base={base} owned />)
    await screen.findByText(item.title)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: i18n.t('knowledge.data_source.toolbar.add') }))
    await user.click(screen.getByRole('menuitem', { name: i18n.t('knowledge.data_source.add_dialog.sources.file') }))
    rerender(<OrgKnowledgeDetail base={{ ...base, id: 'orgkb:B', name: '乙库' }} owned />)
    await act(async () => finish({ localBaseId: 'old-staging' }))
    expect(screen.getByText('乙库')).toBeInTheDocument()
    expect(request.mock.calls.some(([route]) => route === 'knowledge.add_items')).toBe(false)
  })

  /* 原文件选择由共用资料弹窗接管，异步准备隔离由上方用例覆盖。
  it('文件选择晚返回时不向已离开的库追加资料', async () => {
    let finish!: (value: Awaited<ReturnType<typeof window.api.file.select>>) => void
    const previous = window.api.file.select
    window.api.file.select = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<typeof window.api.file.select>>>((resolve) => {
          finish = resolve
        })
    )
    const { rerender } = render(<OrgKnowledgeDetail base={base} owned />)
    await screen.findByText(item.title)
    await userEvent.click(screen.getByRole('button', { name: i18n.t('common.add') }))
    const next = { ...base, id: 'orgkb:B', name: '乙库' }
    rerender(<OrgKnowledgeDetail base={next} owned />)
    await act(async () =>
      finish([{ name: '甲库追加.txt', path: '/tmp/old.txt' }] as Awaited<ReturnType<typeof window.api.file.select>>)
    )
    expect(request.mock.calls.some(([route]) => route === 'enterprise.knowledge.prepare_added_files')).toBe(false)
    expect(screen.getByText('乙库')).toBeInTheDocument()
    window.api.file.select = previous
  })

  */
  it('目录与成员页不随 base prop 进入新库', async () => {
    const directory = { ...item, id: 'orgkb:dir', type: 'directory', title: '甲库目录', documentId: null }
    request.mockImplementation(async (route, input) => {
      if (route === 'enterprise.knowledge.items')
        return {
          items: input.baseId === base.id ? [directory] : [{ ...item, baseId: input.baseId, title: '乙库根文件' }],
          total: 1,
          nextCursor: null
        }
      return { shares: [], members: [] }
    })
    const next = { ...base, id: 'orgkb:B', name: '乙库' }
    const { rerender } = render(<OrgKnowledgeDetail base={base} owned />)
    await userEvent.click(await screen.findByText(directory.title))
    rerender(<OrgKnowledgeDetail base={next} owned />)
    expect(await screen.findByText('乙库根文件')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: i18n.t('knowledge.org.shares') }))
    await screen.findByText('No share codes')
    rerender(<OrgKnowledgeDetail base={base} owned />)
    expect(await screen.findByText(directory.title)).toBeInTheDocument()
  })
  it('本人云端资料在共用面板工具栏添加，头部保留分享操作且不提供本机写菜单', async () => {
    render(<OrgKnowledgeDetail base={base} owned />)
    await screen.findByText(item.title)
    const toolbar = screen.getByRole('toolbar', { name: i18n.t('knowledge.org.documents') })
    expect(toolbar).toContainElement(screen.getByRole('button', { name: i18n.t('knowledge.data_source.toolbar.add') }))
    expect(screen.getByRole('button', { name: i18n.t('knowledge.org.share') })).toBeInTheDocument()
    expect(toolbar.closest('section')).toContainElement(screen.getByRole('grid'))
    expect(
      screen.getByRole('columnheader', { name: i18n.t('knowledge.data_source.table.select_all') })
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Rebuild|Recall/ })).not.toBeInTheDocument()
    expect(request.mock.calls.every(([route]) => !route.startsWith('knowledge.'))).toBe(true)
  })

  it('按游标分页，不出现本地写操作或成员管理', async () => {
    const user = userEvent.setup()
    render(<OrgKnowledgeDetail base={base} owned={false} />)
    expect(await screen.findByText('说明.pdf')).toBeInTheDocument()
    expect(screen.queryByText(base.description)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: i18n.t('knowledge.org.documents') })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: i18n.t('knowledge.org.search') })).not.toBeInTheDocument()
    expect(screen.queryByText(i18n.t('knowledge.org.readonly_notice'))).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next page' }))
    expect(await screen.findByText('第二页')).toBeInTheDocument()
    expect(request).toHaveBeenCalledWith('enterprise.knowledge.items', {
      baseId: base.id,
      cursor: 'page2',
      parentId: null
    })
    expect(screen.queryByRole('button', { name: 'Manage members' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Share|Add|Delete|Rebuild/ })).not.toBeInTheDocument()
  })

  it('文件夹可进入子目录并返回父目录', async () => {
    const directory = {
      ...item,
      id: 'orgkb:directory',
      type: 'directory',
      title: '资料夹',
      parentId: null,
      documentId: null
    }
    const child = { ...item, id: 'orgkb:child', title: '子文件.txt', parentId: directory.fileId }
    request.mockImplementation(async (route, input) => {
      if (route === 'enterprise.knowledge.items') {
        const items = input.parentId === directory.fileId ? [child] : [directory]
        return { items, total: items.length, nextCursor: null }
      }
      return { kind: 'text', fileName: child.title, mimeType: 'text/plain', content: '子文件内容' }
    })
    const user = userEvent.setup()
    render(<OrgKnowledgeDetail base={base} owned={false} />)
    await user.click(await screen.findByText(directory.title))
    expect(await screen.findByText(child.title)).toBeInTheDocument()
    expect(screen.queryByText(directory.title)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByText(directory.title)).toBeInTheDocument()
  })

  it('多层目录逐级返回时显示父目录文件而非子目录缓存', async () => {
    const directory = {
      ...item,
      id: 'orgkb:directory-a',
      fileId: 'orgkb:file-a',
      type: 'directory',
      title: '目录A',
      documentId: null
    }
    const nestedDirectory = {
      ...directory,
      id: 'orgkb:directory-b',
      fileId: 'orgkb:file-b',
      title: '目录B',
      parentId: directory.fileId
    }
    const parentFile = { ...item, id: 'orgkb:parent-file', title: 'A层文件.txt', parentId: directory.fileId }
    const childFile = { ...item, id: 'orgkb:child-file', title: 'B层文件.txt', parentId: nestedDirectory.fileId }
    request.mockImplementation(async (route, input) => {
      if (route === 'enterprise.knowledge.items') {
        const items =
          input.parentId === nestedDirectory.fileId
            ? [childFile]
            : input.parentId === directory.fileId
              ? [nestedDirectory, parentFile]
              : [directory, item]
        return { items, total: items.length, nextCursor: null }
      }
      return { chunks: [] }
    })
    const user = userEvent.setup()
    render(<OrgKnowledgeDetail base={base} owned={false} />)
    await user.click(await screen.findByText(directory.title))
    expect(await screen.findByText(parentFile.title)).toBeInTheDocument()
    await user.click(await screen.findByText(nestedDirectory.title))
    expect(await screen.findByText(childFile.title)).toBeInTheDocument()
    expect(screen.queryByText(parentFile.title)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByText(parentFile.title)).toBeInTheDocument()
    expect(screen.getByText(nestedDirectory.title)).toBeInTheDocument()
    expect(screen.queryByText(childFile.title)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByText(directory.title)).toBeInTheDocument()
    expect(screen.getByText(item.title)).toBeInTheDocument()
    expect(screen.queryByText(parentFile.title)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()
  })

  it('目录分页重复游标停止请求并显示错误而非空态', async () => {
    const directory = { ...item, id: 'orgkb:dir', title: '循环目录', type: 'directory', documentId: null }
    request.mockImplementation(async (route, input) => {
      if (route !== 'enterprise.knowledge.items') throw new Error('非预期请求')
      return input.parentId
        ? { items: [item], total: 10, nextCursor: 'repeat' }
        : { items: [directory], total: 1, nextCursor: null }
    })
    const user = userEvent.setup()
    render(<OrgKnowledgeDetail base={base} owned={false} />)
    await user.click(await screen.findByText(directory.title))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(
      request.mock.calls.filter(
        ([route, input]) => route === 'enterprise.knowledge.items' && input.parentId && input.cursor === 'repeat'
      )
    ).toHaveLength(1)
    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('common.error'))
  })

  it('返回上级后忽略未完成目录请求的迟到响应', async () => {
    const directory = { ...item, id: 'orgkb:dir', title: '慢目录', type: 'directory', documentId: null }
    const pending: ((value: unknown) => void)[] = []
    request.mockImplementation(async (route, input) => {
      if (route !== 'enterprise.knowledge.items') throw new Error('非预期请求')
      if (!input.parentId) return { items: [directory, item], total: 2, nextCursor: null }
      return new Promise((done) => {
        pending.push(done)
      })
    })
    render(<OrgKnowledgeDetail base={base} owned={false} />)
    await userEvent.click(await screen.findByText(directory.title))
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    await act(async () => {
      for (const resolve of pending)
        resolve({ items: [{ ...item, title: '迟到的子文件' }], total: 1, nextCursor: null })
    })
    expect(screen.getByText(item.title)).toBeInTheDocument()
    expect(screen.getByText(directory.title)).toBeInTheDocument()
    expect(screen.queryByText('迟到的子文件')).not.toBeInTheDocument()
  })

  it('使用文件映射在应用内查看器展示 PDF', async () => {
    const user = userEvent.setup()
    render(<OrgKnowledgeDetail base={base} owned={false} />)
    await user.click(await screen.findByText(item.title))
    await waitFor(() => expect(screen.getByTitle(item.title)).toHaveAttribute('data-pdf-base64', 'JVBERi0='))
    expect(screen.queryByText(base.name)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Chunks' })).not.toBeInTheDocument()
    expect(document.querySelector('iframe')).toBeNull()
    expect(request).toHaveBeenCalledWith('enterprise.knowledge.preview', { fileId: item.fileId })
  })

  it.each(officeFormats)(
    '$extension 原文按 MIME 将完整内存输入传给对应查看器，返回后可重开',
    async ({ extension, mimeType, preview }) => {
      const original = request.getMockImplementation()!
      const fileName = `原文.${extension}`
      let base64 = 'UEsDBAD/gA=='
      request.mockImplementation(async (route, input) =>
        route === 'enterprise.knowledge.preview'
          ? { kind: 'inline', fileName, mimeType, base64, content: '' }
          : original(route, input)
      )
      const user = userEvent.setup()
      render(<OrgKnowledgeDetail base={base} owned={extension === 'docx'} />)
      await user.click(await screen.findByText(item.title))
      await waitFor(() => expect(preview).toHaveBeenCalledWith({ fileName, base64 }, undefined))
      for (const format of officeFormats) {
        if (format.preview !== preview) expect(format.preview).not.toHaveBeenCalled()
      }
      expect(screen.queryByText(i18n.t('knowledge.org.preview_unavailable'))).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: i18n.t('common.back') }))
      expect(await screen.findByText(item.title)).toBeInTheDocument()
      preview.mockClear()
      base64 = 'UEsDBAEAgP8='
      await user.click(screen.getByText(item.title))
      await waitFor(() => expect(preview).toHaveBeenCalledWith({ fileName, base64 }, undefined))
    }
  )

  it.each([
    ...officeFormats.map(({ extension, mimeType }) => ({ extension, mimeType })),
    { extension: 'doc', mimeType: 'application/msword' },
    { extension: 'xls', mimeType: 'application/vnd.ms-excel' },
    { extension: 'ppt', mimeType: 'application/vnd.ms-powerpoint' }
  ])('$extension 的 text 响应保持文本预览，即使包含 Office MIME 和 base64', async ({ extension, mimeType }) => {
    const original = request.getMockImplementation()!
    const content = `提取正文 ${extension}`
    request.mockImplementation(async (route, input) =>
      route === 'enterprise.knowledge.preview'
        ? { kind: 'text', fileName: `原文.${extension}`, mimeType, base64: 'UEsDBAD/gA==', content }
        : original(route, input)
    )
    render(<OrgKnowledgeDetail base={base} owned={false} />)
    await userEvent.setup().click(await screen.findByText(item.title))
    expect(await screen.findByText(content)).toBeInTheDocument()
    for (const { preview } of officeFormats) expect(preview).not.toHaveBeenCalled()
  })

  it('Office 预览等待 IPC、失败刷新后恢复，并可退出', async () => {
    const original = request.getMockImplementation()!
    let rejectPreview!: (reason: Error) => void
    request.mockImplementation((route, input) =>
      route === 'enterprise.knowledge.preview'
        ? new Promise((_resolve, reject) => {
            rejectPreview = reject
          })
        : original(route, input)
    )
    const user = userEvent.setup()
    render(<OrgKnowledgeDetail base={base} owned={false} />)
    await user.click(await screen.findByText(item.title))
    expect(screen.getByRole('status')).toHaveTextContent(i18n.t('common.loading'))
    expect(wordPreview).not.toHaveBeenCalled()
    await act(async () => rejectPreview(new Error('原文暂时不可用')))
    expect(await screen.findByRole('alert')).toHaveTextContent('原文暂时不可用')
    const fileName = '恢复.docx'
    const base64 = 'UEsDBAD/gA=='
    request.mockImplementation(async (route, input) =>
      route === 'enterprise.knowledge.preview'
        ? { kind: 'inline', fileName, mimeType: officeFormats[0].mimeType, base64, content: '' }
        : original(route, input)
    )
    await user.click(screen.getByRole('button', { name: i18n.t('knowledge.org.refresh') }))
    await waitFor(() => expect(wordPreview).toHaveBeenCalledWith({ fileName, base64 }, undefined))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: i18n.t('common.back') }))
    expect(await screen.findByText(item.title)).toBeInTheDocument()
  })

  it('图片以 img 展示，HTML 内容保持纯文本', async () => {
    const original = request.getMockImplementation()!
    let html = false
    request.mockImplementation(async (route, input) =>
      route === 'enterprise.knowledge.preview'
        ? html
          ? { kind: 'text', fileName: 'a.html', mimeType: 'text/html', content: '<script>bad()</script>' }
          : { kind: 'inline', fileName: 'a.png', mimeType: 'image/png', content: '', base64: 'aGVsbG8=' }
        : original(route, input)
    )
    const user = userEvent.setup()
    const view = render(<OrgKnowledgeDetail base={base} owned={false} />)
    await user.click(await screen.findByText(item.title))
    expect(await screen.findByRole('img', { name: 'a.png' })).toHaveAttribute('src', 'data:image/png;base64,aGVsbG8=')
    view.unmount()
    html = true
    const second = render(<OrgKnowledgeDetail base={base} owned={false} />)
    await user.click(await screen.findByText(item.title))
    expect(await screen.findByText('<script>bad()</script>')).toBeInTheDocument()
    expect(second.container.querySelector('script')).toBeNull()
  })

  it('操作菜单可直接预览原文或查看分块', async () => {
    const user = userEvent.setup()
    render(<OrgKnowledgeDetail base={base} owned={false} />)
    await screen.findByText(item.title)
    await user.click(screen.getByRole('button', { name: i18n.t('common.more') }))
    await user.click(await screen.findByRole('menuitem', { name: i18n.t('knowledge.data_source.actions.view_chunks') }))
    expect(await screen.findByText('分块内容')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: i18n.t('common.back') }))
    await user.click(screen.getByRole('button', { name: i18n.t('common.more') }))
    await user.click(
      await screen.findByRole('menuitem', { name: i18n.t('knowledge.data_source.actions.preview_source') })
    )
    await waitFor(() => expect(screen.getByTitle(item.title)).toHaveAttribute('data-pdf-base64', 'JVBERi0='))
  })

  it('PDF 即便带有临时地址也不创建会触发下载的 iframe', async () => {
    const original = request.getMockImplementation()!
    request.mockImplementation(async (route, input) =>
      route === 'enterprise.knowledge.preview'
        ? {
            kind: 'inline',
            fileName: item.title,
            mimeType: 'application/pdf',
            content: '',
            url: 'https://storage.example/document.pdf?signature=test',
            base64: 'JVBERi0='
          }
        : original(route, input)
    )
    const user = userEvent.setup()
    render(<OrgKnowledgeDetail base={base} owned={false} />)
    await user.click(await screen.findByText(item.title))
    await waitFor(() => expect(screen.getByTitle(item.title)).toHaveAttribute('data-pdf-base64', 'JVBERi0='))
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('请求失败后可刷新恢复', async () => {
    request.mockRejectedValueOnce(new Error('访问暂时失败'))
    const user = userEvent.setup()
    render(<OrgKnowledgeDetail base={base} owned={false} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('访问暂时失败')
    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(screen.getByText('说明.pdf')).toBeInTheDocument())
  })
})
