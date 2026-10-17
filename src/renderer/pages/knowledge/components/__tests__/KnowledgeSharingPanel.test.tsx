import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { beforeEach, expect, it, vi } from 'vitest'

import KnowledgeSharingPanel from '../KnowledgeSharingPanel'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request } }))
vi.unmock('@cherrystudio/ui')
beforeEach(async () => {
  await i18n.changeLanguage('en-us')
  request.mockReset()
})

it('列出分享码状态和计数，明确确认吊销后重查服务端', async () => {
  const user = userEvent.setup()
  let revoked = false
  request.mockImplementation(async (route) => {
    if (route === 'enterprise.knowledge.shares')
      return {
        shares: [
          {
            id: 'orgkb:code',
            spaceId: 'orgkb:owned',
            shareCode: 'Abcd_123',
            hasPassword: true,
            shareType: 1,
            viewCount: 3,
            maxViews: 5,
            expiresAt: null,
            revokedAt: revoked ? '2026-10-15T00:00:00Z' : null,
            createdAt: '2026-10-14T00:00:00Z'
          }
        ]
      }
    if (route === 'enterprise.knowledge.revoke_share') {
      revoked = true
      return { ok: true }
    }
    return {}
  })
  render(<KnowledgeSharingPanel baseId="orgkb:owned" />)
  expect(await screen.findByText('Abcd_123')).toBeInTheDocument()
  expect(screen.getByText('Accesses: 3')).toBeInTheDocument()
  expect(screen.queryByLabelText(/Recipient/)).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Revoke code' }))
  expect(screen.getByText(/Other codes, member and group grants/)).toBeInTheDocument()
  expect(revoked).toBe(false)
  await user.click(screen.getByRole('button', { name: 'Confirm revocation' }))
  expect(await screen.findByText('Revoked')).toBeInTheDocument()
  expect(request).toHaveBeenCalledWith('enterprise.knowledge.revoke_share', {
    baseId: 'orgkb:owned',
    shareId: 'orgkb:code'
  })
})

it('已有副本生成码不重新上传文件', async () => {
  const user = userEvent.setup()
  request.mockImplementation(async (route) =>
    route === 'enterprise.knowledge.shares'
      ? { shares: [] }
      : { id: 'orgkb:code', shareCode: 'New_1234', expiresAt: null }
  )
  render(<KnowledgeSharingPanel baseId="orgkb:owned" name="资料" />)
  await screen.findByText('No share codes')
  await user.click(screen.getByRole('button', { name: 'Generate share code' }))
  await user.click(screen.getByRole('button', { name: 'Generate share code' }))
  expect(await screen.findByText('New_1234')).toBeInTheDocument()
  expect(request.mock.calls.some(([route]) => route === 'enterprise.knowledge.share')).toBe(false)
})

it('列表入口直接打开二次确认但确认前不提交取消', async () => {
  request.mockImplementation(async (route) => route === 'enterprise.knowledge.shares' ? { shares: [] } : { state: 'shared' })
  render(<KnowledgeSharingPanel baseId="orgkb:owned" localBaseId="local-1" confirmUnshare />)
  expect(await screen.findByRole('button', { name: 'Confirm unsharing' })).toBeInTheDocument()
  expect(request.mock.calls.some(([route]) => route === 'enterprise.knowledge.unshare')).toBe(false)
})

it('无 localBaseId 时不显示取消整个分享', async () => {
  request.mockImplementation(async (route) => (route === 'enterprise.knowledge.shares' ? { shares: [] } : {}))
  render(<KnowledgeSharingPanel baseId="orgkb:owned" />)
  await screen.findByText('No share codes')
  expect(screen.queryByRole('button', { name: 'Cancel sharing' })).not.toBeInTheDocument()
})

it('本地副本显示取消整个分享，二次确认明确云端撤下本地保留并刷新', async () => {
  const user = userEvent.setup()
  const onUnshared = vi.fn()
  request.mockImplementation(async (route) => {
    if (route === 'enterprise.knowledge.shares')
      return {
        shares: [
          {
            id: 'orgkb:code',
            spaceId: 'orgkb:owned',
            shareCode: 'Abcd_123',
            hasPassword: false,
            shareType: 1,
            viewCount: 0,
            maxViews: null,
            expiresAt: null,
            revokedAt: null,
            createdAt: '2026-10-14T00:00:00Z'
          }
        ]
      }
    if (route === 'enterprise.knowledge.upload_status') return null
    if (route === 'enterprise.knowledge.sync_status') return { state: 'shared', lastSyncedAt: null }
    if (route === 'enterprise.knowledge.unshare') return { ok: true }
    return {}
  })
  render(<KnowledgeSharingPanel baseId="orgkb:owned" localBaseId="local-1" name="资料" onUnshared={onUnshared} />)
  await screen.findByText('Abcd_123')
  await user.click(screen.getByRole('button', { name: 'Cancel sharing' }))
  // 二次确认文案明确云端副本撤下、本地保留。
  expect(screen.getByText(/cloud copy will be taken down/i)).toBeInTheDocument()
  const confirm = await screen.findByRole('button', { name: 'Confirm unsharing' })
  await waitFor(() => expect(confirm).toBeEnabled())
  await user.click(confirm)
  expect(await screen.findByText('Abcd_123')).toBeInTheDocument()
  expect(request).toHaveBeenCalledWith('enterprise.knowledge.unshare', { baseId: 'local-1' })
  expect(onUnshared).toHaveBeenCalledTimes(1)
})

