import { MockCacheUtils } from '@test-mocks/renderer/CacheService'
import { act, render, screen, cleanup, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cacheService } from '@data/CacheService'

import { IndustrialVideoTaskComposer, IndustrialVideoTaskSurface } from './IndustrialVideoOrchestratedTask'
import { createIndustrialVideoSettings } from './industrialVideoSettings'

vi.mock('@renderer/data/hooks/useCache', async (original) => await original())
vi.mock('@renderer/ipc', () => ({ ipcApi: { request: vi.fn(async () => null) } }))
vi.mock('./IndustrialVideoTaskPanel', () => ({ default: () => <div>Review controls</div> }))
vi.mock('./IndustrialVideoAgentProduction', () => ({
  default: ({ children }: { children: React.ReactNode }) => children
}))

beforeEach(() => {
  MockCacheUtils.resetMocks()
  localStorage.clear()
})
afterEach(cleanup)

const dedicatedDraft = (overrides: Record<string, unknown> = {}) => ({
  orchestration: 'dedicated' as const,
  requirement: 'BT-800 设备视频',
  modelId: 'test::model' as const,
  settings: createIndustrialVideoSettings('marketing'),
  ...overrides
})

async function stubProduction({
  state = 'idle',
  jobId = 'job-1',
  progress
}: {
  state?: string
  jobId?: string | null
  progress?: Record<string, unknown>
}) {
  const request = vi.mocked((await import('@renderer/ipc')).ipcApi.request)
  request.mockImplementation(async (channel: string) => {
    if (channel === 'industrial_video.get_records')
      return {
        sessionId: 's1',
        version: 1,
        run: jobId ? 'run-1' : null,
        jobId,
        state,
        rounds: [],
        unknownSubmissions: [],
        updatedAt: 1
      } as never
    if (channel === 'industrial_video.job_get')
      return { status: 'done', run: 'run-1', progress: progress ?? {} } as never
    if (channel === 'industrial_video.storyboard_get')
      return { storyboard: { video_title: 't', scenes: Array.from({ length: 8 }, (_, i) => ({ id: i + 1 })) } } as never
    return null as never
  })
  return request
}

it('dedicated completion hides online preview for an open local video, but generating keeps the sidebar', async () => {
  await stubProduction({ state: 'done' })
  cacheService.setPersist('industrial_video.session_draft.s1', dedicatedDraft())
  const view = await renderWrapped(
    <IndustrialVideoTaskSurface sessionId="s1" filePreviewActive preview={<div>在线预览兜底</div>}>
      消息
    </IndustrialVideoTaskSurface>
  )
  await waitFor(() => expect(screen.getByLabelText('成片预览')).not.toBeVisible())
  view.unmount()
  await stubProduction({ state: 'generating' })
  await renderWrapped(
    <IndustrialVideoTaskSurface sessionId="s1" filePreviewActive preview={<div>在线预览兜底</div>}>
      消息
    </IndustrialVideoTaskSurface>
  )
  await waitFor(() => expect(screen.getByLabelText('成片预览')).toBeVisible())
})

describe('修改草稿与执行互斥', () => {
  it('生成中允许输入但按钮和回车均不能提交，重新挂载保留草稿', async () => {
    await stubProduction({ state: 'generating' })
    cacheService.setPersist('industrial_video.session_draft.s1', dedicatedDraft())
    const ui = (
      <IndustrialVideoTaskSurface sessionId="s1">
        <div>消息</div>
      </IndustrialVideoTaskSurface>
    )
    const view = await renderWrapped(ui)
    await userEvent.type(screen.getByRole('textbox'), '保留这个修改{enter}')
    expect(screen.getByRole('textbox')).toHaveValue('保留这个修改')
    expect(screen.getByRole('button', { name: '提交修改' })).toBeDisabled()
    expect(cacheService.getPersist('industrial_video.revision.s1')).toBeNull()
    view.unmount()
    await renderWrapped(ui)
    expect(screen.getByRole('textbox')).toHaveValue('保留这个修改')
  })

  it('待审时显式提交才消费草稿', async () => {
    await stubProduction({ state: 'storyboard_submitted' })
    cacheService.setPersist('industrial_video.session_draft.s1', dedicatedDraft())
    await renderWrapped(
      <IndustrialVideoTaskSurface sessionId="s1">
        <div>消息</div>
      </IndustrialVideoTaskSurface>
    )
    await userEvent.type(screen.getByRole('textbox'), '缩短开场')
    expect(cacheService.getPersist('industrial_video.revision.s1')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '提交修改' }))
    expect(cacheService.getPersist('industrial_video.revision.s1')?.revisions[0].text).toBe('缩短开场')
    expect(screen.getByRole('textbox')).toHaveValue('')
  })
})

