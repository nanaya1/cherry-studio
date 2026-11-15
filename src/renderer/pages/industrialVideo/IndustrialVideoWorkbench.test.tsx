import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ButtonHTMLAttributes } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ipcApi } from '@renderer/ipc'

import { useIndustrialVideoWorkbench } from './industrialVideoProgressStore'
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
vi.mock('./IndustrialVideoReviewFiles', () => ({
  default: ({ output }: { output: Record<string, unknown> }) => (
    <div data-testid="review-script">{String(output.script)}</div>
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

  it.each([true, false])('恢复必须携带持久化原版本且仅成功后续模型：%s', async (accepted) => {
    const user = userEvent.setup()
    const resume = vi.fn(async () => undefined)
    const record = {
      ...mocks.record,
      state: 'planning',
      rounds: [
        {
          operation: 'storyboard_stage_task_get',
          run: 'run-1',
          detail: { lifecycle: 'executing', expected_task_version: 'original-v1' }
        }
      ]
    }
    vi.mocked(ipcApi.request).mockImplementation(async (route) => {
      if (route === 'industrial_video.stage_retry') {
        if (!accepted) throw new Error('服务端任务已变化')
        return { retried: true } as never
      }
      throw new Error(`意外调用 ${route}`)
    })
    render(
      <IndustrialVideoWorkbench
        sessionId="s"
        production={makeProduction(record)}
        executing={false}
        resumeStages={resume}
      />
    )
    await user.click(screen.getByRole('button', { name: '明确重试当前阶段任务' }))
    await waitFor(() =>
      expect(ipcApi.request).toHaveBeenCalledWith('industrial_video.stage_retry', {
        sessionId: 's',
        run: 'run-1',
        expectedTaskVersion: 'original-v1'
      })
    )
    if (accepted) await waitFor(() => expect(resume).toHaveBeenCalledExactlyOnceWith('run-1'))
    else {
      expect(await screen.findByRole('alert')).toHaveTextContent('服务端任务已变化')
      expect(resume).not.toHaveBeenCalled()
    }
    expect(vi.mocked(ipcApi.request).mock.calls.map(([route]) => route)).toEqual(['industrial_video.stage_retry'])
  })

  it('执行中或存在未知写入时禁用显式恢复', () => {
    const record = {
      ...mocks.record,
      rounds: [
        {
          operation: 'storyboard_stage_task_get',
          run: 'run-1',
          detail: { lifecycle: 'executing', expected_task_version: 'v1' }
        }
      ]
    }
    const view = render(
      <IndustrialVideoWorkbench sessionId="s" production={makeProduction(record)} executing resumeStages={vi.fn()} />
    )
    expect(screen.getByRole('button', { name: '明确重试当前阶段任务' })).toBeDisabled()
    view.rerender(
      <IndustrialVideoWorkbench
        sessionId="s"
        production={makeProduction({ ...record, unknownSubmissions: [{}] } as never)}
        executing={false}
        resumeStages={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: '明确重试当前阶段任务' })).toBeDisabled()
  })

  it('用户确认绑定实际展示版本，重生成只续原会话执行，不启动视频', async () => {
    const user = userEvent.setup()
    const resume = vi.fn(async () => undefined)
    vi.mocked(ipcApi.request).mockImplementation(async (route) => {
      if (route === 'industrial_video.cowork_review_get')
        return {
          review_version: 'shown-v1',
          script: '原始全文',
          storyboard: { scenes: [] },
          effective_settings: { resolution: '1080P' },
          allowed_actions: ['regenerate_storyboard', 'generate_video']
        } as never
      if (route === 'industrial_video.cowork_review_confirm')
        return { task_operation: 'storyboard_stage_task_get', regeneration_id: 'regen-1' } as never
      throw new Error(`意外调用 ${route}`)
    })
    render(<IndustrialVideoWorkbench sessionId="s" production={makeProduction()} resumeStages={resume} />)
    await user.click(screen.getByRole('button', { name: '刷新审核内容' }))
    expect(await screen.findByText('原始全文')).toBeInTheDocument()
    expect(screen.getByText('审核版本：shown-v1')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '确认全文素材，修改动作分镜' }))
    await waitFor(() => expect(resume).toHaveBeenCalledWith('run-1'))
    expect(ipcApi.request).toHaveBeenCalledWith('industrial_video.cowork_review_confirm', {
      sessionId: 's',
      run: 'run-1',
      expectedReviewVersion: 'shown-v1',
      action: 'regenerate_storyboard'
    })
    expect(vi.mocked(ipcApi.request).mock.calls.map(([route]) => route)).not.toContain('industrial_video.video_start')
  })

  it('消息内审核自动展示最新稿，而不是继续使用消息中的旧快照', async () => {
    const result = {
      ok: true,
      run: 'run-1',
      review_version: 'old',
      script: '全文',
      storyboard: { scenes: [] },
      effective_settings: {},
      allowed_actions: ['generate_video']
    }
    vi.mocked(ipcApi.request).mockResolvedValue({ ...result, review_version: 'latest' })
    render(
      <IndustrialVideoWorkbench sessionId="s" production={makeProduction()} executing={false} reviewOutput={result} />
    )
    expect(screen.getByText('分镜预览已完成，请核对内容。')).toBeInTheDocument()
    expect(screen.queryByText('审核版本：old')).toBeNull()
    await screen.findByText('分镜已更新，可以确认并生成视频')
    expect(screen.getByRole('button', { name: '确认并生成视频' })).toBeEnabled()
  })

  it('对话区隐藏稿件卡片和重生成入口，回到对话仍同步状态且不自动确认或生成', async () => {
    const initial = { review_version: 'v1', script: '初稿', allowed_actions: ['generate_video'] }
    vi.mocked(ipcApi.request).mockResolvedValue(initial)
    render(
      <IndustrialVideoWorkbench sessionId="s" production={makeProduction()} executing={false} reviewOutput={initial} />
    )
    expect(screen.getByText('正在同步内容…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '刷新内容' })).toBeNull()
    expect(screen.getByRole('button', { name: '打开工作台' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: '确认并生成视频' })).toBeEnabled())
    expect(screen.queryByText('已同步最新内容')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    vi.mocked(ipcApi.request).mockResolvedValue({ ...initial, script: '网页保存的新稿', review_version: 'v2' })
    fireEvent.focus(window)
    await screen.findByText('分镜已更新，可以确认并生成视频')
    expect(screen.queryByTestId('review-script')).not.toBeInTheDocument()
    expect(screen.queryByText('网页保存的新稿')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重新生成分镜' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认并生成视频' })).toBeEnabled()
    expect(
      vi.mocked(ipcApi.request).mock.calls.every(([route]) => route === 'industrial_video.cowork_review_get')
    ).toBe(true)
  })

  it('后台同步等待期间不闪提示或禁用按钮，但失败仍阻止确认', async () => {
    const initial = { review_version: 'v1', allowed_actions: ['generate_video'] }
    vi.mocked(ipcApi.request).mockResolvedValue(initial)
    render(
      <IndustrialVideoWorkbench sessionId="s" production={makeProduction()} executing={false} reviewOutput={initial} />
    )
    const button = screen.getByRole('button', { name: '确认并生成视频' })
    await waitFor(() => expect(button).toBeEnabled())
    let rejectSync!: (error: Error) => void
    vi.mocked(ipcApi.request).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectSync = reject
        })
    )
    fireEvent.focus(window)
    expect(screen.queryByText('正在同步内容…')).not.toBeInTheDocument()
    expect(button).toBeEnabled()
    rejectSync(new Error('网络中断'))
    await screen.findByText('暂时无法同步最新内容。')
    expect(button).toBeDisabled()
  })

  it('过期预览显示真实阻塞，服务端保存为可生成快照后自动恢复', async () => {
    const initial = { review_version: 'v1', draft_stale: true, allowed_actions: ['regenerate_storyboard'] }
    vi.mocked(ipcApi.request).mockResolvedValue(initial)
    render(
      <IndustrialVideoWorkbench sessionId="s" production={makeProduction()} executing={false} reviewOutput={initial} />
    )
    // 捕获轮询间隔及请求等待期间无反馈、保存后未停止 loading 的回归。
    await waitFor(() => expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true'))
    expect(screen.getByText('等待工作台分镜更新，正在自动检查…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认并生成视频' })).toBeDisabled()
    let resolveSync!: (value: never) => void
    vi.mocked(ipcApi.request).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSync = resolve
        })
    )
    fireEvent.focus(window)
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
    resolveSync({ ...initial, review_version: 'v2', draft_stale: false, allowed_actions: ['generate_video'] } as never)
    await waitFor(() => expect(screen.getByRole('button', { name: '确认并生成视频' })).toBeEnabled())
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'false')
    expect(screen.getByText('分镜已更新，可以确认并生成视频')).toBeInTheDocument()
    expect(screen.queryByText('等待工作台分镜更新，正在自动检查…')).not.toBeInTheDocument()
    expect(
      screen.queryByText('当前分镜预览已过期，保存修改后仍需重新生成分镜；暂不能生成视频。')
    ).not.toBeInTheDocument()
  })

  it('同步失败禁止确认，只显示失败重试入口，成功后恢复', async () => {
    const initial = { review_version: 'v1', script: '初稿', allowed_actions: ['generate_video'] }
    vi.mocked(ipcApi.request).mockRejectedValue(new Error('网络中断'))
    const user = userEvent.setup()
    render(
      <IndustrialVideoWorkbench sessionId="s" production={makeProduction()} executing={false} reviewOutput={initial} />
    )
    await screen.findByRole('button', { name: '重试同步' })
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'false')
    expect(screen.queryByText('等待工作台分镜更新，正在自动检查…')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认并生成视频' })).toBeDisabled()
    vi.mocked(ipcApi.request).mockResolvedValue(initial)
    await user.click(screen.getByRole('button', { name: '重试同步' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '确认并生成视频' })).toBeEnabled())
    expect(screen.queryByRole('button', { name: '重试同步' })).toBeNull()
  })

  it.each(['generate_video'])('点击前发现新版本时仅更新状态，不能代确认：%s', async () => {
    const initial = {
      review_version: 'v1',
      script: '初稿',
      allowed_actions: ['generate_video', 'regenerate_storyboard']
    }
    vi.mocked(ipcApi.request).mockResolvedValue(initial)
    const resume = vi.fn()
    const user = userEvent.setup()
    render(
      <IndustrialVideoWorkbench
        sessionId="s"
        production={makeProduction()}
        executing={false}
        reviewOutput={initial}
        resumeStages={resume}
      />
    )
    await waitFor(() => expect(screen.getByRole('button', { name: '确认并生成视频' })).toBeEnabled())
    vi.mocked(ipcApi.request).mockResolvedValue({ ...initial, review_version: 'v2', script: '变更稿' })
    await user.click(screen.getByRole('button', { name: '确认并生成视频' }))
    await screen.findByText('分镜已更新，可以确认并生成视频')
    expect(screen.queryByTestId('review-script')).not.toBeInTheDocument()
    expect(screen.queryByText('变更稿')).not.toBeInTheDocument()
    expect(resume).not.toHaveBeenCalled()
    expect(
      vi.mocked(ipcApi.request).mock.calls.every(([route]) => route === 'industrial_video.cowork_review_get')
    ).toBe(true)
  })

  it('确认生成成功后发送「开始生成视频」，不直接调用生成接口', async () => {
    const initial = { review_version: 'v1', script: '全文', allowed_actions: ['generate_video'] }
    vi.mocked(ipcApi.request).mockImplementation(async (route) => {
      if (route === 'industrial_video.cowork_review_get') return initial as never
      if (route === 'industrial_video.cowork_review_confirm')
        return { generation_allowed: true, remaining_blockers: [], next_stage: 'video' } as never
      throw new Error(`意外调用 ${route}`)
    })
    const send = vi.fn(async () => true)
    const user = userEvent.setup()
    render(
      <IndustrialVideoWorkbench
        sessionId="s"
        production={makeProduction()}
        executing={false}
        reviewOutput={initial}
        sendMessage={send}
      />
    )
    await waitFor(() => expect(screen.getByRole('button', { name: '确认并生成视频' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '确认并生成视频' }))
    await waitFor(() => expect(send).toHaveBeenCalledWith({ text: '开始生成视频' }))
    const routes = vi.mocked(ipcApi.request).mock.calls.map(([route]) => route)
    expect(routes).not.toContain('industrial_video.video_start')
    expect(routes).not.toContain('industrial_video.estimate')
    expect(routes).not.toContain('industrial_video.assemble')
    expect(await screen.findByText('此版本已处理，请查看后续消息。')).toBeInTheDocument()
  })

  it('确认成功但发送失败时明确报错且不伪报完成', async () => {
    const initial = { review_version: 'v1', script: '全文', allowed_actions: ['generate_video'] }
    vi.mocked(ipcApi.request).mockImplementation(async (route) => {
      if (route === 'industrial_video.cowork_review_get') return initial as never
      if (route === 'industrial_video.cowork_review_confirm')
        return { generation_allowed: true, remaining_blockers: [], next_stage: 'video' } as never
      throw new Error(`意外调用 ${route}`)
    })
    const send = vi.fn(async () => false)
    const user = userEvent.setup()
    render(
      <IndustrialVideoWorkbench
        sessionId="s"
        production={makeProduction()}
        executing={false}
        reviewOutput={initial}
        sendMessage={send}
      />
    )
    await waitFor(() => expect(screen.getByRole('button', { name: '确认并生成视频' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '确认并生成视频' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('发送失败')
    expect(await screen.findByText('此版本已处理，请查看后续消息。')).toBeInTheDocument()
  })

  it('生成条件未就绪时确认失败报具体阻塞，不发送生成消息', async () => {
    const initial = { review_version: 'v1', script: '全文', allowed_actions: ['generate_video'] }
    vi.mocked(ipcApi.request).mockImplementation(async (route) => {
      if (route === 'industrial_video.cowork_review_get') return initial as never
      if (route === 'industrial_video.cowork_review_confirm')
        return { generation_allowed: false, remaining_blockers: ['awaiting_fee_confirm'], next_stage: 'video' } as never
      throw new Error(`意外调用 ${route}`)
    })
    const send = vi.fn(async () => true)
    const user = userEvent.setup()
    render(
      <IndustrialVideoWorkbench
        sessionId="s"
        production={makeProduction()}
        executing={false}
        reviewOutput={initial}
        sendMessage={send}
      />
    )
    await waitFor(() => expect(screen.getByRole('button', { name: '确认并生成视频' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '确认并生成视频' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('awaiting_fee_confirm')
    expect(send).not.toHaveBeenCalled()
  })

  it('未接入 sendMessage 时保留原直接提交路径（回滚兼容）', async () => {
    const initial = { review_version: 'v1', script: '全文', allowed_actions: ['generate_video'] }
    vi.mocked(ipcApi.request).mockImplementation(async (route) => {
      if (route === 'industrial_video.cowork_review_get') return initial as never
      if (route === 'industrial_video.cowork_review_confirm')
        return { generation_allowed: true, remaining_blockers: [], next_stage: 'video' } as never
      if (route === 'industrial_video.estimate') return { requiresReplan: false, approvalInvalidated: false } as never
      if (route === 'industrial_video.video_start') return { jobId: 'job-1' } as never
      throw new Error(`意外调用 ${route}`)
    })
    const user = userEvent.setup()
    render(
      <IndustrialVideoWorkbench sessionId="s" production={makeProduction()} executing={false} reviewOutput={initial} />
    )
    await waitFor(() => expect(screen.getByRole('button', { name: '确认并生成视频' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: '确认并生成视频' }))
    await waitFor(() =>
      expect(ipcApi.request).toHaveBeenCalledWith('industrial_video.video_start', { sessionId: 's', run: 'run-1' })
    )
  })

  it('消息审核提供明确工作台入口，单次点击打开同会话右侧工作台', async () => {
    const initial = { review_version: 'v1', script: '全文', allowed_actions: [] }
    vi.mocked(ipcApi.request).mockImplementation(async (route) => {
      if (route === 'industrial_video.cowork_review_get') return initial as never
      if (route === 'industrial_video.workbench_open')
        return { workbench_url: mocks.workbenchUrl, run: 'run-1' } as never
      throw new Error(`意外调用 ${route}`)
    })
    function RightPane() {
      const workbench = useIndustrialVideoWorkbench('entry-session')
      return workbench ? (
        <p role="status">
          工作台：{workbench.run} {workbench.url}
        </p>
      ) : null
    }
    render(
      <>
        <IndustrialVideoWorkbench
          sessionId="entry-session"
          production={makeProduction()}
          executing={false}
          reviewOutput={initial}
        />
        <RightPane />
      </>
    )
    await userEvent.setup().click(screen.getByRole('button', { name: '打开工作台' }))
    expect(await screen.findByText(`工作台：run-1 ${mocks.workbenchUrl}`)).toBeInTheDocument()
    expect(ipcApi.request).toHaveBeenCalledWith('industrial_video.workbench_open', {
      sessionId: 'entry-session',
      run: 'run-1'
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
    view.rerender(
      <IndustrialVideoWorkbench sessionId="other" production={makeProduction({ ...mocks.record, run: 'other-run' })} />
    )
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
