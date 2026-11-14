import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '@renderer/i18n/resolver'
import { ipcApi } from '@renderer/ipc'

import IndustrialVideoTaskPanel, { IndustrialVideoMessageReview } from './IndustrialVideoTaskPanel'

vi.mock('./IndustrialVideoWorkbench', () => ({
  default: () => <section aria-label="客户端审核">新分镜待审核</section>
}))

vi.mock('./DedicatedIndustrialVideoReview', () => ({ default: () => null }))

const refresh = vi.fn()
const record = {
  sessionId: 's',
  run: 'r',
  state: 'blocked',
  version: 1,
  rounds: [],
  unknownSubmissions: [],
  control: { epoch: 1, phase: 'idle', stopRequested: false }
}

vi.mock('./useIndustrialVideoProduction', () => ({
  useIndustrialVideoProduction: () => ({
    record,
    job: { status: 'blocked', error: 'awaiting_script_review' },
    jobError: 'awaiting_script_review',
    error: '',
    refresh
  })
}))

vi.mock('@renderer/ipc', () => ({
  ipcApi: { request: vi.fn() }
}))

describe('IndustrialVideoTaskPanel', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN')
    vi.clearAllMocks()
    vi.mocked(ipcApi.request).mockImplementation(async (route) => {
      if (route === 'industrial_video.review_snapshot_get') {
        return {
          review_version: 'review-7',
          script: '真实脚本内容',
          storyboard: { video_title: '产品视频', scenes: [] },
          remaining_blockers: ['awaiting_script_review']
        } as never
      }
      throw new Error(`unexpected route: ${route}`)
    })
  })

  it('审核选择由 Agent 原生 AskUserQuestion 接管，任务面板不再自动读取或直接确认', async () => {
    render(<IndustrialVideoTaskPanel sessionId="s" />)

    expect(screen.getByRole('button', { name: '读取审核快照' })).toBeEnabled()
    expect(screen.queryByText('需要你的选择')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '脚本与分镜没问题，开始生成视频' })).not.toBeInTheDocument()
    await waitFor(() => expect(refresh).toHaveBeenCalled(), { timeout: 4000 })
    expect(ipcApi.request).not.toHaveBeenCalled()
  })

  it('分镜执行结束后重新对账，显示最新审核而非停留在执行中', async () => {
    record.state = 'executing'
    refresh.mockImplementation(async () => {
      record.state = 'storyboard_submitted'
    })
    vi.mocked(ipcApi.request).mockResolvedValue({ review_version: 'new-review' })
    const view = render(<IndustrialVideoMessageReview sessionId="s" executing />)
    view.rerender(<IndustrialVideoMessageReview sessionId="s" executing={false} />)
    await waitFor(() => expect(record.state).toBe('storyboard_submitted'))
    view.rerender(<IndustrialVideoMessageReview sessionId="s" executing={false} />)
    expect(await screen.findByRole('region', { name: '客户端审核' })).toHaveTextContent('新分镜待审核')
    record.state = 'blocked'
    refresh.mockReset()
  })

  it('消息结束后记录延迟就绪也会自动显示审核，不依赖再次发送消息', async () => {
    vi.useFakeTimers()
    record.state = 'idle'
    refresh.mockImplementation(async () => {})
    vi.mocked(ipcApi.request).mockResolvedValue({ review_version: 'ready' })
    const view = render(<IndustrialVideoMessageReview sessionId="s" executing={false} />)
    try {
      await act(async () => {})
      refresh.mockImplementation(async () => {
        record.state = 'storyboard_submitted'
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })
      view.rerender(<IndustrialVideoMessageReview sessionId="s" executing={false} />)
      await act(async () => {})
      expect(screen.getByRole('region', { name: '客户端审核' })).toBeInTheDocument()
    } finally {
      view.unmount()
      vi.useRealTimers()
      record.state = 'blocked'
      refresh.mockReset()
    }
  })

  it('消息结束但执行权限尚未释放时不读取审核，释放后自动恢复', async () => {
    record.state = 'storyboard_submitted'
    record.control.phase = 'active'
    vi.mocked(ipcApi.request).mockResolvedValue({ review_version: 'released' })
    const view = render(<IndustrialVideoMessageReview sessionId="s" executing={false} />)
    try {
      await act(async () => {})
      expect(ipcApi.request).not.toHaveBeenCalled()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '重试读取审核' })).not.toBeInTheDocument()
      record.control.phase = 'idle'
      view.rerender(<IndustrialVideoMessageReview sessionId="s" executing={false} />)
      await waitFor(() =>
        expect(ipcApi.request).toHaveBeenCalledWith('industrial_video.cowork_review_get', { sessionId: 's', run: 'r' })
      )
    } finally {
      view.unmount()
      record.control.phase = 'idle'
      record.state = 'blocked'
    }
  })

  it('审核读取失败明确显示错误，重试后恢复入口', async () => {
    record.state = 'storyboard_submitted'
    vi.mocked(ipcApi.request)
      .mockRejectedValueOnce(new Error('审核读取暂时失败'))
      .mockResolvedValue({ review_version: 'recovered' })
    const view = render(<IndustrialVideoMessageReview sessionId="s" executing={false} />)
    try {
      expect(await screen.findByRole('alert')).toHaveTextContent('审核读取暂时失败')
      await userEvent.setup().click(screen.getByRole('button', { name: '重试读取审核' }))
      expect(await screen.findByRole('region', { name: '客户端审核' })).toBeInTheDocument()
    } finally {
      view.unmount()
      record.state = 'blocked'
    }
  })

  it('手动读取仅展示版本提示，不提供旁路确认按钮', async () => {
    const user = userEvent.setup()
    render(<IndustrialVideoTaskPanel sessionId="s" />)

    await user.click(screen.getByRole('button', { name: '读取审核快照' }))

    expect(await screen.findByText(/审核版本：review-7/)).toBeInTheDocument()
    expect(screen.getByText(/请在 Agent 的“需要你的选择”中完成审核/)).toBeInTheDocument()
    expect(ipcApi.request).toHaveBeenCalledWith('industrial_video.review_snapshot_get', {
      sessionId: 's',
      run: 'r',
      reviewType: 'script_and_storyboard'
    })
    expect(vi.mocked(ipcApi.request).mock.calls.some(([route]) => route === 'industrial_video.review_confirm')).toBe(
      false
    )
  })
})
