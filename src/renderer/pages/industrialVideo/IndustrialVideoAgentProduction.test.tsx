import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'

import { useToolResultAttachments } from '@renderer/components/chat/messages/tools/shared/ToolDisplayNames'
import { ipcApi } from '@renderer/ipc'

import IndustrialVideoAgentProduction from './IndustrialVideoAgentProduction'
import { IndustrialVideoReviewFilesProvider } from './IndustrialVideoReviewFiles'
import { useIndustrialVideoProduction } from './useIndustrialVideoProduction'

vi.mock('@renderer/components/WebviewHost', () => ({
  WebviewHost: ({ src }: { src: string }) => <div data-testid="workbench-browser" data-src={src} />
}))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request: vi.fn() } }))
vi.mock('./useIndustrialVideoProduction', () => ({ useIndustrialVideoProduction: vi.fn() }))
vi.mock('@renderer/components/FilePreview', () => ({
  FilePreview: ({ filePath }: { filePath: string }) => <video aria-label="成片播放器" src={filePath} controls />
}))
function StartMessage() {
  const attachments = useToolResultAttachments()
  return (
    <article aria-label="启动工具消息">
      {attachments?.('mcp__meacowork-tools__ivideo_start', {
        content: [{ type: 'text', text: '{"ok":true,"jobId":"j"}' }]
      })}
    </article>
  )
}
it('lets the task toolbar control the preview without polling reopening it', async () => {
  const user = userEvent.setup()
  const onPreviewOpenChange = vi.fn()
  const { rerender } = render(
    <IndustrialVideoAgentProduction sessionId="s" previewOpen={false} onPreviewOpenChange={onPreviewOpenChange}>
      消息流
    </IndustrialVideoAgentProduction>
  )
  expect(screen.queryByLabelText('成片预览')).toBeNull()
  expect(onPreviewOpenChange).not.toHaveBeenCalled()
  rerender(
    <IndustrialVideoAgentProduction sessionId="s" previewOpen onPreviewOpenChange={onPreviewOpenChange}>
      消息流
    </IndustrialVideoAgentProduction>
  )
  expect(screen.getByLabelText('成片预览')).toBeVisible()
  await user.click(screen.getByRole('button', { name: '关闭成片预览' }))
  expect(onPreviewOpenChange).toHaveBeenCalledWith(false)
})

it('工作台交接消息在尚未生成时也能打开已有右侧区域', async () => {
  const value = production('storyboard_submitted')
  vi.mocked(useIndustrialVideoProduction).mockReturnValue({
    ...value,
    record: { ...value.record!, jobId: null },
    job: null
  })
  function ReviewMessage() {
    const attachments = useToolResultAttachments()
    return attachments?.('mcp__meacowork-tools__ivideo_review_snapshot_get', {
      content: [{ type: 'text', text: '{"ok":true,"workbench_url":"https://example.test/workbench"}' }]
    })
  }
  render(
    <IndustrialVideoAgentProduction sessionId="s" workbench={<div>服务端工作台内容</div>}>
      <IndustrialVideoReviewFilesProvider>
        <ReviewMessage />
      </IndustrialVideoReviewFilesProvider>
    </IndustrialVideoAgentProduction>
  )
  const link = screen.getByRole('link', { name: '打开脚本工作台' })
  expect(link).toHaveAttribute('href', 'https://example.test/workbench')
  expect(screen.queryByTestId('workbench-browser')).toBeNull()
  await userEvent.click(link)
  expect(screen.getByTestId('workbench-browser')).toHaveAttribute('data-src', 'https://example.test/workbench')
  expect(screen.queryByText('服务端工作台内容')).toBeNull()
  expect(screen.queryByRole('button', { name: '打开服务端工作台' })).toBeNull()
})

it.each(['canceled', 'cancelled'])('服务端 %s 终态不再显示正在生成', async (status) => {
  vi.mocked(useIndustrialVideoProduction).mockReturnValue({ ...production(status), job: { run: 'r', status } })
  render(<IndustrialVideoAgentProduction sessionId="s">消息流</IndustrialVideoAgentProduction>)
  expect(await screen.findByLabelText('成片预览')).toHaveTextContent('已取消（取消不等于暂停）')
  expect(screen.queryByText('正在生成分镜视频')).toBeNull()
})

