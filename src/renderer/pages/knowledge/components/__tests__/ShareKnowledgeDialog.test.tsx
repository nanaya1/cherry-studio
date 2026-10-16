import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { beforeEach, expect, it, vi } from 'vitest'

import ShareKnowledgeDialog from '../ShareKnowledgeDialog'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request } }))
vi.unmock('@cherrystudio/ui')
const share = {
  id: 'orgkb:code',
  spaceId: 'orgkb:copy',
  shareCode: 'Abcd_123',
  shareType: 1,
  hasPassword: false,
  maxViews: null,
  viewCount: 0,
  expiresAt: null,
  revokedAt: null,
  createdAt: '2026-10-15T00:00:00Z'
}
const props = { baseId: 'local', name: '本地资料', onClose: vi.fn(), onShared: vi.fn() }
beforeEach(async () => {
  await i18n.changeLanguage('en-us')
  request.mockReset()
  HTMLElement.prototype.scrollIntoView = vi.fn()
  HTMLElement.prototype.hasPointerCapture = () => false
  HTMLElement.prototype.releasePointerCapture = vi.fn()
  HTMLElement.prototype.setPointerCapture = vi.fn()
  request.mockImplementation(async (route) =>
    route === 'enterprise.knowledge.share'
      ? { shareId: 'orgkb:copy', completion: 'completed', files: [{ fileName: 'a.md', status: 'success' }] }
      : share
  )
})

it('完整上传后明确创建七天只读码，用户复制前不写剪贴板', async () => {
  const user = userEvent.setup()
  const clipboard = vi.spyOn(navigator.clipboard, 'writeText')
  render(<ShareKnowledgeDialog {...props} />)
  await user.click(screen.getByRole('button', { name: 'Generate share code' }))
  expect(await screen.findByText('Abcd_123')).toBeInTheDocument()
  expect(request).toHaveBeenCalledWith('enterprise.knowledge.create_share', { baseId: 'orgkb:copy', expireDays: 7 })
  expect(clipboard).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Copy sharing text' }))
  expect(clipboard).toHaveBeenCalledWith(expect.stringContaining('本地资料'))
  expect(clipboard).toHaveBeenCalledWith(expect.stringContaining('Abcd_123'))
  expect(clipboard).toHaveBeenCalledWith(expect.stringContaining('Shared with me'))
})

it('指定人入口只展示邀请，复用完整副本发送邀请', async () => {
  const original = request.getMockImplementation()!
  request.mockImplementation(async (route, args) => {
    if (route === 'enterprise.knowledge.collaborators')
      return { items: [{ id: 42, username: 'alice' }], total: 1, page: 1, pageSize: 20 }
    if (route === 'enterprise.knowledge.members') return { members: [] }
    if (route === 'enterprise.knowledge.invite')
      return { userId: 42, username: 'alice', role: 'viewer', joinedAt: '', status: 'pending', expiresAt: null }
    return original(route, args)
  })
  const user = userEvent.setup()
  render(<ShareKnowledgeDialog {...props} mode="people" />)
  expect(screen.queryByRole('button', { name: 'Generate share code' })).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Extraction password (optional, 4–32 characters)')).not.toBeInTheDocument()
  await user.type(screen.getByRole('combobox'), 'ali')
  await user.click(await screen.findByRole('option', { name: 'alice' }))
  await user.click(screen.getByRole('button', { name: 'Send invitation' }))
  expect(await screen.findByRole('status')).toHaveTextContent('Invitation sent')
  expect(request.mock.calls.some(([route]) => route === 'enterprise.knowledge.create_share')).toBe(false)
  expect(request).toHaveBeenCalledWith('enterprise.knowledge.invite', { baseId: 'local', userId: 42, expireDays: 7 })
  expect(request.mock.calls.filter(([route]) => route === 'enterprise.knowledge.share')).toHaveLength(1)
})

it('分享码入口不展示指定人邀请', () => {
  render(<ShareKnowledgeDialog {...props} />)
  expect(screen.queryByRole('button', { name: 'Invite people' })).not.toBeInTheDocument()
})

it('远端副本入口不展示指定人邀请', () => {
  render(<ShareKnowledgeDialog {...props} remote />)
  expect(screen.queryByRole('button', { name: 'Invite people' })).not.toBeInTheDocument()
})

