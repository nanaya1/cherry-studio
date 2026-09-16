import '@testing-library/jest-dom/vitest'

// fireEvent / waitFor 随 GitHub 反馈入口点击断言一起停用，恢复时改回。
// import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { render, screen } from '@testing-library/react'
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

  it('shows an empty dialog while both entries are hidden', () => {
    // 「发送诊断报告」（→ api.cherry-ai.com）与「GitHub 反馈」（→ CherryHQ issues）入口均已暂时隐藏，
    // 对话框只剩标题骨架；恢复时改回入口断言（见 git 历史）。
    render(<FeedbackDialog open onOpenChange={vi.fn()} />)

    expect(screen.getByText('settings.about.feedback.dialog.title')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /settings.about.feedback.github.title/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /settings.about.feedback.diagnostics.title/ })).not.toBeInTheDocument()
    expect(screen.queryByText('settings.about.feedback.recommended')).not.toBeInTheDocument()
  })

  it('uses the shared large dialog size', () => {
    render(<FeedbackDialog open onOpenChange={vi.fn()} />)

    expect(screen.getByTestId('dialog-content')).toHaveAttribute('data-size', 'lg')
  })

  it('does not render the diagnostic upload dialog while the entry is hidden', () => {
    render(<ControlledFeedbackDialog />)

    expect(screen.queryByText('diagnostic-upload-dialog')).not.toBeInTheDocument()
    expect(mocks.ipcRequest).not.toHaveBeenCalledWith('diagnostics.bundle.upload', expect.anything())
  })

  it('never opens the GitHub issue chooser while the entry is hidden', async () => {
    // 「GitHub 反馈」入口暂时隐藏，任何交互都不应触发 open_website（原点击断言见 git 历史）。
    render(<ControlledFeedbackDialog />)

    expect(mocks.ipcRequest).not.toHaveBeenCalledWith('system.shell.open_website', FEEDBACK_GITHUB_URL)
  })
})
