import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { expect, it, vi } from 'vitest'

import KnowledgeUploadDetails from '../KnowledgeUploadDetails'
const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request } }))
vi.unmock('@cherrystudio/ui')
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
  expect(await screen.findByText('30 / 100 bytes · 30%')).toBeInTheDocument()
  bytes = 50
  expect(await screen.findByText('50 / 100 bytes · 50%')).toBeInTheDocument()
  await userEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)
  expect(close).toHaveBeenCalled()
  view.unmount()
  bytes = 70
  render(<KnowledgeUploadDetails baseId="base" name="库" onClose={close} />)
  expect(await screen.findByText('70 / 100 bytes · 70%')).toBeInTheDocument()
  expect(request.mock.calls.every(([route]) => route === 'enterprise.knowledge.upload_status')).toBe(true)
})