it('取消待核实时保留真实进度但不宣称已停止或继续生成', async () => {
  const value = production('generating', { scenes_total: 5, scenes_done: 2 })
  value.record!.control = { epoch: 1, stopRequested: true, phase: 'reconcile_required' }
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(value)
  render(<IndustrialVideoAgentProduction sessionId="s">消息流</IndustrialVideoAgentProduction>)
  expect(await screen.findByLabelText('成片预览')).toHaveTextContent('已请求取消，正在核实服务端状态')
  expect(screen.getByLabelText('成片预览')).toHaveTextContent('已完成 2/5 个分镜')
  expect(screen.queryByText('正在生成分镜视频')).toBeNull()
  expect(screen.queryByText('任务已停止')).toBeNull()
})

const refresh = vi.fn(async () => {})
function production(state = 'generating', progress: Record<string, unknown> = {}) {
  return {
    record: {
      sessionId: 's',
      run: 'r',
      jobId: 'j',
      state,
      version: 1,
      rounds: [
        {
          run: 'r',
          jobId: 'j',
          outcome: 'ok',
          operation: 'video_start',
          version: 1,
          state: 'generating',
          requestId: 'req',
          at: 1
        }
      ],
      unknownSubmissions: [],
      updatedAt: 1
    },
    job: { run: 'r', progress },
    error: '',
    jobError: '',
    refresh
  } as ReturnType<typeof useIndustrialVideoProduction>
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(production())
  vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
    if (channel === 'industrial_video.storyboard_get') return { scenes: [{ id: 1 }, { id: 2 }, { id: 3 }] } as never
    return { filePath: '/workspace/final.mp4' } as never
  })
})
it('keeps messages visible before task records load and recovers when they arrive', async () => {
  vi.mocked(useIndustrialVideoProduction).mockReturnValue({ ...production(), record: null, job: null })
  const { rerender } = render(<IndustrialVideoAgentProduction sessionId="s">消息流</IndustrialVideoAgentProduction>)
  expect(screen.getByText('消息流')).toBeInTheDocument()
  expect(screen.queryByLabelText('成片预览')).toBeNull()

  vi.mocked(useIndustrialVideoProduction).mockReturnValue(production())
  rerender(<IndustrialVideoAgentProduction sessionId="s">消息流</IndustrialVideoAgentProduction>)
  expect(await screen.findByLabelText('成片预览')).toHaveTextContent('共 3 个分镜')
  expect(screen.getByText('消息流')).toBeInTheDocument()
})
it('shows authoritative server counts and assembly stage in the right preview', () => {
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(
    production('generating', { scenes_total: 5, scenes_done: 3, stage_current: 'assemble' })
  )
  render(<IndustrialVideoAgentProduction sessionId="s">消息流</IndustrialVideoAgentProduction>)
  expect(screen.getByLabelText('成片预览')).toHaveTextContent('已完成 3/5 个分镜')
  expect(screen.getByLabelText('成片预览')).toHaveTextContent('正在合成成片')
})
// 防止合成中的临时过期标记覆盖实时进度并停止制作动效。
it.each([
  ['generating', 'video', '正在生成分镜视频'],
  ['generating', 'assemble', '正在合成成片'],
  ['assembling', 'assemble', '正在合成成片']
])('keeps %s/%s progress visible when the artifact is stale', async (state, stage, label) => {
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(
    production(state, { stage_current: stage, scenes_total: 4, scenes_done: 3, final: 'final.mp4', final_stale: true })
  )
  render(
    <IndustrialVideoAgentProduction sessionId="s">
      <StartMessage />
    </IndustrialVideoAgentProduction>
  )
  await waitFor(() => expect(screen.getByLabelText('成片预览')).toHaveTextContent(label))
  expect(screen.getByLabelText('视频制作步骤')).toHaveTextContent(label)
  expect(screen.queryByText(/当前成片已过期/)).toBeNull()
  expect(screen.getByLabelText('视频制作实时进度')).toHaveAttribute('data-animating', 'true')
  expect(screen.queryByTitle('成片在线播放')).toBeNull()
})

