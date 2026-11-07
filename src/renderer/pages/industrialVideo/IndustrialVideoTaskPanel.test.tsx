import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '@renderer/i18n/resolver'
import { ipcApi } from '@renderer/ipc'

import IndustrialVideoTaskPanel from './IndustrialVideoTaskPanel'

vi.mock('./DedicatedIndustrialVideoReview', () => ({ default: () => null }))

const refresh = vi.fn()
const record = {
  sessionId: 's',
  run: 'r',
  state: 'blocked',
  version: 1,
  rounds: [],
  unknownSubmissions: []
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
