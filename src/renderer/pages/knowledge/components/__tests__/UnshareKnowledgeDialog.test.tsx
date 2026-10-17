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
  request.mockResolvedValueOnce({ restored: 1, missing: [] }).mockResolvedValueOnce({ ok: true })
  render(<UnshareKnowledgeDialog baseId="local-1" name="资料" onClose={onClose} onUnshared={onUnshared} />)
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Generate share code' })).not.toBeInTheDocument()
  expect(request).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Restore and check local files' }))
  await screen.findByText('1 items saved locally.')
  expect(screen.getByRole('button', { name: 'Confirm unsharing' })).toBeDisabled()
  await userEvent.click(screen.getByRole('checkbox'))
  await userEvent.click(screen.getByRole('button', { name: 'Confirm unsharing' }))
  await waitFor(() => expect(onUnshared).toHaveBeenCalledTimes(1))
  expect(request).toHaveBeenCalledWith('enterprise.knowledge.unshare', {
    baseId: 'local-1',
    confirmMissing: false,
    confirmDevicesStopped: true
  })
  expect(onClose).toHaveBeenCalled()
})

it('删除明确确认设备影响后直接提交，不请求恢复预检', async () => {
  request.mockResolvedValueOnce({ ok: true })
  render(<UnshareKnowledgeDialog baseId="orgkb:remote" deleteLocal onClose={vi.fn()} onUnshared={vi.fn()} />)
  expect(screen.queryByRole('button', { name: 'Restore and check local files' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled()
  expect(request).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('checkbox'))
  await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('enterprise.knowledge.unshare', {
      baseId: 'orgkb:remote',
      confirmMissing: false,
      confirmDevicesStopped: true,
      deleteLocal: true
    })
  )
})

it('失败保留弹窗与错误并允许重试', async () => {
  const onClose = vi.fn()
  request
    .mockRejectedValueOnce(new Error('network failed'))
    .mockResolvedValueOnce({ restored: 0, missing: [] })
    .mockResolvedValueOnce({ ok: true })
  render(<UnshareKnowledgeDialog baseId="local-1" onClose={onClose} onUnshared={vi.fn()} />)
  await userEvent.click(screen.getByRole('button', { name: 'Restore and check local files' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('network failed')
  expect(onClose).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Restore and check local files' }))
  await screen.findByRole('checkbox')
  await userEvent.click(screen.getByRole('checkbox'))
  await userEvent.click(screen.getByRole('button', { name: 'Confirm unsharing' }))
  await waitFor(() => expect(onClose).toHaveBeenCalled())
})