it('非法密码或次数阻断请求，留空恢复有效', async () => {
  const user = userEvent.setup()
  render(<ShareKnowledgeDialog {...props} />)
  const password = screen.getByLabelText('Extraction password (optional, 4–32 characters)')
  const count = screen.getByLabelText('Maximum accesses (optional)')
  await user.type(password, 'abc')
  expect(screen.getByRole('button', { name: 'Generate share code' })).toBeDisabled()
  await user.clear(password)
  await user.type(count, '0')
  expect(screen.getByRole('button', { name: 'Generate share code' })).toBeDisabled()
  await user.clear(count)
  await user.type(count, '1.5')
  expect(screen.getByRole('button', { name: 'Generate share code' })).toBeDisabled()
  await user.clear(count)
  expect(screen.getByRole('button', { name: 'Generate share code' })).toBeEnabled()
  expect(request).not.toHaveBeenCalled()
})

it.each(['incomplete', 'unconfirmed', 'completed'])('%s 且文件失败时禁止创建码', async (completion) => {
  request.mockResolvedValue({ shareId: 'orgkb:copy', completion, files: [{ fileName: 'a.md', status: 'failure' }] })
  const user = userEvent.setup()
  render(<ShareKnowledgeDialog {...props} />)
  await user.click(screen.getByRole('button', { name: 'Generate share code' }))
  await screen.findByRole('alert')
  expect(request.mock.calls.some(([route]) => route === 'enterprise.knowledge.create_share')).toBe(false)
  expect(screen.getByRole('button', { name: 'Generate share code' })).toBeDisabled()
})

it('创建未知先查列表并锁住重复 POST，即使列表查询失败', async () => {
  request.mockImplementation(async (route) => {
    if (route === 'enterprise.knowledge.share')
      return { shareId: 'orgkb:copy', completion: 'completed', files: [{ fileName: 'a.md', status: 'success' }] }
    if (route === 'enterprise.knowledge.create_share')
      throw Object.assign(new Error('unknown'), { code: 'ORGKB_SHARE_CREATE_UNKNOWN' })
    throw new Error('offline')
  })
  const user = userEvent.setup()
  render(<ShareKnowledgeDialog {...props} />)
  await user.click(screen.getByRole('button', { name: 'Generate share code' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('pending verification')
  expect(request).toHaveBeenCalledWith('enterprise.knowledge.shares', { baseId: 'orgkb:copy' })
  expect(screen.getByRole('button', { name: 'Generate share code' })).toBeDisabled()
})

it('关闭后上传旧回包不能继续创建分享码', async () => {
  const user = userEvent.setup()
  let resolve!: (value: unknown) => void
  request.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const view = render(<ShareKnowledgeDialog {...props} />)
  await user.click(screen.getByRole('button', { name: 'Generate share code' }))
  view.unmount()
  await act(async () =>
    resolve({ shareId: 'orgkb:copy', completion: 'completed', files: [{ fileName: 'a.md', status: 'success' }] })
  )
  expect(request.mock.calls.some(([route]) => route === 'enterprise.knowledge.create_share')).toBe(false)
})

it('明确失败复用完整副本，永久与密码及次数正确发送', async () => {
  let attempts = 0
  request.mockImplementation(async (route) => {
    if (route === 'enterprise.knowledge.share')
      return { shareId: 'orgkb:copy', completion: 'completed', files: [{ fileName: 'a.md', status: 'success' }] }
    if (++attempts === 1) throw new Error('failed')
    return { ...share, hasPassword: true }
  })
  const user = userEvent.setup()
  render(<ShareKnowledgeDialog {...props} />)
  act(() => screen.getByRole('combobox', { name: 'Validity' }).focus())
  await user.keyboard('{ArrowDown}')
  await user.click(await screen.findByRole('option', { name: 'Never expires' }))
  await user.type(screen.getByLabelText('Extraction password (optional, 4–32 characters)'), 'abcd')
  await user.type(screen.getByLabelText('Maximum accesses (optional)'), '2')
  await user.click(screen.getByRole('button', { name: 'Generate share code' }))
  await screen.findByRole('alert')
  await user.click(screen.getByRole('button', { name: 'Generate share code' }))
  await screen.findByText('Abcd_123')
  expect(request.mock.calls.filter(([route]) => route === 'enterprise.knowledge.share')).toHaveLength(1)
  expect(request).toHaveBeenLastCalledWith('enterprise.knowledge.create_share', {
    baseId: 'orgkb:copy',
    expireDays: null,
    password: 'abcd',
    maxViews: 2
  })
})
