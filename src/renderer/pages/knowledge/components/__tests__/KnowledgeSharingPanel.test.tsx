import { render, screen } from '@testing-library/react'
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
