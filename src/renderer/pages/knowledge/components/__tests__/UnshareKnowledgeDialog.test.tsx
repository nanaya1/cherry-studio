import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { beforeEach, expect, it, vi } from 'vitest'

import UnshareKnowledgeDialog from '../UnshareKnowledgeDialog'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request } }))
vi.unmock('@cherrystudio/ui')
beforeEach(async () => {
  request.mockReset()
  await i18n.changeLanguage('en-us')
})

it('独立弹窗确认前不提交，成功关闭并刷新', async () => {
  const onClose = vi.fn()
  const onUnshared = vi.fn()
  request.mockResolvedValue({ ok: true })
  render(<UnshareKnowledgeDialog baseId="local-1" name="资料" onClose={onClose} onUnshared={onUnshared} />)
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Generate share code' })).not.toBeInTheDocument()
  expect(request).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Confirm unsharing' }))
  await waitFor(() => expect(onUnshared).toHaveBeenCalledTimes(1))
  expect(request).toHaveBeenCalledWith('enterprise.knowledge.unshare', { baseId: 'local-1' })
  expect(onClose).toHaveBeenCalled()
})

it('失败保留弹窗与错误并允许重试', async () => {
  const onClose = vi.fn()
  request.mockRejectedValueOnce(new Error('network failed')).mockResolvedValueOnce({ ok: true })
  render(<UnshareKnowledgeDialog baseId="local-1" onClose={onClose} onUnshared={vi.fn()} />)
  await userEvent.click(screen.getByRole('button', { name: 'Confirm unsharing' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('network failed')
  expect(onClose).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Confirm unsharing' }))
  await waitFor(() => expect(onClose).toHaveBeenCalled())
})