it('取消分享失败保留确认与错误并可重试', async () => {
  const user = userEvent.setup()
  const onUnshared = vi.fn()
  request.mockImplementation(async (route) => {
    if (route === 'enterprise.knowledge.shares') return { shares: [] }
    if (route === 'enterprise.knowledge.upload_status') return null
    if (route === 'enterprise.knowledge.sync_status') return { state: 'shared', lastSyncedAt: null }
    if (route === 'enterprise.knowledge.unshare') throw new Error('server rejected')
    return {}
  })
  render(<KnowledgeSharingPanel baseId="orgkb:owned" localBaseId="local-1" onUnshared={onUnshared} />)
  await screen.findByText('No share codes')
  await user.click(screen.getByRole('button', { name: 'Cancel sharing' }))
  const confirm = await screen.findByRole('button', { name: 'Confirm unsharing' })
  await waitFor(() => expect(confirm).toBeEnabled())
  await user.click(confirm)
  expect(await screen.findByText('server rejected')).toBeInTheDocument()
  expect(onUnshared).not.toHaveBeenCalled()
  expect(request.mock.calls.filter(([route]) => route === 'enterprise.knowledge.unshare')).toHaveLength(1)
  // 重试：确认保留，再次点击仍调用一次。
  await user.click(screen.getByRole('button', { name: 'Confirm unsharing' }))
  expect(await screen.findByText('server rejected')).toBeInTheDocument()
  expect(request.mock.calls.filter(([route]) => route === 'enterprise.knowledge.unshare')).toHaveLength(2)
  expect(onUnshared).not.toHaveBeenCalled()
})

it('忙碌期间确认按钮禁用，重复点击不触发第二次请求', async () => {
  const user = userEvent.setup()
  const onUnshared = vi.fn()
  let resolveUnshare = () => {}
  request.mockImplementation(async (route) => {
    if (route === 'enterprise.knowledge.shares') return { shares: [] }
    if (route === 'enterprise.knowledge.upload_status') return null
    if (route === 'enterprise.knowledge.sync_status') return { state: 'shared', lastSyncedAt: null }
    if (route === 'enterprise.knowledge.unshare')
      return new Promise((resolve) => {
        resolveUnshare = () => resolve({ ok: true })
      })
    return {}
  })
  render(<KnowledgeSharingPanel baseId="orgkb:owned" localBaseId="local-1" onUnshared={onUnshared} />)
  await screen.findByText('No share codes')
  await user.click(screen.getByRole('button', { name: 'Cancel sharing' }))
  const confirm = await screen.findByRole('button', { name: 'Confirm unsharing' })
  await waitFor(() => expect(confirm).toBeEnabled())
  await user.click(confirm)
  await waitFor(() => expect(confirm).toBeDisabled())
  // 忙碌中重复点击（fireEvent 绕过 disabled）不应触发第二次请求，由 lock 兜底。
  fireEvent.click(confirm)
  expect(request.mock.calls.filter(([route]) => route === 'enterprise.knowledge.unshare')).toHaveLength(1)
  resolveUnshare()
  await waitFor(() => expect(onUnshared).toHaveBeenCalledTimes(1))
  expect(request.mock.calls.filter(([route]) => route === 'enterprise.knowledge.unshare')).toHaveLength(1)
})

it('活跃上传期间禁用取消分享确认', async () => {
  const user = userEvent.setup()
  request.mockImplementation(async (route) => {
    if (route === 'enterprise.knowledge.shares') return { shares: [] }
    if (route === 'enterprise.knowledge.upload_status')
      return {
        phase: 'uploading',
        totalBytes: 1,
        uploadedBytes: 0,
        completedFiles: 0,
        totalFiles: 1,
        currentFile: 'a',
        error: null
      }
    if (route === 'enterprise.knowledge.sync_status') return { state: 'shared', lastSyncedAt: null }
    return {}
  })
  render(<KnowledgeSharingPanel baseId="orgkb:owned" localBaseId="local-1" />)
  await screen.findByText('No share codes')
  await user.click(screen.getByRole('button', { name: 'Cancel sharing' }))
  const confirm = await screen.findByRole('button', { name: 'Confirm unsharing' })
  await waitFor(() => expect(confirm).toBeDisabled())
  expect(screen.getByText(/upload or sync is in progress/i)).toBeInTheDocument()
})

