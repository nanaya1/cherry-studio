import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { expect, it, vi } from 'vitest'

import KnowledgeUploadDetails from '../KnowledgeUploadDetails'
const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request } }))
vi.unmock('@cherrystudio/ui')
it.each(['cleanup_pending', 'cleanup_unknown'])('%s 显示清理提示且不提供旧续传操作', async (phase) => {
  await i18n.changeLanguage('en-us')
  request.mockImplementation(async () => ({
    phase,
    totalBytes: 0,
    uploadedBytes: 0,
    completedFiles: 0,
    totalFiles: 1,
    currentFile: null,
    error: null
  }))
  render(<KnowledgeUploadDetails baseId="base" name="库" onClose={() => {}} />)
  expect(
    await screen.findByText(
      phase === 'cleanup_pending'
        ? 'First share failed. Cloud cleanup pending.'
        : 'Cloud cleanup result unknown. Contact an administrator.'
    )
  ).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: i18n.t('knowledge.org.upload_continue') })).not.toBeInTheDocument()
})
it('关闭上传详情不会取消，重新打开读取持续上传状态', async () => {
  await i18n.changeLanguage('en-us')
  let bytes = 30
  request.mockImplementation(async (route) =>
    route === 'enterprise.knowledge.upload_status'
      ? {
          phase: 'uploading',
          totalBytes: 100,
          uploadedBytes: bytes,
          completedFiles: 0,
          totalFiles: 1,
          currentFile: 'large.pdf',
          error: null
        }
      : undefined
  )
  const close = vi.fn()
  const view = render(<KnowledgeUploadDetails baseId="base" name="库" onClose={close} />)
  // expect(await screen.findByText('30 / 100 bytes · 30%')).toBeInTheDocument()
  expect(await screen.findByRole('progressbar')).toHaveAttribute('value', '30')
  expect(screen.queryByText('30 / 100 bytes · 30%')).not.toBeInTheDocument()
  expect(screen.queryByText(i18n.t('knowledge.org.upload_limitations'))).not.toBeInTheDocument()
  bytes = 50
  // expect(await screen.findByText('50 / 100 bytes · 50%')).toBeInTheDocument()
  await vi.waitFor(() => expect(screen.getByRole('progressbar')).toHaveAttribute('value', '50'))
  await userEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)
  expect(close).toHaveBeenCalled()
  view.unmount()
  bytes = 70
  render(<KnowledgeUploadDetails baseId="base" name="库" onClose={close} />)
  // expect(await screen.findByText('70 / 100 bytes · 70%')).toBeInTheDocument()
  expect(await screen.findByRole('progressbar')).toHaveAttribute('value', '70')
  expect(request.mock.calls.every(([route]) => route === 'enterprise.knowledge.upload_status')).toBe(true)
})
