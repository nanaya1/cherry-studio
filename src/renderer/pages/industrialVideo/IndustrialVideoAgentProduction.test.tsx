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
const { openArtifactFile } = vi.hoisted(() => ({ openArtifactFile: vi.fn(async (_path: string) => {}) }))
vi.mock('@renderer/pages/agents/components/AgentRightPane', () => ({
  useAgentRightPaneActions: () => ({ openArtifactFile })
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
it.each(['unknown', 'intended'])('无jobId的%s提交明确待确认，不下载旧成片或猜测任务', async (outcome) => {
  const value = production('done', { final: 'old.mp4' })
  const round = { ...value.record!.rounds[0], outcome: outcome as 'unknown' | 'intended', jobId: null }
  value.record!.jobId = null
  value.record!.rounds.push(round)
  if (outcome === 'unknown') value.record!.unknownSubmissions.push(round)
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(value)
  render(
    <IndustrialVideoAgentProduction sessionId="s">
      <StartMessage />
    </IndustrialVideoAgentProduction>
  )
  expect(screen.getByLabelText('提交结果待确认')).toHaveTextContent('不代表生成失败')
  expect(screen.getByLabelText('提交结果待确认')).toHaveTextContent('请联系服务端核实')
  expect(ipcApi.request).not.toHaveBeenCalledWith('industrial_video.download_artifact', expect.anything())
  expect(openArtifactFile).not.toHaveBeenCalled()
})

it('旧任务已完成但仍有未知提交时，不以旧成片冒充本次结果', () => {
  const value = production('done', { final: 'old.mp4' })
  value.record!.unknownSubmissions.push({ ...value.record!.rounds[0], outcome: 'unknown', jobId: null })
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(value)
  render(
    <IndustrialVideoAgentProduction sessionId="s">
      <StartMessage />
    </IndustrialVideoAgentProduction>
  )
  expect(screen.getByLabelText('提交结果待确认')).toHaveTextContent('正在查询已绑定任务')
  expect(screen.queryByLabelText('成片交付状态')).toBeNull()
  expect(screen.queryByText('视频生成完成')).toBeNull()
  expect(ipcApi.request).not.toHaveBeenCalledWith('industrial_video.download_artifact', expect.anything())
})

it('完成后自动下载，在消息展示文件并只打开一次现有文件预览', async () => {
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(production('done', { final: 'output/final.mp4' }))
  const onPreviewOpenChange = vi.fn()
  const content = (
    <IndustrialVideoAgentProduction sessionId="s" previewOpen onPreviewOpenChange={onPreviewOpenChange}>
      <StartMessage />
    </IndustrialVideoAgentProduction>
  )
  const view = render(content)
  await waitFor(() => expect(openArtifactFile).toHaveBeenCalledWith('/workspace/final.mp4'))
  // 成功按钮（final.mp4）位于消息附件内，而非独立预览侧栏。
  expect(screen.getByLabelText('启动工具消息')).toHaveTextContent('final.mp4')
  expect(screen.queryByLabelText('成片预览')).toBeNull()
  expect(onPreviewOpenChange).toHaveBeenCalledWith(false)
  view.rerender(content)
  expect(openArtifactFile).toHaveBeenCalledTimes(1)
  expect(
    vi.mocked(ipcApi.request).mock.calls.filter(([name]) => name === 'industrial_video.download_artifact')
  ).toHaveLength(1)
})

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

// 终态（done/failed/blocked/canceled/取消待核实）不再渲染成片 loading 侧栏，
// 终端提示与文件统一在 StartMessage 附件中展示。
it.each(['canceled', 'cancelled'])('服务端 %s 终态在消息中提示，不再显示成片侧栏', async (status) => {
  vi.mocked(useIndustrialVideoProduction).mockReturnValue({ ...production(status), job: { run: 'r', status } })
  render(
    <IndustrialVideoAgentProduction sessionId="s">
      <StartMessage />
    </IndustrialVideoAgentProduction>
  )
  expect(await screen.findByLabelText('启动工具消息')).toHaveTextContent('已取消（取消不等于暂停）')
  expect(screen.queryByLabelText('成片预览')).toBeNull()
  expect(screen.queryByText('正在生成分镜视频')).toBeNull()
})

it('取消待核实时在消息提示核实状态，不宣称已停止或继续生成', async () => {
  const value = production('generating', { scenes_total: 5, scenes_done: 2 })
  value.record!.control = { epoch: 1, stopRequested: true, phase: 'reconcile_required' }
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(value)
  render(
    <IndustrialVideoAgentProduction sessionId="s">
      <StartMessage />
    </IndustrialVideoAgentProduction>
  )
  expect(await screen.findByLabelText('启动工具消息')).toHaveTextContent('已请求取消，正在核实服务端状态')
  expect(screen.queryByLabelText('成片预览')).toBeNull()
  expect(screen.queryByText('正在生成分镜视频')).toBeNull()
  expect(screen.queryByText('任务已停止')).toBeNull()
})

it.each([
  ['needs_source_review', '资料待核对'],
  ['awaiting_scene_review', '镜头待审核'],
  ['awaiting_script_review', '脚本与分镜待确认']
])('阻塞阶段 %s 在消息提示原因并引导网页处理，不误报完成', async (stage, label) => {
  vi.mocked(useIndustrialVideoProduction).mockReturnValue({
    ...production('done', { stage_current: stage, final: 'old.mp4' }),
    job: { run: 'r', status: 'blocked', progress: { stage_current: stage, final: 'old.mp4' } }
  })
  render(
    <IndustrialVideoAgentProduction sessionId="s">
      <StartMessage />
    </IndustrialVideoAgentProduction>
  )
  expect(await screen.findByLabelText('启动工具消息')).toHaveTextContent(label)
  expect(screen.getByLabelText('启动工具消息')).toHaveTextContent('请回到服务端工作台处理后，再发起生成')
  expect(screen.queryByLabelText('成片预览')).toBeNull()
  expect(screen.queryByText('视频生成完成')).toBeNull()
})

it('完成但过期的成片在消息标记历史版本，不显示成片侧栏', async () => {
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(production('done', { final: 'old.mp4', final_stale: true }))
  render(
    <IndustrialVideoAgentProduction sessionId="s">
      <StartMessage />
    </IndustrialVideoAgentProduction>
  )
  expect(await screen.findByLabelText('启动工具消息')).toHaveTextContent('历史版本，不能作为当前版本结果')
  expect(screen.queryByLabelText('成片预览')).toBeNull()
  expect(screen.queryByText('视频生成完成')).toBeNull()
})

it.each([
  [
    { delivery_status: 'passed', review_only: false, report_stale: false, quality_gate_report: { gates: {} } },
    '可交付'
  ],
  [
    { delivery_status: 'passed', review_only: true, report_stale: false, quality_gate_report: { gates: {} } },
    '仅供审核，不作为正式交付'
  ],
  [
    { delivery_status: 'passed', review_only: false, report_stale: true, quality_gate_report: { gates: {} } },
    '报告已过期，需重新审核'
  ],
  [
    { delivery_status: 'blocked', review_only: false, report_stale: false, quality_gate_report: { gates: {} } },
    '交付被阻塞'
  ],
  [
    { delivery_status: 'review_required', review_only: false, report_stale: false, quality_gate_report: { gates: {} } },
    '待人工审核'
  ],
  [{ delivery_status: 'passed' }, '交付状态待确认'],
  [{}, '交付状态待确认']
])('完成后根据QA展示交付状态：%j', async (qa, text) => {
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(production('done', { final: 'final.mp4' }))
  vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
    if (channel === 'industrial_video.qa_get') return qa as never
    return {} as never
  })
  render(<IndustrialVideoAgentProduction sessionId="s">消息流</IndustrialVideoAgentProduction>)
  await waitFor(() => expect(screen.getByLabelText('成片交付状态')).toHaveTextContent(text))
  expect(ipcApi.request).toHaveBeenCalledWith('industrial_video.qa_get', { sessionId: 's', run: 'r' })
})

it('切换会话后迟到QA通过不能覆盖新会话', async () => {
  let resolveOld!: (value: unknown) => void
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(production('done', { final: 'final.mp4' }))
  vi.mocked(ipcApi.request).mockImplementation(async (channel, input) => {
    if (channel === 'industrial_video.qa_get' && (input as { sessionId: string }).sessionId === 's')
      return new Promise((resolve) => {
        resolveOld = resolve
      }) as never
    return {} as never
  })
  const { rerender } = render(<IndustrialVideoAgentProduction sessionId="s">消息流</IndustrialVideoAgentProduction>)
  await waitFor(() => expect(resolveOld).toBeDefined())
  rerender(<IndustrialVideoAgentProduction sessionId="new">新消息流</IndustrialVideoAgentProduction>)
  resolveOld({ delivery_status: 'passed', review_only: false, report_stale: false, quality_gate_report: { gates: {} } })
  await waitFor(() => expect(screen.getByLabelText('成片交付状态')).toHaveTextContent('交付状态待确认'))
  expect(screen.getByLabelText('成片交付状态')).not.toHaveTextContent('可交付')
})

it('QA查询失败不报生成失败，也不沿用通过结论', async () => {
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(production('done', { final: 'final.mp4' }))
  vi.mocked(ipcApi.request).mockRejectedValue(new Error('offline'))
  render(<IndustrialVideoAgentProduction sessionId="s">消息流</IndustrialVideoAgentProduction>)
  await waitFor(() => expect(screen.getByLabelText('成片交付状态')).toHaveTextContent('QA查询失败，交付状态待确认'))
  expect(screen.queryByText('生成失败')).toBeNull()
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

/* 旧行为（独立在线预览 / 本地视频打开时隐藏在线预览）已停用，改为消息内自动下载成片。
   保留以下用例以备对照，不再执行。
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
*/

// 新行为：成片完成后无论本地预览是否激活都自动下载，并在消息内展示文件（等价替代在线预览）。
it('成片完成后无论本地预览是否激活都自动下载并在消息内展示文件', async () => {
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(production('done', { final: 'final.mp4' }))
  render(
    <IndustrialVideoAgentProduction sessionId="s" filePreviewActive>
      <StartMessage />
    </IndustrialVideoAgentProduction>
  )
  await waitFor(() => expect(openArtifactFile).toHaveBeenCalledWith('/workspace/final.mp4'))
  expect(screen.getByLabelText('启动工具消息')).toHaveTextContent('final.mp4')
  expect(screen.queryByTitle('成片在线播放')).toBeNull()
  expect(
    vi.mocked(ipcApi.request).mock.calls.filter(([name]) => name === 'industrial_video.download_artifact')
  ).toHaveLength(1)
})

it('keeps generation progress in the sidebar even when a local file preview is active', async () => {
  render(
    <IndustrialVideoAgentProduction sessionId="s" filePreviewActive>
      消息流
    </IndustrialVideoAgentProduction>
  )
  expect(await screen.findByLabelText('成片预览')).toBeInTheDocument()
})

/* 旧行为（成片在线预览 + 手动“下载 MP4”另存 save_artifact）已停用，改为自动下载并复用文件预览。
   保留以下用例以备对照，不再执行。
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
*/

// 新行为：成片完成后自动下载并复用文件预览，消息内按钮点击重新打开文件而非另存。
it('成片完成后自动下载并复用文件预览，按钮点击重新打开文件而非另存', async () => {
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(production('done', { final: 'output/final.mp4' }))
  render(
    <IndustrialVideoAgentProduction sessionId="s">
      <StartMessage />
    </IndustrialVideoAgentProduction>
  )
  const button = await screen.findByRole('button', { name: 'final.mp4' })
  await waitFor(() => expect(openArtifactFile).toHaveBeenCalled())
  // 默认自动下载，无需手动“下载 MP4”另存。
  expect(ipcApi.request).toHaveBeenCalledWith('industrial_video.download_artifact', {
    sessionId: 's',
    run: 'r',
    path: 'output/final.mp4'
  })
  expect(ipcApi.request).not.toHaveBeenCalledWith('industrial_video.save_artifact', expect.anything())
  // 消息内按钮二次打开文件。
  openArtifactFile.mockClear()
  fireEvent.click(button)
  await waitFor(() => expect(openArtifactFile).toHaveBeenCalledWith('/workspace/final.mp4'))
})

it('生成前不打开成片区域，过期成片不下载并标记历史版本', async () => {
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(production('planning'))
  const { rerender } = render(
    <IndustrialVideoAgentProduction sessionId="s">
      <StartMessage />
    </IndustrialVideoAgentProduction>
  )
  expect(screen.queryByLabelText('视频制作步骤')).toBeNull()
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(production('done', { final: 'old.mp4', final_stale: true }))
  rerender(
    <IndustrialVideoAgentProduction sessionId="s">
      <StartMessage />
    </IndustrialVideoAgentProduction>
  )
  expect(await screen.findByLabelText('启动工具消息')).toHaveTextContent('历史版本，不能作为当前版本结果')
  expect(screen.queryByLabelText('成片预览')).toBeNull()
  expect(ipcApi.request).not.toHaveBeenCalledWith('industrial_video.download_artifact', expect.anything())
})

it('失败终态在消息提示生成失败，不显示成片侧栏，也不下载', async () => {
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(production('failed'))
  render(
    <IndustrialVideoAgentProduction sessionId="s">
      <StartMessage />
    </IndustrialVideoAgentProduction>
  )
  expect(await screen.findByLabelText('启动工具消息')).toHaveTextContent('生成失败')
  expect(screen.queryByLabelText('成片预览')).toBeNull()
  expect(ipcApi.request).not.toHaveBeenCalledWith('industrial_video.download_artifact', expect.anything())
  expect(vi.mocked(ipcApi.request).mock.calls.some(([channel]) => channel === 'industrial_video.video_start')).toBe(
    false
  )
})

// 自动下载失败时提供重试入口，重试只重试下载，不重新发起生成。
it('自动下载失败后重试只重试下载，不重新生成', async () => {
  let attempt = 0
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(production('done', { final: 'final.mp4' }))
  vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
    if (channel === 'industrial_video.download_artifact') {
      attempt++
      if (attempt === 1) throw new Error('download failed')
      return { filePath: '/workspace/final.mp4' } as never
    }
    return {} as never
  })
  render(
    <IndustrialVideoAgentProduction sessionId="s">
      <StartMessage />
    </IndustrialVideoAgentProduction>
  )
  expect(await screen.findByRole('alert')).toHaveTextContent('生成已完成，但自动下载失败')
  fireEvent.click(screen.getByRole('button', { name: '重试下载' }))
  expect(await screen.findByRole('button', { name: 'final.mp4' })).toBeInTheDocument()
  expect(vi.mocked(ipcApi.request).mock.calls.some(([channel]) => channel === 'industrial_video.video_start')).toBe(
    false
  )
  expect(attempt).toBe(2)
})

// 延迟下载在切换会话后不应以旧会话的成片抢开预览或调用旧路径打开。
it('延迟下载在切换会话后不调用旧会话预览打开', async () => {
  let resolveDownload!: (value: { filePath: string }) => void
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(production('done', { final: 'a.mp4' }))
  vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
    if (channel === 'industrial_video.download_artifact')
      return new Promise((resolve) => {
        resolveDownload = resolve
      }) as never
    return {} as never
  })
  const { rerender } = render(
    <IndustrialVideoAgentProduction sessionId="s">
      <StartMessage />
    </IndustrialVideoAgentProduction>
  )
  await waitFor(() => expect(resolveDownload).toBeDefined())
  // 切到新会话（生成中，无成片），不应被旧下载抢开预览。
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(production('generating'))
  rerender(
    <IndustrialVideoAgentProduction sessionId="new">
      <StartMessage />
    </IndustrialVideoAgentProduction>
  )
  resolveDownload({ filePath: '/workspace/a.mp4' })
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(openArtifactFile).not.toHaveBeenCalled()
  expect(screen.queryByText('a.mp4')).toBeNull()
})

