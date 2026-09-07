import '@testing-library/jest-dom/vitest'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ipcRequest: vi.fn(),
  loggerError: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ error: mocks.loggerError }) }
}))

vi.mock('@renderer/ipc', () => ({
  ipcApi: {
    request: (...args: unknown[]) => mocks.ipcRequest(...args)
  }
}))

vi.mock('@renderer/services/toast', () => ({
  toast: { error: (...args: unknown[]) => mocks.toastError(...args) }
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

vi.mock('@renderer/components/feedback/DiagnosticUploadDialog', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div role="dialog">diagnostic-upload-dialog</div> : null)
}))

import { FEEDBACK_GITHUB_URL, FeedbackDialog } from '../FeedbackDialog'

function ControlledFeedbackDialog() {
  const [open, setOpen] = useState(true)
  return <FeedbackDialog open={open} onOpenChange={setOpen} />
}

describe('FeedbackDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.ipcRequest.mockResolvedValue({ sessionId: 'feedback-session' })
  })

  it('shows only the GitHub option while the diagnostics entry is hidden', () => {
    // 「发送诊断报告」（上传 api.cherry-ai.com，Cherry 厂商云）入口暂时隐藏，恢复时改回双入口断言（见 git 历史）。
    render(<FeedbackDialog open onOpenChange={vi.fn()} />)

    expect(screen.getByRole('button', { name: /settings.about.feedback.github.title/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /settings.about.feedback.diagnostics.title/ })).not.toBeInTheDocument()
    expect(screen.queryByText('settings.about.feedback.recommended')).not.toBeInTheDocument()
  })

  it('uses the shared large dialog size with inset, spacious options', () => {
    render(<FeedbackDialog open onOpenChange={vi.fn()} />)

    expect(screen.getByTestId('dialog-content')).toHaveAttribute('data-size', 'lg')
    expect(screen.getByRole('list')).toHaveClass('gap-3', 'px-2')
  })

  it('does not render the diagnostic upload dialog while the entry is hidden', () => {
    render(<ControlledFeedbackDialog />)

    expect(screen.queryByText('diagnostic-upload-dialog')).not.toBeInTheDocument()
    expect(mocks.ipcRequest).not.toHaveBeenCalledWith('diagnostics.bundle.upload', expect.anything())
  })

  it('opens the GitHub issue chooser', async () => {
    render(<FeedbackDialog open onOpenChange={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /settings.about.feedback.github.title/ }))

    await waitFor(() => expect(mocks.ipcRequest).toHaveBeenCalledWith('system.shell.open_website', FEEDBACK_GITHUB_URL))
  })

  it('closes before reporting GitHub issue chooser failures', async () => {
    mocks.ipcRequest.mockImplementation((route: string) => {
      if (route === 'system.shell.open_website') {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        return Promise.reject(new Error('open failed'))
      }
      return Promise.resolve({ sessionId: 'feedback-session' })
    })
    render(<ControlledFeedbackDialog />)

    fireEvent.click(screen.getByRole('button', { name: /settings.about.feedback.github.title/ }))

    await waitFor(() =>
      expect(mocks.loggerError).toHaveBeenCalledWith('Failed to open GitHub issue chooser', expect.any(Error))
    )
    expect(mocks.toastError).toHaveBeenCalledWith('settings.about.feedback.github.error')
  })
})
