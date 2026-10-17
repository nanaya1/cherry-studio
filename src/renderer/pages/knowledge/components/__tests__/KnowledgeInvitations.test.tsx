import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { beforeEach, expect, it, vi } from 'vitest'

import KnowledgeInvitations from '../KnowledgeInvitations'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request } }))
vi.unmock('@cherrystudio/ui')

beforeEach(async () => {
  await i18n.changeLanguage('en-us')
  request.mockReset()
})

it.each(['accept', 'decline'])('从独立弹窗%s邀请后更新数量和目录', async (action) => {
  let pending = true
  request.mockImplementation(async (route) => {
    if (route === 'enterprise.knowledge.invitations')
      return {
        invitations: pending
          ? [{ id: 'invite-1', name: 'Team documents', inviter: 'Alice', role: 'viewer', expires: null }]
          : []
      }
    pending = false
    return { ok: true }
  })
  const onChanged = vi.fn().mockResolvedValue(undefined)
  const user = userEvent.setup()
  render(<KnowledgeInvitations onChanged={onChanged} />)
  expect(screen.queryByText('Team documents')).not.toBeInTheDocument()
  await user.click(await screen.findByRole('button', { name: /Invitations.*1/i }))
  expect(screen.getByRole('dialog')).toHaveTextContent('Team documents')
  await user.click(screen.getByRole('button', { name: action === 'accept' ? 'Accept' : 'Decline' }))
  await waitFor(() => expect(screen.queryByText('Team documents')).not.toBeInTheDocument())
  expect(request).toHaveBeenCalledWith(`enterprise.knowledge.${action}`, { invitationId: 'invite-1' })
  expect(onChanged).toHaveBeenCalledOnce()
  // 弹窗打开时背景入口对辅助技术隐藏，关闭后验证数量清零。
  // await user.click(screen.getByRole('button', { name: 'Close', exact: true }))
  await user.click(screen.getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(screen.getByRole('button', { name: 'Pending invitations' })).toBeInTheDocument()
})

it('从邀请弹窗切换分享码添加时关闭当前弹窗', async () => {
  request.mockResolvedValue({ invitations: [] })
  const onAddWithCode = vi.fn()
  const user = userEvent.setup()
  render(<KnowledgeInvitations onChanged={vi.fn()} onAddWithCode={onAddWithCode} />)
  await user.click(screen.getByRole('button', { name: /Invitations/i }))
  await user.click(screen.getByRole('button', { name: 'Add with share code' }))
  expect(onAddWithCode).toHaveBeenCalledOnce()
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
})

it('加载失败仍可打开弹窗并重试', async () => {
  request.mockRejectedValueOnce(new Error('network unavailable')).mockResolvedValue({ invitations: [] })
  const user = userEvent.setup()
  render(<KnowledgeInvitations onChanged={vi.fn()} />)
  await user.click(screen.getByRole('button', { name: /Invitations/i }))
  expect(await screen.findByRole('alert')).toHaveTextContent('network unavailable')
  await user.click(screen.getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
})