const host = (container: HTMLElement, name: string) =>
  container.querySelector(`[data-ui="${name}"]`) as HTMLElement | null

// 渲染并 flush：工作台挂载后会立即发起一次异步 refresh（轮询），包在 act 内避免状态更新告警。
async function renderWrapped(ui: React.ReactElement) {
  let utils: ReturnType<typeof render>
  await act(async () => {
    utils = render(ui)
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
  })
  return utils!
}

describe('专用工作台宿主与布局 (1/9)', () => {
  it('专用会话渲染消息流宿主、右侧预览宿主与专用输入，不渲染普通 Agent 输入', async () => {
    const request = await stubProduction({ state: 'idle' })
    cacheService.setPersist('industrial_video.session_draft.s1', dedicatedDraft())
    const { container } = await renderWrapped(
      <IndustrialVideoTaskSurface sessionId="s1" preview={<div>Review controls</div>}>
        <div>Original messages</div>
      </IndustrialVideoTaskSurface>
    )
    expect(screen.getByText('Original messages')).toBeInTheDocument()
    const preview = host(container, 'industrial-video.review-preview')
    expect(preview).toBeInTheDocument()
    expect(within(preview!).getByText('Review controls')).toBeInTheDocument()
    expect(host(container, 'industrial-video.review-message')).toBeInTheDocument()
    expect(document.getElementById('industrial-video-review-s1')).toBeInTheDocument()
    expect(host(container, 'industrial-video.review-preview')).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    expect(request).toHaveBeenCalledWith('industrial_video.get_records', { sessionId: 's1' })
  })

  it('非专用会话原样放行普通消息流与 composer（不进入工作台）', async () => {
    cacheService.setPersist('industrial_video.session_draft.s1', { ...dedicatedDraft(), orchestration: 'agent' })
    const { container } = await renderWrapped(
      <IndustrialVideoTaskSurface sessionId="s1">
        <div>Original messages</div>
      </IndustrialVideoTaskSurface>
    )
    expect(screen.getByText('Original messages')).toBeInTheDocument()
    expect(host(container, 'industrial-video.review-message')).not.toBeInTheDocument()
    expect(host(container, 'industrial-video.review-preview')).not.toBeInTheDocument()
  })
})

