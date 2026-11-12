import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ButtonHTMLAttributes } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ipcApi } from '@renderer/ipc'

import IndustrialVideoWorkbench from './IndustrialVideoWorkbench'

const mocks = vi.hoisted(() => ({
  workbenchUrl: 'https://workbench.example/iv/session/s',
  record: { run: 'run-1', state: 'storyboard_submitted', unknownSubmissions: [], version: 1 },
  job: { status: 'blocked', progress: {} } as Record<string, unknown>,
  refresh: vi.fn()
}))

vi.mock('@renderer/ipc', () => ({ ipcApi: { request: vi.fn() } }))
vi.mock('@cherrystudio/ui', () => ({
  Button: ({ children, onClick, disabled }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}))
// 网页内部由服务端负责；渲染层只对 WebviewHost 做窄边界替身，断言真实 props。
vi.mock('@renderer/components/WebviewHost', () => ({
  WebviewHost: ({
    src,
    partition,
    testId,
    ariaLabel
  }: {
    src: string
    partition: string
    testId?: string
    ariaLabel?: string
  }) => (
    <div
      data-testid="workbench-guest"
      data-src={src}
      data-partition={partition}
      data-aria-label={ariaLabel}
      data-testid-attr={testId}
    />
  )
}))
vi.mock('./IndustrialVideoOnlinePreview', () => ({
  default: ({ finalPath }: { finalPath: string }) => <div data-testid="online-preview">{finalPath}</div>
}))

function makeProduction(record = mocks.record, job = mocks.job, error = '') {
  return {
    record,
    job,
    error,
    jobError: '',
    refresh: mocks.refresh
  } as never
}

describe('IndustrialVideoWorkbench', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.record = { run: 'run-1', state: 'storyboard_submitted', unknownSubmissions: [], version: 1 }
    mocks.job = { status: 'blocked', progress: {} }
    vi.mocked(ipcApi.request).mockImplementation(async (route) => {
      if (route === 'industrial_video.workbench_open')
        return { workbench_url: mocks.workbenchUrl, run: 'run-1', raw: {} } as never
      throw new Error(`意外调用 ${route}`)
    })
  })

  it('renders a clickable workbench link and no webview by default', () => {
    render(<IndustrialVideoWorkbench sessionId="s" production={makeProduction()} />)

    const open = screen.getByRole('button', { name: '打开服务端工作台' })
    expect(open).toBeInTheDocument()
    expect(screen.queryByTestId('workbench-guest')).not.toBeInTheDocument()
    // 不在新标签打开：不应有指向外的链接。
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('opens the server workbench inside the panel without a new tab and is not an iframe', async () => {
    const user = userEvent.setup()
    render(<IndustrialVideoWorkbench sessionId="s" production={makeProduction()} />)

    await user.click(screen.getByRole('button', { name: '打开服务端工作台' }))

    await waitFor(() =>
      expect(ipcApi.request).toHaveBeenCalledWith(
        'industrial_video.workbench_open',
        expect.objectContaining({ sessionId: 's', run: 'run-1' })
      )
    )
    const guest = await screen.findByTestId('workbench-guest')
    expect(guest).toHaveAttribute('data-src', mocks.workbenchUrl)
    // 独立安全 guest：专用 partition，不做持久化共享。
    expect(guest).toHaveAttribute('data-partition', 'industrial-video-workbench:s:run-1')
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('re-opening after the run changes uses the current run (no cross-run leak)', async () => {
    const user = userEvent.setup()
    const view = render(<IndustrialVideoWorkbench sessionId="s" production={makeProduction()} />)

    await user.click(screen.getByRole('button', { name: '打开服务端工作台' }))
    await waitFor(() =>
      expect(ipcApi.request).toHaveBeenCalledWith(
        'industrial_video.workbench_open',
        expect.objectContaining({ run: 'run-1' })
      )
    )
    // 收起后再以新 run 打开，必须携带当前 run，避免串 run。
    await user.click(screen.getByRole('button', { name: '收起工作台' }))
    vi.mocked(ipcApi.request).mockImplementation(async (route) => {
      if (route === 'industrial_video.workbench_open')
        return { workbench_url: 'https://workbench.example/iv/run2', run: 'run-2', raw: {} } as never
      throw new Error(`意外调用 ${route}`)
    })
    mocks.record = { ...mocks.record, run: 'run-2' }
    view.rerender(<IndustrialVideoWorkbench sessionId="s" production={makeProduction(mocks.record)} />)
    await user.click(screen.getByRole('button', { name: '打开服务端工作台' }))
    await waitFor(() =>
      expect(ipcApi.request).toHaveBeenCalledWith(
        'industrial_video.workbench_open',
        expect.objectContaining({ run: 'run-2' })
      )
    )
    expect(await screen.findByTestId('workbench-guest')).toHaveAttribute(
      'data-src',
      'https://workbench.example/iv/run2'
    )
  })

  it('keeps the finished-video online preview available and hides it only while the workbench is open', async () => {
    const user = userEvent.setup()
    mocks.job = {
      status: 'done',
      progress: { final: 'output/final.mp4', preview_url: 'https://video.example/preview?sig=x' }
    }
    const view = render(<IndustrialVideoWorkbench sessionId="s" production={makeProduction(mocks.record, mocks.job)} />)

    expect(screen.getByTestId('online-preview')).toHaveTextContent('output/final.mp4')

    await user.click(screen.getByRole('button', { name: '打开服务端工作台' }))
    await screen.findByTestId('workbench-guest')
    expect(screen.queryByTestId('online-preview')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '收起工作台' }))
    expect(await screen.findByTestId('online-preview')).toHaveTextContent('output/final.mp4')
    void view
  })

  it('removes the previous guest immediately when the task changes', async () => {
    const user = userEvent.setup()
    const view = render(<IndustrialVideoWorkbench sessionId="s" production={makeProduction()} />)
    await user.click(screen.getByRole('button', { name: '打开服务端工作台' }))
    await screen.findByTestId('workbench-guest')
    view.rerender(<IndustrialVideoWorkbench sessionId="other" production={makeProduction({ ...mocks.record, run: 'other-run' })} />)
    expect(screen.queryByTestId('workbench-guest')).not.toBeInTheDocument()
  })

  it('rejects links containing credentials', async () => {
    vi.mocked(ipcApi.request).mockResolvedValueOnce({ workbench_url: 'https://user:secret@example.com/', run: 'run-1' })
    const user = userEvent.setup()
    render(<IndustrialVideoWorkbench sessionId="s" production={makeProduction()} />)
    await user.click(screen.getByRole('button', { name: '打开服务端工作台' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('工作台链接无效')
    expect(screen.queryByTestId('workbench-guest')).not.toBeInTheDocument()
  })

  it('shows an error and opens no webview when the workbench cannot be opened', async () => {
    const user = userEvent.setup()
    vi.mocked(ipcApi.request).mockRejectedValueOnce(new Error('工作台暂不可用'))
    render(<IndustrialVideoWorkbench sessionId="s" production={makeProduction()} />)

    await user.click(screen.getByRole('button', { name: '打开服务端工作台' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('工作台暂不可用')
    expect(screen.queryByTestId('workbench-guest')).not.toBeInTheDocument()
    expect(ipcApi.request).not.toHaveBeenCalledWith('industrial_video.video_start', expect.anything())
  })
})