it('pending 同步状态不阻止取消分享确认（仅 syncing 视为活跃）', async () => {
  const user = userEvent.setup()
  request.mockImplementation(async (route) => {
    if (route === 'enterprise.knowledge.shares') return { shares: [] }
    if (route === 'enterprise.knowledge.upload_status') return null
    // pending 是已排队、尚未开始的待处理任务，不是进行中的同步，不应阻止取消分享。
    if (route === 'enterprise.knowledge.sync_status') return { state: 'pending', lastSyncedAt: null }
    if (route === 'enterprise.knowledge.unshare') return { ok: true }
    return {}
  })
  render(<KnowledgeSharingPanel baseId="orgkb:owned" localBaseId="local-1" />)
  await screen.findByText('No share codes')
  await user.click(screen.getByRole('button', { name: 'Cancel sharing' }))
  const confirm = await screen.findByRole('button', { name: 'Confirm unsharing' })
  await waitFor(() => expect(confirm).toBeEnabled())
  expect(screen.queryByText(/upload or sync is in progress/i)).not.toBeInTheDocument()
  await user.click(confirm)
  expect(await screen.findByText('No share codes')).toBeInTheDocument()
  expect(request).toHaveBeenCalledWith('enterprise.knowledge.unshare', { baseId: 'local-1' })
})

it('取消分享确认期间禁用生成码、刷新与吊销等竞争动作', async () => {
  const user = userEvent.setup()
  request.mockImplementation(async (route) => {
    if (route === 'enterprise.knowledge.shares')
      return {
        shares: [
          {
            id: 'orgkb:code',
            spaceId: 'orgkb:owned',
            shareCode: 'Abcd_123',
            hasPassword: false,
            shareType: 1,
            viewCount: 0,
            maxViews: null,
            expiresAt: null,
            revokedAt: null,
            createdAt: '2026-10-14T00:00:00Z'
          }
        ]
      }
    if (route === 'enterprise.knowledge.upload_status') return null
    if (route === 'enterprise.knowledge.sync_status') return { state: 'shared', lastSyncedAt: null }
    return {}
  })
  render(<KnowledgeSharingPanel baseId="orgkb:owned" localBaseId="local-1" name="资料" />)
  await screen.findByText('Abcd_123')
  const generate = screen.getByRole('button', { name: 'Generate share code' })
  const refresh = screen.getByRole('button', { name: 'Refresh' })
  const revoke = screen.getByRole('button', { name: 'Revoke code' })
  expect(generate).toBeEnabled()
  expect(refresh).toBeEnabled()
  expect(revoke).toBeEnabled()
  await user.click(screen.getByRole('button', { name: 'Cancel sharing' }))
  expect(await screen.findByRole('button', { name: 'Confirm unsharing' })).toBeInTheDocument()
  expect(generate).toBeDisabled()
  expect(refresh).toBeDisabled()
  expect(revoke).toBeDisabled()
  // 退出确认后恢复可用。
  await user.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(generate).toBeEnabled())
  expect(refresh).toBeEnabled()
  expect(revoke).toBeEnabled()
})

it('吊销确认期间禁用生成码、刷新与取消分享等竞争动作', async () => {
  const user = userEvent.setup()
  request.mockImplementation(async (route) => {
    if (route === 'enterprise.knowledge.shares')
      return {
        shares: [
          {
            id: 'orgkb:code',
            spaceId: 'orgkb:owned',
            shareCode: 'Abcd_123',
            hasPassword: false,
            shareType: 1,
            viewCount: 0,
            maxViews: null,
            expiresAt: null,
            revokedAt: null,
            createdAt: '2026-10-14T00:00:00Z'
          }
        ]
      }
    return {}
  })
  render(<KnowledgeSharingPanel baseId="orgkb:owned" localBaseId="local-1" name="资料" />)
  await screen.findByText('Abcd_123')
  const generate = screen.getByRole('button', { name: 'Generate share code' })
  const refresh = screen.getByRole('button', { name: 'Refresh' })
  const unshare = screen.getByRole('button', { name: 'Cancel sharing' })
  expect(generate).toBeEnabled()
  expect(refresh).toBeEnabled()
  expect(unshare).toBeEnabled()
  await user.click(screen.getByRole('button', { name: 'Revoke code' }))
  expect(await screen.findByRole('button', { name: 'Confirm revocation' })).toBeInTheDocument()
  expect(generate).toBeDisabled()
  expect(refresh).toBeDisabled()
  expect(unshare).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(generate).toBeEnabled())
  expect(refresh).toBeEnabled()
  expect(unshare).toBeEnabled()
})
