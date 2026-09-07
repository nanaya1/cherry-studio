import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/services/popup', async (importOriginal) => await importOriginal())

vi.mock('@renderer/components/popups/ContentPopup', async () => {
  const React = await import('react')
  const { createPopup } = await import('@renderer/services/popup')
  const ContentPopup = createPopup<{ content: ReactNode; title?: ReactNode }, void>(({ content, open, title }) =>
    open ? React.createElement('div', { role: 'dialog' }, title, content) : null
  )
  return { default: ContentPopup }
})

const mocks = vi.hoisted(() => ({
  diagnoseError: vi.fn()
}))

const translations: Record<string, string> = {
  'common.copy': 'Copy',
  'error.diagnosis.ai_button': 'AI diagnosis',
  'error.diagnosis.ai_done': 'AI diagnosis complete',
  'error.diagnosis.ai_loading': 'Diagnosing',
  'error.diagnosis.ai_result': 'AI diagnosis',
  'error.diagnostic_report.action': 'Submit diagnostic report',
  'error.diagnostic_report.location': 'Location',
  'error.message': 'Error message',
  'error.modelId': 'Model',
  'error.name': 'Error name',
  'error.provider': 'Provider',
  'error.stack': 'Stack',
  'error.statusCode': 'Status code',
  'message.copied': 'Copied'
}

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ warn: vi.fn() }) }
}))

vi.mock('@renderer/utils/errorDiagnosis', () => ({ diagnoseError: mocks.diagnoseError }))

vi.mock('@renderer/i18n/resolver', () => ({ default: { t: (key: string) => translations[key] ?? key } }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en-US' },
    t: (key: string) => translations[key] ?? key
  })
}))

vi.mock('@renderer/components/feedback/DiagnosticUploadDialog', () => {
  return {
    default: ({
      fixedRange,
      initialDescription,
      onOpenChange,
      open
    }: {
      fixedRange?: string
      initialDescription?: string
      onOpenChange: (open: boolean) => void
      open: boolean
    }) =>
      open ? (
        <div role="dialog" aria-label="Diagnostic report review" data-fixed-range={fixedRange}>
          <pre>{initialDescription}</pre>
          <button type="button" onClick={() => onOpenChange(false)}>
            Cancel report
          </button>
        </div>
      ) : null
  }
})

import { PopupHost } from '@renderer/components/PopupHost'
import { POPUP_EXIT_MS, popupService } from '@renderer/services/popup'

const { ErrorDetailContent, showErrorDetailPopup } = await import('../ErrorDetailModal')

Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })

describe('ErrorDetailContent diagnostic report', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    vi.useFakeTimers()
    await act(async () => {
      for (const entry of [...popupService.getSnapshot()]) {
        popupService.settle(entry.instanceId, undefined)
      }
      vi.advanceTimersByTime(POPUP_EXIT_MS)
    })
    vi.useRealTimers()
  })

  // 暂时下线「提交诊断报告」入口（ErrorDetailModal.tsx 内已注释）：签名依赖构建期
  // MAIN_VITE_CHERRYAI_CLIENT_SECRET，本地构建未注入时点击即抛错。恢复入口时同步恢复这三个测试。
  it('hides the report action even with a configured handoff while the entry is disabled', async () => {
    const onOpenDiagnosticReport = vi.fn()
    const { rerender } = render(
      <ErrorDetailContent error={{ name: 'ProviderError', message: 'failed', stack: null }} />
    )

    expect(screen.queryByRole('button', { name: 'Submit diagnostic report' })).not.toBeInTheDocument()

    rerender(
      <ErrorDetailContent
        diagnosticReport={{ location: 'Home conversation' }}
        error={{ name: 'ProviderError', message: 'failed', stack: null }}
        onOpenDiagnosticReport={onOpenDiagnosticReport}
      />
    )

    expect(screen.queryByRole('button', { name: 'Submit diagnostic report' })).not.toBeInTheDocument()
    expect(onOpenDiagnosticReport).not.toHaveBeenCalled()
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Copy', 'AI diagnosis'])
  })

  it('does not open report review from the error popup while the entry is disabled', async () => {
    vi.useFakeTimers()
    render(<PopupHost />)

    act(() => {
      showErrorDetailPopup({
        diagnosticReport: { location: 'Home conversation' },
        error: { name: 'ProviderError', message: 'failed', stack: null }
      })
    })
    await act(async () => {})

    expect(screen.queryByRole('button', { name: 'Submit diagnostic report' })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Diagnostic report review' })).not.toBeInTheDocument()
  })

  it('keeps AI diagnosis visible in error details', async () => {
    const user = userEvent.setup()
    const onOpenDiagnosticReport = vi.fn()
    mocks.diagnoseError.mockResolvedValueOnce({
      category: 'runtime',
      explanation: 'Leaked prompt: private diagnosis payload.',
      steps: [],
      summary: 'Provider failed'
    })

    render(
      <ErrorDetailContent
        blockId="message-1-part-0"
        diagnosticReport={{ location: 'Agent conversation' }}
        error={{ name: 'ProviderError', message: 'failed', stack: null }}
        onDiagnosisComplete={vi.fn()}
        onOpenDiagnosticReport={onOpenDiagnosticReport}
      />
    )

    await user.click(screen.getByRole('button', { name: 'AI diagnosis' }))
    expect(await screen.findByText('Leaked prompt: private diagnosis payload.')).toBeInTheDocument()
    expect(onOpenDiagnosticReport).not.toHaveBeenCalled()
  })
})
