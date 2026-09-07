import '@testing-library/jest-dom/vitest'

import type { OutputFor } from '@shared/ipc/types'
import { AbsoluteFilePathSchema } from '@shared/types/file'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loggerError: vi.fn(),
  request: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock('@renderer/ipc', () => ({
  ipcApi: { request: mocks.request }
}))

vi.mock('@renderer/services/LoggerService', () => ({
  loggerService: { withContext: () => ({ error: mocks.loggerError }) }
}))

vi.mock('@renderer/services/toast', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess }
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === 'settings.about.diagnostics.mail.subject') return `Diagnostics ${values?.bundleId}`
      if (key === 'settings.about.diagnostics.mail.body') {
        return [
          `ID ${values?.bundleId}`,
          `Version ${values?.version}`,
          `Platform ${values?.platform}`,
          `Range ${values?.range}`,
          `File ${values?.fileName}`
        ].join('\n')
      }
      if (key === 'settings.about.diagnostics.sources.message_summary') {
        return `${values?.count} messages, about ${values?.size}`
      }
      return key
    }
  })
}))

import DiagnosticBundleDialog from '../DiagnosticBundleDialog'

const inspectResult: OutputFor<'diagnostics.bundle.inspect'> = {
  hasWarnings: false,
  sourceLimitBytes: 50 * 1024 * 1024,
  sources: {
    chatRecords: { available: true, estimatedBytes: 4_096, messageCount: 4 },
    crashDumps: { fileCount: 1 },
    logs: { available: true, estimatedBytes: 1_024, fileCount: 2 },
    traces: { available: true, estimatedBytes: 2_048, fileCount: 3 }
  }
}

const savedResult: Extract<OutputFor<'diagnostics.bundle.export'>, { status: 'saved' }> = {
  archiveBytes: 2_000,
  bundleId: 'bundle-123',
  fileName: 'cherry-studio-diagnostics.zip',
  filePath: AbsoluteFilePathSchema.parse('/tmp/cherry-studio-diagnostics.zip'),
  hasWarnings: false,
  includedFileCount: 2,
  omittedFileCount: 0,
  status: 'saved'
}

const chatRecordsSwitchName = /^settings\.about\.diagnostics\.sources\.chat_records\.title /
const logsSwitchName = /^settings\.about\.diagnostics\.sources\.logs\.title /
const tracesSwitchName = /^settings\.about\.diagnostics\.sources\.traces\.title /

function renderDialog() {
  render(<DiagnosticBundleDialog appVersion="2.0.0" open onOpenChange={vi.fn()} />)
}

async function confirmSensitiveExport(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'settings.about.diagnostics.actions.export' }))
  const confirmation = screen.getAllByRole('dialog').at(-1)!
  const checkbox = within(confirmation).getByRole('checkbox')
  const confirmButton = within(confirmation).getByRole('button', {
    name: 'settings.about.diagnostics.actions.export'
  })
  await user.click(checkbox)
  await user.click(confirmButton)
}