// 防止汇总完成数被错误地解释为按顺序完成，以及轮询重复追加卡片、抢回焦点。
it('uses actual storyboard count, keeps one card and respects closing the preview', async () => {
  const { rerender } = render(
    <IndustrialVideoAgentProduction sessionId="s">
      <IndustrialVideoReviewFilesProvider>
        <StartMessage />
      </IndustrialVideoReviewFilesProvider>
    </IndustrialVideoAgentProduction>
  )
  expect(await screen.findByText('生成分镜 3')).toBeInTheDocument()
  expect(screen.getByLabelText('成片预览')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '关闭成片预览' }))
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(production('generating', { scenes_done: 1, total_scenes: 3 }))
  rerender(
    <IndustrialVideoAgentProduction sessionId="s">
      <IndustrialVideoReviewFilesProvider>
        <StartMessage />
      </IndustrialVideoReviewFilesProvider>
    </IndustrialVideoAgentProduction>
  )
  expect(screen.queryByLabelText('成片预览')).toBeNull()
  expect(screen.getAllByLabelText('视频制作步骤')).toHaveLength(1)
  expect(screen.getByLabelText('启动工具消息')).toContainElement(screen.getByLabelText('视频制作步骤'))
  expect(screen.getByText('生成分镜 1').closest('li')).toHaveTextContent('详细进度待返回')
  expect(screen.getByText('已完成 1/3 镜')).toBeInTheDocument()
})
it('hides the duplicate online preview while a local video is open, without downloading again', async () => {
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(
    production('done', { final: 'final.mp4', preview_url: 'https://video.example/preview?sig=x' })
  )
  const view = render(
    <IndustrialVideoAgentProduction sessionId="s" filePreviewActive>
      消息流
    </IndustrialVideoAgentProduction>
  )
  expect(screen.queryByLabelText('成片预览')).toBeNull()
  expect(screen.getByText('消息流')).toBeInTheDocument()
  expect(ipcApi.request).not.toHaveBeenCalledWith('industrial_video.download_artifact', expect.anything())
  view.rerender(
    <IndustrialVideoAgentProduction sessionId="s" filePreviewActive={false}>
      消息流
    </IndustrialVideoAgentProduction>
  )
  expect(await screen.findByTitle('成片在线播放')).toHaveAttribute('src', 'https://video.example/preview?sig=x')
})

it('keeps generation progress in the sidebar even when a local file preview is active', async () => {
  render(
    <IndustrialVideoAgentProduction sessionId="s" filePreviewActive>
      消息流
    </IndustrialVideoAgentProduction>
  )
  expect(await screen.findByLabelText('成片预览')).toBeInTheDocument()
})

