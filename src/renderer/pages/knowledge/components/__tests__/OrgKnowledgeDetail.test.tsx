import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import OrgKnowledgeDetail from '../OrgKnowledgeDetail'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request } }))
vi.unmock('@cherrystudio/ui')
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
  documentId: 'orgkb:document',
  fileId: 'orgkb:file',
  createdAt: '',
  updatedAt: ''
}

beforeEach(async () => {
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

describe('组织知识库只读详情', () => {
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
    expect(request).toHaveBeenCalledWith('enterprise.knowledge.items', { baseId: base.id, cursor: 'page2' })
    expect(screen.queryByRole('button', { name: 'Manage members' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Share|Add|Delete|Rebuild/ })).not.toBeInTheDocument()
  })

  it('使用文件映射在应用内查看器展示 PDF', async () => {
    const user = userEvent.setup()
    render(<OrgKnowledgeDetail base={base} owned={false} />)
    await user.click(await screen.findByText(item.title))
    expect(await screen.findByTitle(item.title)).toHaveAttribute('data-pdf-base64', 'JVBERi0=')
    expect(screen.queryByText(base.name)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Chunks' })).not.toBeInTheDocument()
    expect(document.querySelector('iframe')).toBeNull()
    expect(request).toHaveBeenCalledWith('enterprise.knowledge.preview', { fileId: item.fileId })
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
    expect(await screen.findByTitle(item.title)).toHaveAttribute('data-pdf-base64', 'JVBERi0=')
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
    expect(await screen.findByTitle(item.title)).toHaveAttribute('data-pdf-base64', 'JVBERi0=')
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
