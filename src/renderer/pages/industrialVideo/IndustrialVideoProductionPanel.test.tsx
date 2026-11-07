import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/ipc', () => ({ ipcApi: { request: vi.fn() } }))
import { ipcApi } from '@renderer/ipc'

import IndustrialVideoProductionPanel from './IndustrialVideoProductionPanel'
import { createIndustrialVideoSettings } from './industrialVideoSettings'

const baseRecord = {
  sessionId: 's',
  version: 1,
  run: 'r',
  jobId: null as string | null,
  state: 'storyboard_submitted',
  rounds: [] as unknown[],
  unknownSubmissions: [] as unknown[],
  updatedAt: 1
}

const planningContext = { effective_settings: { settings_version: 1 } }

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
    if (channel === 'industrial_video.get_records') return { ...baseRecord } as never
    if (channel === 'industrial_video.planning_context_get') return planningContext as never
    if (channel === 'industrial_video.storyboard_get')
      return { storyboard: { video_title: '产品', scenes: [{ id: 1, title: '全景' }] } } as never
    if (channel === 'industrial_video.estimate') return { estimate: { cost: 12 } } as never
    if (channel === 'industrial_video.review_snapshot_get' || channel === 'industrial_video.review_confirm')
      return { review_version: 'approved-1', generation_allowed: true, remaining_blockers: [] } as never
    return { jobId: 'j' } as never
  })
})

const callArgs = (channel: string) =>
  vi
    .mocked(ipcApi.request)
    .mock.calls.filter(([c]) => c === channel)
    .map(([, a]) => a)