it('replaces loading with online preview and downloads only when requested', async () => {
  const { rerender } = render(<IndustrialVideoAgentProduction sessionId="s">消息流</IndustrialVideoAgentProduction>)
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(
    production('done', {
      final: 'output/final.mp4',
      preview_url: 'https://video.example/preview?sig=x'
    })
  )
  rerender(<IndustrialVideoAgentProduction sessionId="s">消息流</IndustrialVideoAgentProduction>)
  // 原 preview_url 字段保留，但成片优先使用媒体地址播放。
  expect(await screen.findByTitle('成片在线播放')).toHaveAttribute('src', 'https://video.example/preview?sig=x')
  expect(ipcApi.request).not.toHaveBeenCalledWith('industrial_video.download_artifact', expect.anything())
  fireEvent.click(screen.getByRole('button', { name: '下载 MP4' }))
  await screen.findByText('已保存：/workspace/final.mp4')
  expect(ipcApi.request).toHaveBeenCalledWith('industrial_video.save_artifact', {
    sessionId: 's',
    run: 'r',
    path: 'output/final.mp4'
  })
})
it('does not open before a real generation job, or download a stale artifact', async () => {
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(production('planning'))
  const { rerender } = render(<IndustrialVideoAgentProduction sessionId="s">消息流</IndustrialVideoAgentProduction>)
  expect(screen.queryByLabelText('视频制作步骤')).toBeNull()
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(production('done', { final: 'old.mp4', final_stale: true }))
  rerender(<IndustrialVideoAgentProduction sessionId="s">消息流</IndustrialVideoAgentProduction>)
  await waitFor(() => expect(screen.getByLabelText('成片预览')).toHaveTextContent('当前成片已过期，请等待当前版本生成'))
  expect(ipcApi.request).not.toHaveBeenCalledWith('industrial_video.download_artifact', expect.anything())
})
it('stops loading on failure and lets preview link refresh without regenerating', async () => {
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(production('failed'))
  const { rerender } = render(<IndustrialVideoAgentProduction sessionId="s">消息流</IndustrialVideoAgentProduction>)
  expect(screen.getByLabelText('成片预览')).toHaveTextContent('生成失败')
  let downloadFailed = false
  vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
    if (channel === 'industrial_video.storyboard_get') return { scenes: [{ id: 1 }] } as never
    if (!downloadFailed) {
      downloadFailed = true
      throw new Error('download failed')
    }
    return { preview_url: 'https://video.example/preview?sig=new' } as never
  })
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(production('done', { final: 'final.mp4' }))
  rerender(<IndustrialVideoAgentProduction sessionId="s">消息流</IndustrialVideoAgentProduction>)
  expect(await screen.findByRole('alert')).toHaveTextContent('预览加载失败')
  fireEvent.click(screen.getByRole('button', { name: '刷新预览链接' }))
  expect(await screen.findByTitle('成片在线播放')).toBeInTheDocument()
  expect(vi.mocked(ipcApi.request).mock.calls.some(([channel]) => channel === 'industrial_video.video_start')).toBe(
    false
  )
})
// 顶栏受控显隐：关闭/查看按钮与顶栏状态同步；初始刷新（poll）不自动打开，不覆盖用户收起。
it('受控模式：初始刷新（poll）不自动打开受控面板，也不回调强行打开', async () => {
  const onPreviewOpenChange = vi.fn()
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(production())
  const { rerender } = render(
    <IndustrialVideoAgentProduction sessionId="s" previewOpen={false} onPreviewOpenChange={onPreviewOpenChange}>
      <IndustrialVideoReviewFilesProvider>
        <StartMessage />
      </IndustrialVideoReviewFilesProvider>
    </IndustrialVideoAgentProduction>
  )
  // 即便 visible（有 run/jobId 且生成确认），受控关闭也不自动打开
  expect(screen.queryByLabelText('成片预览')).toBeNull()
  // 模拟轮询刷新后再次渲染，仍保持关闭
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(production('generating', { scenes_done: 2, total_scenes: 3 }))
  rerender(
    <IndustrialVideoAgentProduction sessionId="s" previewOpen={false} onPreviewOpenChange={onPreviewOpenChange}>
      <IndustrialVideoReviewFilesProvider>
        <StartMessage />
      </IndustrialVideoReviewFilesProvider>
    </IndustrialVideoAgentProduction>
  )
  expect(screen.queryByLabelText('成片预览')).toBeNull()
  expect(onPreviewOpenChange).not.toHaveBeenCalled()
})
it('受控模式：关闭/查看按钮与顶栏状态同步（回调布尔值）', async () => {
  const onPreviewOpenChange = vi.fn()
  const { rerender } = render(
    <IndustrialVideoAgentProduction sessionId="s" previewOpen={true} onPreviewOpenChange={onPreviewOpenChange}>
      <IndustrialVideoReviewFilesProvider>
        <StartMessage />
      </IndustrialVideoReviewFilesProvider>
    </IndustrialVideoAgentProduction>
  )
  expect(await screen.findByLabelText('成片预览')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '关闭成片预览' }))
  expect(onPreviewOpenChange).toHaveBeenCalledWith(false)
  // 受控关闭后保持关闭，poll 不抢开
  rerender(
    <IndustrialVideoAgentProduction sessionId="s" previewOpen={false} onPreviewOpenChange={onPreviewOpenChange}>
      <IndustrialVideoReviewFilesProvider>
        <StartMessage />
      </IndustrialVideoReviewFilesProvider>
    </IndustrialVideoAgentProduction>
  )
  expect(screen.queryByLabelText('成片预览')).toBeNull()
  // 从关闭态点击“查看成片”请求打开
  fireEvent.click(screen.getByRole('button', { name: '查看成片' }))
  expect(onPreviewOpenChange).toHaveBeenCalledWith(true)
})