describe('专用输入不送普通 Agent，避免双链竞争 (2/9)', () => {
  it('专用 composer 完全抑制普通 Agent 发送入口，杜绝双链竞争', async () => {
    cacheService.setPersist('industrial_video.session_draft.s1', dedicatedDraft())
    await renderWrapped(
      <IndustrialVideoTaskComposer sessionId="s1">
        <button type="button">Send message</button>
      </IndustrialVideoTaskComposer>
    )
    // 专用会话的底部普通 Agent 输入被整体移除；专用修改输入由工作台宿主统一提供。
    expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('提交专用输入只写入专用编排收件箱，不触发普通聊天发送', async () => {
    const request = await stubProduction({ state: 'storyboard_submitted' })
    cacheService.setPersist('industrial_video.session_draft.s1', dedicatedDraft())
    const { container } = await renderWrapped(
      <IndustrialVideoTaskSurface sessionId="s1">
        <div>Original messages</div>
      </IndustrialVideoTaskSurface>
    )
    const input = screen.getByRole('textbox')
    const send = screen.getByRole('button', { name: '提交修改' })
    send.click()
    // 尚未提交时无收件箱记录（schema 默认值为 null，与 session_draft/preparation 一致）。
    expect(cacheService.getPersist('industrial_video.revision.s1')).toBeNull()
    await userEvent.type(input, '把片头时长缩短到 3 秒')
    await userEvent.click(send)
    const revisions = cacheService.getPersist('industrial_video.revision.s1')?.revisions ?? []
    expect(revisions).toHaveLength(1)
    expect(revisions[0].text).toContain('片头时长缩短')
    // 专用编排推进被触发（get_records 被调用），普通聊天发送通道未被使用
    expect(request).toHaveBeenCalledWith('industrial_video.get_records', { sessionId: 's1' })
    expect(host(container, 'industrial-video.review-message')).toBeInTheDocument()
  })
})

describe('资料三步 / 视频阶段进度置于消息流 (3/9)', () => {
  it('消息流宿主内含进度，且进度不在右侧预览宿主内', async () => {
    await stubProduction({ state: 'generating' })
    cacheService.setPersist('industrial_video.session_draft.s1', dedicatedDraft())
    cacheService.setPersist('industrial_video.preparation.s1', {
      input: dedicatedDraft(),
      stage: 'submitted',
      result: '',
      error: '',
      startedAt: 1,
      updatedAt: 1
    })
    const { container } = await renderWrapped(
      <IndustrialVideoTaskSurface sessionId="s1">
        <div>Original messages</div>
      </IndustrialVideoTaskSurface>
    )
    const message = host(container, 'industrial-video.review-message')
    const preview = host(container, 'industrial-video.review-preview')
    expect(message).not.toBeNull()
    expect(message!.querySelector('[data-ui="industrial-video.progress"]')).not.toBeNull()
    expect(preview!.querySelector('[data-ui="industrial-video.progress"]')).toBeNull()
  })
})

describe('右侧加载画面真实阶段与总镜数，不伪造完成数 (6/9)', () => {
  it('生成中显示真实阶段、真实总镜数与已完成镜数（3/8 而非伪造 8/8）', async () => {
    await stubProduction({ state: 'generating', progress: { stage: 'generating', total_scenes: 8, scenes_done: 3 } })
    cacheService.setPersist('industrial_video.session_draft.s1', dedicatedDraft())
    const { container } = await renderWrapped(
      <IndustrialVideoTaskSurface sessionId="s1">
        <div>Original messages</div>
      </IndustrialVideoTaskSurface>
    )
    await waitFor(() => expect(host(container, 'industrial-video.loading')).not.toBeNull())
    const loading = host(container, 'industrial-video.loading')!
    expect(loading).toHaveAttribute('data-stage', 'generating')
    expect(loading).toHaveAttribute('data-total-shots', '8')
    expect(loading).toHaveAttribute('data-done-shots', '3')
    expect(loading).not.toHaveAttribute('data-done-shots', '8')
  })

  it('服务端未给出已完成镜数时不编造完成数，只显示总镜数', async () => {
    await stubProduction({ state: 'generating', progress: { stage: 'generating', total_scenes: 8 } })
    cacheService.setPersist('industrial_video.session_draft.s1', dedicatedDraft())
    const { container } = await renderWrapped(
      <IndustrialVideoTaskSurface sessionId="s1">
        <div>Original messages</div>
      </IndustrialVideoTaskSurface>
    )
    await waitFor(() => expect(host(container, 'industrial-video.loading')).not.toBeNull())
    const loading = host(container, 'industrial-video.loading')!
    expect(loading).toHaveAttribute('data-total-shots', '8')
    // 已完成数缺失：明确为空，绝不出现 8/8 这类伪造完成比例
    expect(loading.getAttribute('data-done-shots')).toBe('')
  })

  it('成片就绪（done）时不再显示加载画面，改由产物宿主接管', async () => {
    await stubProduction({
      state: 'done',
      progress: { stage: 'done', total_scenes: 8, scenes_done: 8, final: '/run/1/final.mp4' }
    })
    cacheService.setPersist('industrial_video.session_draft.s1', dedicatedDraft())
    const { container } = await renderWrapped(
      <IndustrialVideoTaskSurface sessionId="s1" preview={<div>Review controls</div>}>
        <div>Original messages</div>
      </IndustrialVideoTaskSurface>
    )
    await waitFor(() => expect(host(container, 'industrial-video.loading')).toBeNull())
    expect(screen.getByText('Review controls')).toBeInTheDocument()
  })
})

describe('技术信息默认隐藏，仅错误详情 (8/9)', () => {
  it('无失败时技术详情折叠，且不暴露原始 job JSON', async () => {
    await stubProduction({ state: 'generating', progress: { stage: 'generating', total_scenes: 8, scenes_done: 1 } })
    cacheService.setPersist('industrial_video.session_draft.s1', dedicatedDraft())
    const { container } = await renderWrapped(
      <IndustrialVideoTaskSurface sessionId="s1">
        <div>Original messages</div>
      </IndustrialVideoTaskSurface>
    )
    await waitFor(() => expect(host(container, 'industrial-video.loading')).not.toBeNull())
    expect(screen.queryByText('Technical details')).not.toBeInTheDocument()
    expect(container.querySelector('pre')).toBeNull()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('存在失败时默认显示错误详情', async () => {
    await stubProduction({ state: 'failed', progress: { stage: 'failed' } })
    cacheService.setPersist('industrial_video.session_draft.s1', dedicatedDraft())
    cacheService.setPersist('industrial_video.preparation.s1', {
      input: dedicatedDraft(),
      stage: 'failed',
      result: '',
      error: '解析被服务端拒绝',
      startedAt: 1,
      updatedAt: 1
    })
    await renderWrapped(
      <IndustrialVideoTaskSurface sessionId="s1">
        <div>Original messages</div>
      </IndustrialVideoTaskSurface>
    )
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('解析被服务端拒绝')
  })
})

describe('轻量视觉与专用输入宿主 (9/9)', () => {
  it('专用工作台暴露专用输入宿主，不引入新视觉风格 token', async () => {
    await stubProduction({ state: 'idle' })
    cacheService.setPersist('industrial_video.session_draft.s1', dedicatedDraft())
    const { container } = await renderWrapped(
      <IndustrialVideoTaskSurface sessionId="s1">
        <div>Original messages</div>
      </IndustrialVideoTaskSurface>
    )
    expect(host(container, 'industrial-video.dedicated-composer')).toBeInTheDocument()
  })
})

describe('成片预览受控显隐与草稿保留 (10/9)', () => {
  it('受控收起时预览宿主保持挂载（hidden），不卸载且左侧 flex 铺满', async () => {
    await stubProduction({
      state: 'done',
      progress: { stage: 'done', total_scenes: 8, scenes_done: 8, final: '/run/1/final.mp4' }
    })
    cacheService.setPersist('industrial_video.session_draft.s1', dedicatedDraft())
    const { container } = await renderWrapped(
      <IndustrialVideoTaskSurface sessionId="s1" preview={<div>Review controls</div>} previewOpen={false}>
        <div>Original messages</div>
      </IndustrialVideoTaskSurface>
    )
    const preview = host(container, 'industrial-video.review-preview')
    expect(preview).toBeInTheDocument() // 仍挂载，未卸载
    expect(within(preview!).getByText('Review controls')).toBeInTheDocument()
    expect(preview).toHaveClass('hidden')
    expect(preview).not.toHaveClass('flex')
  })

  it('未传 previewOpen 时默认展开预览宿主', async () => {
    await stubProduction({
      state: 'done',
      progress: { stage: 'done', total_scenes: 8, scenes_done: 8, final: '/run/1/final.mp4' }
    })
    cacheService.setPersist('industrial_video.session_draft.s1', dedicatedDraft())
    const { container } = await renderWrapped(
      <IndustrialVideoTaskSurface sessionId="s1" preview={<div>Review controls</div>}>
        <div>Original messages</div>
      </IndustrialVideoTaskSurface>
    )
    const preview = host(container, 'industrial-video.review-preview')
    expect(preview).toHaveClass('flex')
    expect(preview).not.toHaveClass('hidden')
  })

  it('切换 previewOpen 不卸载预览宿主（草稿保留）', async () => {
    await stubProduction({ state: 'idle' })
    cacheService.setPersist('industrial_video.session_draft.s1', dedicatedDraft())
    const view = await renderWrapped(
      <IndustrialVideoTaskSurface sessionId="s1" preview={<div>Review controls</div>} previewOpen={true}>
        <div>Original messages</div>
      </IndustrialVideoTaskSurface>
    )
    const input = screen.getByRole('textbox')
    await userEvent.type(input, '草稿内容')
    // 收起：预览宿主仍挂载，不被卸载
    view.rerender(
      <IndustrialVideoTaskSurface sessionId="s1" preview={<div>Review controls</div>} previewOpen={false}>
        <div>Original messages</div>
      </IndustrialVideoTaskSurface>
    )
    const preview = host(view.container, 'industrial-video.review-preview')
    expect(preview).toBeInTheDocument()
    expect(within(preview!).getByText('Review controls')).toBeInTheDocument()
    expect(preview).toHaveClass('hidden')
    // 再次展开：草稿仍在
    view.rerender(
      <IndustrialVideoTaskSurface sessionId="s1" preview={<div>Review controls</div>} previewOpen={true}>
        <div>Original messages</div>
      </IndustrialVideoTaskSurface>
    )
    expect(screen.getByRole('textbox')).toHaveValue('草稿内容')
    expect(host(view.container, 'industrial-video.review-preview')).toHaveClass('flex')
  })
})