describe('工业视频付费生成确认边界', () => {
  it('job 的 progress.final 作为成片路径进入下载入口，不读取 preview_create 的 final_path', async () => {
    vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
      if (channel === 'industrial_video.get_records') return { ...baseRecord, state: 'done', jobId: 'j' } as never
      if (channel === 'industrial_video.job_get')
        return { job_id: 'j', status: 'done', progress: { final: 'r/final.mp4' } } as never
      if (channel === 'industrial_video.preview_create') return { preview_url: 'https://example.com/p/r' } as never
      if (channel === 'industrial_video.download_artifact') return { filePath: '/workspace/final.mp4' } as never
      return {} as never
    })
    render(<IndustrialVideoProductionPanel sessionId="s" settings={createIndustrialVideoSettings('marketing')} />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: '成片路径' })).toHaveValue('r/final.mp4'))
    fireEvent.click(screen.getByRole('button', { name: '下载至任务工作目录' }))
    expect(await screen.findByText('已保存：/workspace/final.mp4')).toBeInTheDocument()
    expect(ipcApi.request).toHaveBeenCalledWith('industrial_video.download_artifact', {
      sessionId: 's',
      run: 'r',
      path: 'r/final.mp4'
    })
  })

  it('未知提交可输入服务端任务ID对账，不能自动重新生成', async () => {
    vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
      if (channel === 'industrial_video.get_records')
        return { ...baseRecord, state: 'generating', unknownSubmissions: [{}] } as never
      return { run: 'r', status: 'done' } as never
    })
    render(<IndustrialVideoProductionPanel sessionId="s" settings={createIndustrialVideoSettings('marketing')} />)
    fireEvent.change(await screen.findByRole('textbox', { name: '待对账任务 ID' }), {
      target: { value: 'job-recovered' }
    })
    fireEvent.click(screen.getByRole('button', { name: '确认任务归属并恢复' }))
    await waitFor(() =>
      expect(ipcApi.request).toHaveBeenCalledWith('industrial_video.job_get', {
        sessionId: 's',
        jobId: 'job-recovered'
      })
    )
    expect(vi.mocked(ipcApi.request).mock.calls.some(([route]) => route === 'industrial_video.video_start')).toBe(false)
  })

  it('读取草稿和预检都不能生成，只有明确确认才提交一次', async () => {
    render(<IndustrialVideoProductionPanel sessionId="s" settings={createIndustrialVideoSettings('marketing')} />)
    fireEvent.click(await screen.findByRole('button', { name: '读取已存分镜' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认脚本与分镜' }))
    const confirm = await screen.findByRole('button', { name: '确认开始生成（可能计费）' })
    expect(callArgs('industrial_video.video_start')).toHaveLength(0)
    fireEvent.click(confirm)
    await waitFor(() => expect(callArgs('industrial_video.video_start')).toHaveLength(1))
  })

  it('审核有阻塞项时不能出现生成确认入口', async () => {
    const original = vi.mocked(ipcApi.request).getMockImplementation()!
    vi.mocked(ipcApi.request).mockImplementation(async (route, input) => {
      if (route === 'industrial_video.review_confirm')
        return { review_version: 'blocked', generation_allowed: false, remaining_blockers: ['script'] } as never
      return original(route, input)
    })
    render(<IndustrialVideoProductionPanel sessionId="s" settings={createIndustrialVideoSettings('marketing')} />)
    fireEvent.click(await screen.findByRole('button', { name: '读取已存分镜' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认脚本与分镜' }))
    await screen.findByRole('alert')
    expect(screen.queryByRole('button', { name: '确认开始生成（可能计费）' })).not.toBeInTheDocument()
    expect(callArgs('industrial_video.video_start')).toHaveLength(0)
    expect(callArgs('industrial_video.estimate')).toHaveLength(0)
  })

  it('设置变化后旧费用批准失效，必须重新预检', async () => {
    const settings = createIndustrialVideoSettings('marketing')
    const { rerender } = render(<IndustrialVideoProductionPanel sessionId="s" settings={settings} />)
    fireEvent.click(await screen.findByRole('button', { name: '读取已存分镜' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认脚本与分镜' }))
    await screen.findByRole('button', { name: '确认开始生成（可能计费）' })
    rerender(<IndustrialVideoProductionPanel sessionId="s" settings={{ ...settings, ratio: '9:16' }} />)
    expect(screen.queryByRole('button', { name: '确认开始生成（可能计费）' })).not.toBeInTheDocument()
  })

  it('无旁白时 params 携带 ttsEnabled:false 且不传 voice，可预检与生成', async () => {
    const settings = { ...createIndustrialVideoSettings('marketing'), voice: '无旁白' as const }
    vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
      if (channel === 'industrial_video.get_records') return { ...baseRecord } as never
      if (channel === 'industrial_video.planning_context_get')
        return { effective_settings: { settings_version: 7 } } as never
      if (channel === 'industrial_video.storyboard_get')
        return { storyboard: { video_title: '产品', scenes: [{ id: 1, title: '全景' }] } } as never
      if (channel === 'industrial_video.estimate')
        return { estimate: { cost: 12 }, effectiveSettings: { ttsEnabled: false } } as never
      if (channel === 'industrial_video.video_start')
        return { jobId: 'j', effectiveSettings: { ttsEnabled: false }, settingsVersion: 7 } as never
      if (channel === 'industrial_video.review_snapshot_get' || channel === 'industrial_video.review_confirm')
        return { review_version: 'approved-1', generation_allowed: true, remaining_blockers: [] } as never
      return { jobId: 'j' } as never
    })
    render(<IndustrialVideoProductionPanel sessionId="s" settings={settings} />)
    fireEvent.click(await screen.findByRole('button', { name: '读取已存分镜' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认脚本与分镜' }))
    await screen.findByRole('button', { name: '确认开始生成（可能计费）' })
    expect(callArgs('industrial_video.estimate')).toHaveLength(0)
    // 确认生成同样携带 ttsEnabled:false
    fireEvent.click(screen.getByRole('button', { name: '确认开始生成（可能计费）' }))
    await waitFor(() =>
      expect(ipcApi.request).toHaveBeenCalledWith(
        'industrial_video.video_start',
        expect.objectContaining({ ttsEnabled: false })
      )
    )
  })

  it('仅改变音频设置不触发新 run，仍可重新预检', async () => {
    const settings = createIndustrialVideoSettings('marketing')
    const { rerender } = render(<IndustrialVideoProductionPanel sessionId="s" settings={settings} />)
    fireEvent.click(await screen.findByRole('button', { name: '读取已存分镜' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认脚本与分镜' }))
    await screen.findByRole('button', { name: '确认开始生成（可能计费）' })
    const approvalsBefore = callArgs('industrial_video.review_confirm').length
    // 仅关闭原声：planning key（类型/时长/画幅/风格）不变，不需要新 run
    rerender(<IndustrialVideoProductionPanel sessionId="s" settings={{ ...settings, withAudio: false }} />)
    fireEvent.click(screen.getByRole('button', { name: '确认脚本与分镜' }))
    await waitFor(() => {
      expect(callArgs('industrial_video.review_confirm')).toHaveLength(approvalsBefore + 1)
      expect(callArgs('industrial_video.estimate')).toHaveLength(0)
    })
    // 确认按钮仍在（未要求创建新版本）
    expect(screen.queryByRole('button', { name: '确认开始生成（可能计费）' })).toBeInTheDocument()
    expect(callArgs('industrial_video.video_start')).toHaveLength(0)
  })

  it('画幅改变使规划 key 失效，必须创建新版本并重新规划', async () => {
    const settings = createIndustrialVideoSettings('marketing')
    const { rerender } = render(<IndustrialVideoProductionPanel sessionId="s" settings={settings} />)
    fireEvent.click(await screen.findByRole('button', { name: '读取已存分镜' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认脚本与分镜' }))
    await screen.findByRole('button', { name: '确认开始生成（可能计费）' })
    rerender(<IndustrialVideoProductionPanel sessionId="s" settings={{ ...settings, ratio: '9:16' }} />)
    expect(screen.queryByRole('button', { name: '确认开始生成（可能计费）' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认脚本与分镜' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/规划|新版本|分镜/))
    expect(callArgs('industrial_video.video_start')).toHaveLength(0)
  })

  it('params 携带 planning_context_get 得到的 expectedSettingsVersion，且未知版本停止提交', async () => {
    vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
      if (channel === 'industrial_video.get_records') return { ...baseRecord } as never
      if (channel === 'industrial_video.planning_context_get') return { settings_version: 42 } as never
      if (channel === 'industrial_video.storyboard_get')
        return { storyboard: { video_title: '产品', scenes: [{ id: 1, title: '全景' }] } } as never
      if (channel === 'industrial_video.estimate') return { estimate: { cost: 12 } } as never
      if (channel === 'industrial_video.review_snapshot_get' || channel === 'industrial_video.review_confirm')
        return { review_version: 'approved-1', generation_allowed: true, remaining_blockers: [] } as never
      return { jobId: 'j' } as never
    })
    render(<IndustrialVideoProductionPanel sessionId="s" settings={createIndustrialVideoSettings('marketing')} />)
    fireEvent.click(await screen.findByRole('button', { name: '读取已存分镜' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认脚本与分镜' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认开始生成（可能计费）' }))
    await waitFor(() =>
      expect(ipcApi.request).toHaveBeenCalledWith(
        'industrial_video.video_start',
        expect.objectContaining({ expectedSettingsVersion: 42 })
      )
    )
    expect(callArgs('industrial_video.estimate')).toHaveLength(0)
  })

  it('planning_context_get 返回未知版本时停止提交并提示', async () => {
    vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
      if (channel === 'industrial_video.get_records') return { ...baseRecord } as never
      if (channel === 'industrial_video.planning_context_get') return { effective_settings: {} } as never
      if (channel === 'industrial_video.storyboard_get')
        return { storyboard: { video_title: '产品', scenes: [{ id: 1, title: '全景' }] } } as never
      if (channel === 'industrial_video.review_snapshot_get' || channel === 'industrial_video.review_confirm')
        return { review_version: 'approved-1', generation_allowed: true, remaining_blockers: [] } as never
      return { jobId: 'j' } as never
    })
    render(<IndustrialVideoProductionPanel sessionId="s" settings={createIndustrialVideoSettings('marketing')} />)
    fireEvent.click(await screen.findByRole('button', { name: '读取已存分镜' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认脚本与分镜' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/版本|停止提交|重新预检/))
    expect(callArgs('industrial_video.estimate')).toHaveLength(0)
  })

  it('409 设置冲突不自动重发，提示刷新后重新预检', async () => {
    vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
      if (channel === 'industrial_video.get_records') return { ...baseRecord } as never
      if (channel === 'industrial_video.planning_context_get')
        return { effective_settings: { settings_version: 3 } } as never
      if (channel === 'industrial_video.storyboard_get')
        return { storyboard: { video_title: '产品', scenes: [{ id: 1, title: '全景' }] } } as never
      if (channel === 'industrial_video.video_start')
        throw Object.assign(new Error('settings conflict'), { code: 'IVIDEO_HTTP_ERROR', data: { status: 409 } })
      if (channel === 'industrial_video.review_snapshot_get' || channel === 'industrial_video.review_confirm')
        return { review_version: 'approved-1', generation_allowed: true, remaining_blockers: [] } as never
      return { jobId: 'j' } as never
    })
    render(<IndustrialVideoProductionPanel sessionId="s" settings={createIndustrialVideoSettings('marketing')} />)
    fireEvent.click(await screen.findByRole('button', { name: '读取已存分镜' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认脚本与分镜' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认开始生成（可能计费）' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/冲突|重新预检/))
    // 没有自动重发
    expect(callArgs('industrial_video.video_start')).toHaveLength(1)
    expect(callArgs('industrial_video.estimate')).toHaveLength(0)
  })

  it('video_start/estimate 回执显示生效设置，requiresReplan/approvalInvalidated 清楚提示不绕过服务器', async () => {
    vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
      if (channel === 'industrial_video.get_records') return { ...baseRecord } as never
      if (channel === 'industrial_video.planning_context_get')
        return { effective_settings: { settings_version: 5 } } as never
      if (channel === 'industrial_video.storyboard_get')
        return { storyboard: { video_title: '产品', scenes: [{ id: 1, title: '全景' }] } } as never
      if (channel === 'industrial_video.video_start')
        return {
          effectiveSettings: { ttsEnabled: true, resolution: '1080P' },
          requiresReplan: true,
          approvalInvalidated: true
        } as never
      if (channel === 'industrial_video.review_snapshot_get' || channel === 'industrial_video.review_confirm')
        return { review_version: 'approved-1', generation_allowed: true, remaining_blockers: [] } as never
      return { jobId: 'j' } as never
    })
    render(<IndustrialVideoProductionPanel sessionId="s" settings={createIndustrialVideoSettings('marketing')} />)
    fireEvent.click(await screen.findByRole('button', { name: '读取已存分镜' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认脚本与分镜' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认开始生成（可能计费）' }))
    await waitFor(() => expect(screen.getByText(/生效设置/)).toBeInTheDocument())
    expect(screen.getByText(/重新规划/)).toBeInTheDocument()
    expect(screen.getByText(/生成批准失效/)).toBeInTheDocument()
  })

  it('质量状态 review_only/blocked 不禁止下载成片', async () => {
    vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
      if (channel === 'industrial_video.get_records') return { ...baseRecord, state: 'done', jobId: 'j' } as never
      if (channel === 'industrial_video.job_get')
        return { job_id: 'j', status: 'done', progress: { final: 'r/final.mp4' } } as never
      if (channel === 'industrial_video.qa_get')
        return {
          delivery_status: 'review_required',
          review_only: true,
          report_stale: false,
          final_stale: false
        } as never
      if (channel === 'industrial_video.download_artifact') return { filePath: '/workspace/final.mp4' } as never
      return {} as never
    })
    render(<IndustrialVideoProductionPanel sessionId="s" settings={createIndustrialVideoSettings('marketing')} />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: '成片路径' })).toHaveValue('r/final.mp4'))
    fireEvent.click(screen.getByRole('button', { name: '质量与失败场景' }))
    const hints = await screen.findAllByText(/review_only|自审/)
    expect(hints.some((node) => node.tagName === 'P')).toBe(true)
    // 即便处于 review_only，成片仍可下载
    fireEvent.click(screen.getByRole('button', { name: '下载至任务工作目录' }))
    expect(await screen.findByText('已保存：/workspace/final.mp4')).toBeInTheDocument()
  })

  it('preview_create 返回 http/https 的 preview_url 作网页预览，不用于 video src', async () => {
    vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
      if (channel === 'industrial_video.get_records') return { ...baseRecord, state: 'done', jobId: 'j' } as never
      if (channel === 'industrial_video.job_get')
        return { job_id: 'j', status: 'done', progress: { final: 'r/final.mp4' } } as never
      if (channel === 'industrial_video.preview_create')
        return { preview_url: 'https://preview.example.com/run/r' } as never
      return {} as never
    })
    render(<IndustrialVideoProductionPanel sessionId="s" settings={createIndustrialVideoSettings('marketing')} />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: '成片路径' })).toHaveValue('r/final.mp4'))
    fireEvent.click(screen.getByRole('button', { name: '读取预览产物信息' }))
    const link = await screen.findByRole('link', { name: /预览网页/ })
    expect(link).toHaveAttribute('href', 'https://preview.example.com/run/r')
    expect(link).toHaveAttribute('target', '_blank')
  })
})
