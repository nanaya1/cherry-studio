import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { beforeEach, expect, it, vi } from 'vitest'

import KnowledgeInvitePanel from '../KnowledgeInvitePanel'
const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request } }))
vi.unmock('@cherrystudio/ui')
const props = { baseId: 'local', busy: false, onBusyChange: vi.fn(), onPrepared: vi.fn(), onInvited: vi.fn() }
beforeEach(async () => {
  await i18n.changeLanguage('en-us')
  HTMLElement.prototype.scrollIntoView = vi.fn()
  request.mockReset()
  request.mockImplementation(async (route) => {
    if (route === 'enterprise.knowledge.collaborators')
      return { items: [{ id: 42, username: 'alice' }], total: 1, page: 1, pageSize: 50 }
    if (route === 'enterprise.knowledge.share')
      return { shareId: 'orgkb:copy', completion: 'completed', files: [{ fileName: 'a', status: 'success' }] }
    if (route === 'enterprise.knowledge.members') return { members: [] }
    if (route === 'enterprise.knowledge.invite') return { userId: 42 }
  })
})
it('输入自动远程模糊查询，下拉选中后才允许发送且原始id透传', async () => {
  const user = userEvent.setup()
  render(<KnowledgeInvitePanel {...props} />)
  expect(screen.getByRole('button', { name: 'Send invitation' })).toBeDisabled()
  await user.type(screen.getByRole('combobox'), 'ali')
  await user.click(await screen.findByRole('option', { name: 'alice' }))
  expect(request).toHaveBeenCalledWith('enterprise.knowledge.collaborators', { keyword: 'ali', page: 1, pageSize: 50 })
  expect(request.mock.calls.some(([route]) => route === 'enterprise.knowledge.share')).toBe(false)
  await user.click(screen.getByRole('button', { name: 'Send invitation' }))
  expect(await screen.findByRole('status')).toHaveTextContent('Invitation sent')
  expect(request).toHaveBeenCalledWith('enterprise.knowledge.invite', { baseId: 'local', userId: 42, expireDays: 7 })
  expect(screen.getByRole('button', { name: 'Send invitation' })).toBeDisabled()
})
it('已是成员时阻断邀请并展示原因', async () => {
  const original = request.getMockImplementation()!
  request.mockImplementation(async (route, args) =>
    route === 'enterprise.knowledge.members' ? { members: [{ userId: 42, status: 'pending' }] } : original(route, args)
  )
  const user = userEvent.setup()
  render(<KnowledgeInvitePanel {...props} />)
  await user.type(screen.getByRole('combobox'), 'ali')
  await user.click(await screen.findByRole('option', { name: 'alice' }))
  await user.click(screen.getByRole('button', { name: 'Send invitation' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Member or invitation pending')
  expect(request.mock.calls.some(([route]) => route === 'enterprise.knowledge.invite')).toBe(false)
})
