import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { POPUP_EXIT_MS } from '@renderer/services/popup'

const mocks = vi.hoisted(() => ({
  ipcRequest: vi.fn(),
  loggerError: vi.fn(),
  openRoute: vi.fn(),
  showDoctor: vi.fn(),
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

vi.mock('@renderer/services/mainWindowNavigation', () => ({
  openRoute: (...args: unknown[]) => mocks.openRoute(...args)
}))

vi.mock('@renderer/services/toast', () => ({
  toast: { error: (...args: unknown[]) => mocks.toastError(...args) }
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}))

vi.mock('@renderer/components/doctor', () => ({
  DoctorPopup: { show: (...args: unknown[]) => mocks.showDoctor(...args) }
}))

import { FeedbackDialog, getFeedbackAgentRoute } from '../FeedbackDialog'

function ControlledFeedbackDialog() {
  const [open, setOpen] = useState(true)
  return <FeedbackDialog open={open} onOpenChange={setOpen} />
}

describe('FeedbackDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.ipcRequest.mockResolvedValue({ sessionId: 'feedback-session' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows diagnostics and Cherry Support while hiding the GitHub Issues entry', () => {
    render(<FeedbackDialog open onOpenChange={vi.fn()} />)

    const diagnostics = screen.getByRole('button', { name: /settings.about.feedback.diagnostics.title/ })
    const agent = screen.getByRole('button', { name: /settings.about.feedback.agent.title/ })
    const recommended = within(diagnostics).getByText('settings.about.feedback.recommended')

    expect(diagnostics.compareDocumentPosition(agent)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(screen.queryByRole('button', { name: /settings.about.feedback.github.title/ })).not.toBeInTheDocument()
    expect(recommended).toBeVisible()
  })

  it('creates an isolated feedback session before opening the Agent route', async () => {
    render(<ControlledFeedbackDialog />)

    fireEvent.click(screen.getByRole('button', { name: /settings.about.feedback.agent.title/ }))

    await waitFor(() => expect(mocks.ipcRequest).toHaveBeenCalledWith('ai.agent.support_session.create'))
    await waitFor(() => expect(mocks.openRoute).toHaveBeenCalledWith(getFeedbackAgentRoute('feedback-session')))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('closes before opening the shared problem-report panel', async () => {
    vi.useFakeTimers()
    render(<ControlledFeedbackDialog />)

    fireEvent.click(screen.getByRole('button', { name: /settings.about.feedback.diagnostics.title/ }))

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(mocks.showDoctor).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(POPUP_EXIT_MS)

    expect(mocks.showDoctor).toHaveBeenCalledWith({ initialPanel: 'report' })
  })

  it('reports feedback-session creation failures without opening an empty Agent route', async () => {
    mocks.ipcRequest.mockRejectedValue(new Error('restore failed'))
    render(<FeedbackDialog open onOpenChange={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /settings.about.feedback.agent.title/ }))

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('settings.about.feedback.agent_error'))
    expect(mocks.openRoute).not.toHaveBeenCalled()
  })

  // GitHub Issues interaction tests remain here for restoration when the entry is re-enabled.
})