describe('DiagnosticBundleDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('electron', { process: { platform: 'darwin' } })
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'diagnostics.bundle.inspect') return inspectResult
      if (route === 'diagnostics.bundle.export') return savedResult
      return undefined
    })
  })

  it('shows sensitive data confirmation only after export is requested', async () => {
    const user = userEvent.setup()
    renderDialog()

    await waitFor(() => expect(mocks.request).toHaveBeenCalledWith('diagnostics.bundle.inspect', { range: '24h' }))
    expect(screen.getByRole('switch', { name: logsSwitchName })).toBeChecked()
    expect(screen.getByRole('switch', { name: tracesSwitchName })).toBeChecked()
    expect(screen.getByRole('switch', { name: chatRecordsSwitchName })).not.toBeChecked()
    expect(screen.getByText('4 messages, about 4.0 KB')).toBeInTheDocument()
    expect(screen.queryByText('settings.about.diagnostics.privacy.title')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()

    const exportButton = screen.getByRole('button', { name: 'settings.about.diagnostics.actions.export' })
    expect(exportButton).toBeEnabled()
    await user.click(exportButton)

    const confirmation = screen.getAllByRole('dialog').at(-1)!
    expect(within(confirmation).getByText('settings.about.diagnostics.privacy.title')).toBeInTheDocument()
    const checkbox = within(confirmation).getByRole('checkbox')
    // Alignment is the regression contract: the consent control and its label share one vertical center.
    expect(checkbox.closest('label')).toHaveClass('items-center')
    expect(checkbox).not.toHaveClass('mt-0.5')
    const confirmButton = within(confirmation).getByRole('button', {
      name: 'settings.about.diagnostics.actions.export'
    })
    expect(confirmButton).toBeDisabled()
    expect(mocks.request.mock.calls.filter(([route]) => route === 'diagnostics.bundle.export')).toHaveLength(0)

    await user.click(checkbox)
    expect(confirmButton).toBeEnabled()
    await user.click(confirmButton)
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith('diagnostics.bundle.export', {
        includeChatRecords: false,
        includeLogs: true,
        includeTraces: true,
        range: '24h'
      })
    )
    expect(await screen.findByText('settings.about.diagnostics.success.title')).toBeInTheDocument()
  })

  it('requires consent and exports chat history when it is the only selected sensitive source', async () => {
    const user = userEvent.setup()
    renderDialog()

    await screen.findByText('settings.about.diagnostics.sources.chat_records.title')
    await user.click(screen.getByRole('switch', { name: logsSwitchName }))
    await user.click(screen.getByRole('switch', { name: tracesSwitchName }))
    await user.click(screen.getByRole('switch', { name: chatRecordsSwitchName }))

    await user.click(screen.getByRole('button', { name: 'settings.about.diagnostics.actions.export' }))
    const confirmation = screen.getAllByRole('dialog').at(-1)!
    const consent = within(confirmation).getByRole('checkbox')
    expect(consent).not.toBeChecked()
    await user.click(consent)
    await user.click(within(confirmation).getByRole('button', { name: 'settings.about.diagnostics.actions.export' }))

    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith('diagnostics.bundle.export', {
        includeChatRecords: true,
        includeLogs: false,
        includeTraces: false,
        range: '24h'
      })
    )
  })

  it('reveals the saved bundle in the local folder', async () => {
    const user = userEvent.setup()
    renderDialog()
    await screen.findByText('settings.about.diagnostics.sources.logs.title')
    await confirmSensitiveExport(user)
    await screen.findByText('settings.about.diagnostics.success.title')

    await user.click(screen.getByRole('button', { name: 'settings.about.diagnostics.actions.reveal' }))
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith('file.show_in_folder', {
        kind: 'path',
        path: '/tmp/cherry-studio-diagnostics.zip'
      })
    )
    // 联系支持入口已隐藏（见实现中的注释），不再发起 mailto 请求。
    expect(mocks.request).not.toHaveBeenCalledWith('system.shell.open_website', expect.stringMatching(/^mailto:/))
  })

  it('allows a system-only export without consent when no optional sources are available', async () => {
    const user = userEvent.setup()
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'diagnostics.bundle.inspect') {
        return {
          ...inspectResult,
          sources: {
            ...inspectResult.sources,
            chatRecords: { available: false, estimatedBytes: 0, messageCount: 0 },
            logs: { available: false, estimatedBytes: 0, fileCount: 0 },
            traces: { available: false, estimatedBytes: 0, fileCount: 0 }
          }
        }
      }
      if (route === 'diagnostics.bundle.export') return { status: 'canceled' }
      return undefined
    })
    renderDialog()

    await waitFor(() => expect(screen.getByRole('switch', { name: logsSwitchName })).toBeDisabled())
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    const exportButton = screen.getByRole('button', { name: 'settings.about.diagnostics.actions.export' })
    expect(exportButton).toBeEnabled()
    await user.click(exportButton)

    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith('diagnostics.bundle.export', {
        includeChatRecords: false,
        includeLogs: false,
        includeTraces: false,
        range: '24h'
      })
    )
  })

  it('shows a warning when the saved bundle is incomplete', async () => {
    const user = userEvent.setup()
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'diagnostics.bundle.inspect') return inspectResult
      if (route === 'diagnostics.bundle.export') {
        return { ...savedResult, hasWarnings: true }
      }
      return undefined
    })
    renderDialog()
    await screen.findByText('settings.about.diagnostics.sources.logs.title')

    await confirmSensitiveExport(user)

    expect(await screen.findByText('settings.about.diagnostics.warning')).toBeInTheDocument()
  })

  it('prevents duplicate exports and requires fresh consent after a canceled attempt', async () => {
    const user = userEvent.setup()
    let resolveExport: (value: { status: 'canceled' }) => void = () => undefined
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'diagnostics.bundle.inspect') return inspectResult
      if (route === 'diagnostics.bundle.export') {
        return new Promise((resolve) => {
          resolveExport = resolve
        })
      }
      return undefined
    })
    renderDialog()
    await screen.findByText('settings.about.diagnostics.sources.logs.title')

    const exportButton = screen.getByRole('button', { name: 'settings.about.diagnostics.actions.export' })
    await user.click(exportButton)
    const confirmation = screen.getAllByRole('dialog').at(-1)!
    const consent = within(confirmation).getByRole('checkbox')
    const confirmButton = within(confirmation).getByRole('button', {
      name: 'settings.about.diagnostics.actions.export'
    })
    await user.click(consent)
    await user.click(confirmButton)
    await user.click(confirmButton)

    await waitFor(() =>
      expect(mocks.request.mock.calls.filter(([route]) => route === 'diagnostics.bundle.export')).toHaveLength(1)
    )
    await act(async () => resolveExport({ status: 'canceled' }))
    await waitFor(() => expect(exportButton).toBeEnabled())

    await user.click(exportButton)
    const nextConfirmation = screen.getAllByRole('dialog').at(-1)!
    expect(within(nextConfirmation).getByRole('checkbox')).not.toBeChecked()
    expect(
      within(nextConfirmation).getByRole('button', { name: 'settings.about.diagnostics.actions.export' })
    ).toBeDisabled()
  })

  it('does not offer the copy-email fallback because the support entry is hidden', async () => {
    // 「联系 Cherry 支持」与「复制邮箱」兜底入口均已随 Cherry 厂商云隐藏而移除。
    const user = userEvent.setup()
    const clipboardWrite = vi.spyOn(navigator.clipboard, 'writeText')
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'diagnostics.bundle.inspect') return inspectResult
      if (route === 'diagnostics.bundle.export') return savedResult
      if (route === 'system.shell.open_website') throw new Error('No mail client')
      return undefined
    })
    renderDialog()
    await screen.findByText('settings.about.diagnostics.sources.logs.title')
    await confirmSensitiveExport(user)
    await screen.findByText('settings.about.diagnostics.success.title')

    expect(screen.queryByRole('button', { name: 'settings.about.diagnostics.actions.contact' })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'settings.about.diagnostics.actions.copy_email' })
    ).not.toBeInTheDocument()
    expect(clipboardWrite).not.toHaveBeenCalledWith('support@cherry-ai.com')
  })
})
