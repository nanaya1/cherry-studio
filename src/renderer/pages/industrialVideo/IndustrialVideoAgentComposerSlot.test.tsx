import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import IndustrialVideoAgentComposerSlot from './IndustrialVideoAgentComposerSlot'

const state = vi.hoisted(() => ({
  record: null as {
    state: string
    unknownSubmissions: unknown[]
    control?: { phase: string; stopRequested: boolean; epoch?: number }
  } | null,
  job: null as { status: string } | null,
  error: '',
  refresh: vi.fn().mockResolvedValue(undefined)
}))
const request = vi.hoisted(() => vi.fn())
vi.mock('@renderer/ipc', () => ({ ipcApi: { request } }))
vi.mock('./useIndustrialVideoProduction', () => ({ useIndustrialVideoProduction: () => state }))
vi.mock('../agents/AgentComposerSlot', () => ({
  default: ({
    sendDisabled,
    taskBusy,
    taskStopping,
    stop
  }: ComponentProps<typeof IndustrialVideoAgentComposerSlot>) => (
    <>
      <button type="button" disabled={sendDisabled}>
        send
      </button>
      {taskBusy && (
        <button type="button" disabled={taskStopping} onClick={() => void stop()}>
          stop
        </button>
      )}
    </>
  )
}))

const baseProps: ComponentProps<typeof IndustrialVideoAgentComposerSlot> = {
  sessionId: 'video-1',
  session: { id: 'video-1' } as ComponentProps<typeof IndustrialVideoAgentComposerSlot>['session'],
  isStreaming: false,
  isMultiSelectMode: false,
  sendDisabled: false,
  stop: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn(),
  resendEditedMessage: vi.fn(),
  cancelEditing: vi.fn(),
  composerContext: {}
}

describe('industrial video server execution guard', () => {
  beforeEach(() => {
    state.record = { state: 'storyboard_submitted', unknownSubmissions: [] }
    state.job = null
    state.error = ''
    state.refresh.mockClear()
    request.mockReset().mockResolvedValue({ epoch: 1, phase: 'stopped', stopRequested: true })
  })

  it('先持久化停止门禁再中断 Agent，等待时禁止连点', async () => {
    let resolveGate!: (value: unknown) => void
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveGate = resolve
        })
    )
    state.job = { status: 'running' }
    const stop = vi.fn().mockResolvedValue(undefined)
    render(<IndustrialVideoAgentComposerSlot {...baseProps} stop={stop} />)
    const pause = await screen.findByRole('button', { name: 'stop' })
    fireEvent.click(pause)
    fireEvent.click(pause)
    expect(request).toHaveBeenCalledExactlyOnceWith('industrial_video.stop', { sessionId: 'video-1' })
    expect(stop).not.toHaveBeenCalled()
    expect(pause).toBeDisabled()
    await act(async () => resolveGate({ epoch: 1, phase: 'reconcile_required', stopRequested: true }))
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
    expect(state.refresh.mock.calls.length).toBeGreaterThan(1)
    expect(screen.getByRole('button', { name: 'send' })).toBeDisabled()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'stop' })).not.toBeInTheDocument())
  })

  it.each(['ipc', 'agent'])('停止 %s 失败仍阻塞发送并刷新状态', async (failure) => {
    state.job = { status: 'running' }
    const stop = vi.fn().mockResolvedValue(undefined)
    if (failure === 'ipc') request.mockRejectedValueOnce(new Error('offline'))
    else stop.mockRejectedValueOnce(new Error('abort failed'))
    const props = { ...baseProps, stop }
    const { rerender } = render(<IndustrialVideoAgentComposerSlot {...props} />)
    fireEvent.click(await screen.findByRole('button', { name: 'stop' }))
    await waitFor(() => expect(state.refresh.mock.calls.length).toBeGreaterThan(1))
    if (failure === 'ipc') expect(stop).not.toHaveBeenCalled()
    state.job = null
    rerender(<IndustrialVideoAgentComposerSlot {...props} />)
    expect(screen.getByRole('button', { name: 'send' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'stop' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'stop' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'send' })).toBeEnabled())
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('审核返回修改并释放轮次后，暂停消失且允许发送修改意见', async () => {
    state.record = {
      state: 'storyboard_submitted',
      unknownSubmissions: [],
      control: { phase: 'active', stopRequested: false }
    }
    const { rerender } = render(<IndustrialVideoAgentComposerSlot {...baseProps} />)
    await screen.findByRole('button', { name: 'stop' })
    expect(screen.getByRole('button', { name: 'send' })).toBeDisabled()
    state.record.control!.phase = 'idle'
    rerender(<IndustrialVideoAgentComposerSlot {...baseProps} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'send' })).toBeEnabled())
    expect(screen.queryByRole('button', { name: 'stop' })).not.toBeInTheDocument()
  })

  it('已完成的 active 记录不再阻塞后续发送', async () => {
    state.record = { state: 'done', unknownSubmissions: [], control: { phase: 'active', stopRequested: false } }
    render(<IndustrialVideoAgentComposerSlot {...baseProps} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'send' })).toBeEnabled())
    expect(screen.queryByRole('button', { name: 'stop' })).not.toBeInTheDocument()
  })

  it('停止待对账显示禁用发送按钮，已核实 stopped 才允许发送', async () => {
    state.record!.control = { phase: 'reconcile_required', stopRequested: true }
    const props = { sessionId: 'video-1', isStreaming: false } as ComponentProps<
      typeof IndustrialVideoAgentComposerSlot
    >
    const { rerender } = render(<IndustrialVideoAgentComposerSlot {...props} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'send' })).toBeDisabled())
    expect(screen.queryByRole('button', { name: 'stop' })).not.toBeInTheDocument()
    state.record!.control = { phase: 'stopped', stopRequested: true }
    rerender(<IndustrialVideoAgentComposerSlot {...props} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'send' })).toBeEnabled())
  })
  it('blocks server generation and unknown outcomes even when Agent is idle, allowing review only', async () => {
    const props = { sessionId: 'video-1', isStreaming: false, sendDisabled: false } as ComponentProps<
      typeof IndustrialVideoAgentComposerSlot
    >
    state.record = { state: 'generating', unknownSubmissions: [] }
    const { rerender } = render(<IndustrialVideoAgentComposerSlot {...props} />)
    expect(screen.getByRole('button', { name: 'send' })).toBeDisabled()
    state.record = { state: 'storyboard_submitted', unknownSubmissions: [] }
    rerender(<IndustrialVideoAgentComposerSlot {...props} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'send' })).toBeEnabled())
    state.job = { status: 'running' }
    rerender(<IndustrialVideoAgentComposerSlot {...props} />)
    expect(screen.getByRole('button', { name: 'send' })).toBeDisabled()
    state.job = null
    state.record.unknownSubmissions = [{}]
    rerender(<IndustrialVideoAgentComposerSlot {...props} />)
    expect(screen.getByRole('button', { name: 'send' })).toBeDisabled()
    state.record.unknownSubmissions = []
    state.error = 'offline'
    rerender(<IndustrialVideoAgentComposerSlot {...props} />)
    expect(screen.getByRole('button', { name: 'send' })).toBeDisabled()
  })
})
