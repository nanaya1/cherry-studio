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
    return undefined
  })
})
it('输入自动远程模糊查询，下拉选中后才允许发送且原始id透传', async () => {
  const user = userEvent.setup()
  render(<KnowledgeInvitePanel {...props} />)
  expect(screen.getByRole('button', { name: 'Send invitation' })).toBeDisabled()
  await user.type(screen.getByRole('combobox'), 'ali')
  await user.click(await screen.findByRole('option', { name: 'alice' }))
  expect(request).toHaveBeenCalledWith('enterprise.knowledge.collaborators', {
    baseId: 'local',
    keyword: 'ali',
    page: 1,
    pageSize: 50
  })
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

it('查询失败时收起下拉框并完整展示错误，重新输入后可以恢复检索', async () => {
  const original = request.getMockImplementation()!
  let failed = true
  request.mockImplementation(async (route, args) => {
    if (route === 'enterprise.knowledge.collaborators' && failed) throw new Error('当前企业成员查询失败，请稍后重试')
    return original(route, args)
  })
  const user = userEvent.setup()
  render(<KnowledgeInvitePanel {...props} remote />)
  await user.type(screen.getByRole('combobox'), 'ali')
  expect(await screen.findByRole('alert')).toHaveTextContent('当前企业成员查询失败，请稍后重试')
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  expect(screen.queryByText(i18n.t('knowledge.org.empty_results'))).not.toBeInTheDocument()
  failed = false
  await user.type(screen.getByRole('combobox'), 'alice')
  await user.click(await screen.findByRole('option', { name: 'alice' }))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Send invitation' })).toBeEnabled()
})

it('首次共享未完成时先明确上传，失败可重试，确认成功后自动恢复原候选查询', async () => {
  const original = request.getMockImplementation()!
  let completed = false
  let uploadFailed = true
  request.mockImplementation(async (route, args) => {
    if (route === 'enterprise.knowledge.collaborators' && !completed)
      throw Object.assign(new Error('该本地知识库尚未完成共享关联，无法查询协作者'), {
        code: 'ORGKB_SHARE_INCOMPLETE'
      })
    if (route === 'enterprise.knowledge.share') {
      if (uploadFailed)
        return {
          shareId: 'orgkb:copy',
          completion: 'incomplete',
          files: [{ fileName: 'a.md', status: 'failure', error: '源文件上传失败' }]
        }
      completed = true
    }
    return original(route, args)
  })
  const user = userEvent.setup()
  render(<KnowledgeInvitePanel {...props} />)
  await user.type(screen.getByRole('combobox'), 'ali')
  expect(await screen.findByRole('alert')).toHaveTextContent(i18n.t('knowledge.org.invite_upload_required'))
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  expect(request.mock.calls.some(([route]) => route === 'enterprise.knowledge.share')).toBe(false)
  await user.click(screen.getByRole('button', { name: i18n.t('knowledge.org.invite_prepare') }))
  expect(await screen.findByRole('alert')).toHaveTextContent('源文件上传失败')
  expect(screen.getByRole('combobox')).toBeDisabled()
  expect(request.mock.calls.some(([route]) => route === 'enterprise.knowledge.invite')).toBe(false)
  uploadFailed = false
  await user.click(screen.getByRole('button', { name: i18n.t('knowledge.org.invite_prepare') }))
  await user.click(await screen.findByRole('option', { name: 'alice' }))
  await user.click(screen.getByRole('button', { name: 'Send invitation' }))
  expect(await screen.findByRole('status')).toHaveTextContent(i18n.t('knowledge.org.invited'))
  expect(request).toHaveBeenCalledWith('enterprise.knowledge.share', { baseId: 'local', uploadOriginal: true })
})