// 重复轮询（多次 rerender）同一完成态只下载一次，不重复打开预览。
it('重复轮询同一完成态只调用一次下载', async () => {
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(production('done', { final: 'final.mp4' }))
  const { rerender } = render(
    <IndustrialVideoAgentProduction sessionId="s">
      <StartMessage />
    </IndustrialVideoAgentProduction>
  )
  await waitFor(() => expect(openArtifactFile).toHaveBeenCalledTimes(1))
  for (let index = 0; index < 3; index++) {
    rerender(
      <IndustrialVideoAgentProduction sessionId="s">
        <StartMessage />
      </IndustrialVideoAgentProduction>
    )
  }
  await waitFor(() => expect(openArtifactFile).toHaveBeenCalledTimes(1))
  expect(
    vi.mocked(ipcApi.request).mock.calls.filter(([name]) => name === 'industrial_video.download_artifact')
  ).toHaveLength(1)
})

// Windows 路径成片下载后以文件名展示打开按钮，并按原路径发起下载。
it.each([
  ['C:\\output\\final.mp4', 'final.mp4'],
  ['C:/output/final.mp4', 'final.mp4'],
  ['D:\\Movies\\clip.mp4', 'clip.mp4']
])('Windows 路径成片下载后以文件名展示打开按钮：%s', async (finalPath, name) => {
  vi.mocked(useIndustrialVideoProduction).mockReturnValue(production('done', { final: finalPath }))
  vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
    if (channel === 'industrial_video.download_artifact') return { filePath: finalPath } as never
    return {} as never
  })
  render(
    <IndustrialVideoAgentProduction sessionId="s">
      <StartMessage />
    </IndustrialVideoAgentProduction>
  )
  const button = await screen.findByRole('button', { name })
  expect(button).toHaveAttribute('title', expect.stringContaining(name))
  expect(vi.mocked(ipcApi.request)).toHaveBeenCalledWith('industrial_video.download_artifact', {
    sessionId: 's',
    run: 'r',
    path: finalPath
  })
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
