import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ButtonHTMLAttributes } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ipcApi } from '@renderer/ipc'

import IndustrialVideoTaskPanel from './IndustrialVideoTaskPanel'

const mocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  write: vi.fn(),
  refresh: vi.fn(),
  revision: vi.fn(),
  reload: vi.fn(),
  keepDraft: vi.fn(),
  conflict: false,
  record: { run: 'private-run', state: 'storyboard_submitted', unknownSubmissions: [], version: 1 },
  confirmVersion: 'v1',
  estimate: { total_cost: 12, currency: 'CNY' } as Record<string, unknown>,
  job: { status: 'blocked', progress: {} } as Record<string, unknown>,
  snapshot: {
    review_version: 'v1',
    generation_allowed: false,
    remaining_blockers: [],
    script: '真实脚本',
    storyboard: { video_title: '产品视频', scenes: [{ id: 1, title: '开场', narration: '原旁白', duration: 5 }] }
  }
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (key === 'industrial_video.task.confirm_cost' ? '确认开始生成（可能计费）' : key)
  })
}))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request: vi.fn() } }))
vi.mock('./industrialVideoOrchestration', () => ({ appendIndustrialVideoRevision: mocks.revision }))
vi.mock('@renderer/hooks/agent/useSession', () => ({
  useSession: () => ({ session: { workspace: { path: '/workspace' } } })
}))
vi.mock('./useIndustrialVideoProduction', () => ({
  useIndustrialVideoProduction: () => ({
    record: mocks.record,
    job: mocks.job,
    error: '',
    jobError: '',
    refresh: mocks.refresh
  })
}))
vi.mock('@renderer/components/FilePreview', () => ({
  FilePreview: ({ filePath }: { filePath: string }) => <div aria-label="文件预览">{filePath}</div>
}))
vi.mock('@cherrystudio/ui', () => ({
  Button: ({ children, onClick, disabled }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  CodeEditor: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="文档编辑器" value={value} onChange={(event) => onChange(event.target.value)} />
  )
}))
vi.mock('@renderer/hooks/useFileEditSession', async () => {
  const { useState, useEffect } = await import('react')
  return {
    useFileEditSession: (handle?: { path: string }) => {
      const [draft, setDraft] = useState('')
      const path = handle?.path
      useEffect(() => {
        setDraft(path ? (mocks.files.get(path) ?? '') : '')
      }, [path])
      return {
        status: handle ? 'ready' : 'idle',
        draft,
        isDirty: false,
        isSaving: false,
        conflict: mocks.conflict,
        reload: mocks.reload,
        keepDraft: mocks.keepDraft,
        setDraft,
        flush: async () => {
          if (handle) mocks.files.set(handle.path, draft)
        }
      }
    }
  }
})

describe('专用审核', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.files.clear()
    localStorage.clear()
    mocks.snapshot.script = '真实脚本'
    mocks.conflict = false
    mocks.record = { run: 'private-run', state: 'storyboard_submitted', unknownSubmissions: [], version: 1 }
    mocks.confirmVersion = 'v1'
    mocks.estimate = { total_cost: 12, currency: 'CNY' }
    mocks.revision.mockReturnValue({ id: 'revision' })
    mocks.snapshot.storyboard = {
      video_title: '产品视频',
      scenes: [{ id: 1, title: '开场', narration: '原旁白', duration: 5 }]
    }
    mocks.snapshot.generation_allowed = false
    mocks.job = { status: 'blocked', progress: {} }
    mocks.snapshot.review_version = 'v1'
    mocks.write.mockImplementation(async (path: string, content: string) => {
      mocks.files.set(path, content)
    })
    window.api ??= {} as typeof window.api
    Object.assign(window.api, {
      file: { ...window.api.file, write: mocks.write },
      fs: { ...window.api.fs, readText: vi.fn(async (path: string) => mocks.files.get(path) ?? '') }
    })
    vi.mocked(ipcApi.request).mockImplementation(async (route) => {
      if (route === 'industrial_video.review_snapshot_get') return structuredClone(mocks.snapshot) as never
      if (route === 'industrial_video.review_confirm') {
        mocks.snapshot.generation_allowed = true
        mocks.snapshot.review_version = mocks.confirmVersion
        return { ...mocks.snapshot, generation_allowed: true } as never
      }
      if (route === 'industrial_video.estimate') return { estimate: mocks.estimate, settingsVersion: 3 } as never
      if (route === 'industrial_video.planning_context_get')
        return { input_fingerprint: 'fp', expected_storyboard_sha256: 'sha', settings_version: 3 } as never
      if (route === 'industrial_video.storyboard_submit') {
        mocks.snapshot.review_version = 'v2'
        return { submitted: true, reviewRequired: true } as never
      }
      if (route === 'industrial_video.download_artifact' || route === 'industrial_video.save_artifact')
        return { filePath: '/workspace/final.mp4', size: 100 } as never
      // preview_create 成功返回新增的 media_url 签名，供在线预览优先使用媒体地址。
      if (route === 'industrial_video.preview_create')
        return {
          preview_url: 'https://video.example/preview?sig=x'
        } as never
      if (route === 'industrial_video.video_start' || route === 'file.show_in_folder') return {} as never
      throw new Error(`意外调用 ${route}`)
    })
  })

  it('准备阶段不读取，审核可用后自动读取且版本变化重读', async () => {
    mocks.record.state = 'planning'
    const view = render(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    expect(ipcApi.request).not.toHaveBeenCalledWith('industrial_video.review_snapshot_get', expect.anything())
    mocks.record = { ...mocks.record, state: 'storyboard_submitted', version: 2 }
    view.rerender(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    await screen.findByRole('button', { name: '脚本.md' })
    mocks.snapshot.script = '新版脚本'
    mocks.record = { ...mocks.record, version: 3 }
    view.rerender(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(expect.any(String), '新版脚本'))
    mocks.snapshot.script = '真实脚本'
  })

  it('选择修改直接打开脚本编辑，执行中禁止写回和批准', async () => {
    const user = userEvent.setup()
    const view = render(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    await user.click(await screen.findByRole('button', { name: '我要修改脚本或分镜' }))
    expect(await screen.findByRole('textbox', { name: '文档编辑器' })).toHaveValue('真实脚本')
    mocks.record = { ...mocks.record, state: 'generating' }
    view.rerender(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    expect(screen.getByRole('textbox', { name: '文档编辑器' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '确认脚本与分镜' })).toBeDisabled()
  })

  it('文字修改携带当前人工脚本，不批准旧稿', async () => {
    const user = userEvent.setup()
    render(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    await user.click(await screen.findByRole('button', { name: '我要修改脚本或分镜' }))
    fireEvent.change(await screen.findByRole('textbox', { name: '文档编辑器' }), { target: { value: '人工新脚本' } })
    const detail = { sessionId: 's', text: '缩短开场', submit: undefined as undefined | (() => Promise<void>) }
    window.dispatchEvent(new CustomEvent('industrial-video-submit-revision', { detail }))
    expect(detail.submit).toBeDefined()
    await detail.submit!()
    expect(mocks.revision).toHaveBeenCalledWith('s', expect.stringContaining('缩短开场'), '人工新脚本')
    expect(ipcApi.request).not.toHaveBeenCalledWith('industrial_video.review_confirm', expect.anything())
    expect(ipcApi.request).not.toHaveBeenCalledWith('industrial_video.video_start', expect.anything())
  })

  it('批准回执版本更新后可核验最新批准版本并生成', async () => {
    mocks.confirmVersion = 'approved-v2'
    const user = userEvent.setup()
    render(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    await user.click(await screen.findByRole('button', { name: '确认脚本与分镜' }))
    await user.click(await screen.findByRole('button', { name: /确认开始生成/ }))
    await waitFor(() => expect(ipcApi.request).toHaveBeenCalledWith('industrial_video.video_start', expect.anything()))
  })

  it('审核确认后审核版本再变更必须阻断付费', async () => {
    const user = userEvent.setup()
    render(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    await user.click(await screen.findByRole('button', { name: '确认脚本与分镜' }))
    await screen.findByRole('button', { name: /确认开始生成/ })
    mocks.snapshot.review_version = 'new-version'
    await user.click(screen.getByRole('button', { name: /确认开始生成/ }))
    await screen.findByRole('alert')
    expect(ipcApi.request).not.toHaveBeenCalledWith('industrial_video.video_start', expect.anything())
  })

  it('显式重编排先保存并读取真实脚本，不自动审批或付费且保留草稿', async () => {
    const user = userEvent.setup()
    const view = render(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    await user.click(await screen.findByRole('button', { name: '编辑文档' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '本地新脚本' } })
    expect(mocks.revision).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '按本地脚本重新编排' }))
    await waitFor(() => expect(mocks.revision).toHaveBeenCalledWith('s', expect.any(String), '本地新脚本'))
    expect(window.api.fs.readText).toHaveBeenCalledWith(expect.stringMatching(/脚本\.md$/))
    mocks.snapshot.script = '服务端不同脚本'
    mocks.record = { ...mocks.record, version: 2 }
    view.rerender(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    await user.click(screen.getByRole('button', { name: '刷新审核' }))
    expect(screen.getByRole('textbox')).toHaveValue('本地新脚本')
    expect(localStorage.length).toBeGreaterThan(0)
    expect(ipcApi.request).not.toHaveBeenCalledWith('industrial_video.video_start', expect.anything())
    expect(ipcApi.request).not.toHaveBeenCalledWith('industrial_video.review_confirm', expect.anything())
    mocks.snapshot.script = '真实脚本'
  })

  it('重编排返回相同脚本的新版本后解除阻断并重新审核', async () => {
    const user = userEvent.setup()
    const view = render(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    await user.click(await screen.findByRole('button', { name: '编辑文档' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '已采用脚本' } })
    await user.click(screen.getByRole('button', { name: '按本地脚本重新编排' }))
    await waitFor(() => expect(mocks.revision).toHaveBeenCalled())
    mocks.snapshot.script = '已采用脚本'
    mocks.snapshot.review_version = 'v2'
    mocks.record = { ...mocks.record, version: 2 }
    view.rerender(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    await waitFor(() => expect(screen.getByRole('button', { name: '确认脚本与分镜' })).toBeEnabled())
    expect(localStorage.length).toBe(0)
    expect(ipcApi.request).not.toHaveBeenCalledWith('industrial_video.review_confirm', expect.anything())
  })

  it('脚本草稿重新打开后仍保留实际文本', async () => {
    const user = userEvent.setup()
    const view = render(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    await user.click(await screen.findByRole('button', { name: '编辑文档' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '需要恢复的脚本' } })
    view.unmount()
    render(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    await user.click(await screen.findByRole('button', { name: '编辑文档' }))
    expect(screen.getByRole('textbox')).toHaveValue('需要恢复的脚本')
  })

  it('结构化分镜完整展示并可逆提交，保留提示词、旁白时间和未知字段', async () => {
    const board = {
      video_title: '产品视频',
      custom: { retain: true },
      scenes: [
        {
          id: 1,
          title: '开场',
          duration: 5,
          prompt: '真实画面',
          prompt_en: 'Real industrial product scene',
          narration: [{ start: 0, end: 5, text: '数组旁白', voice: 'original' }],
          untouched: { asset: 'a' }
        }
      ]
    }
    mocks.snapshot.storyboard = board as never
    const user = userEvent.setup()
    render(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    await user.click(await screen.findByRole('button', { name: '分镜脚本.md' }))
    await user.click(screen.getByRole('button', { name: '编辑文档' }))
    const editor = screen.getByRole<HTMLTextAreaElement>('textbox')
    expect(editor.value).toContain('真实画面')
    expect(editor.value).toContain('Real industrial product scene')
    expect(editor.value).toContain('数组旁白')
    fireEvent.change(editor, { target: { value: editor.value.replace('数组旁白', '修改数组旁白') } })
    await user.click(screen.getByRole('button', { name: '提交分镜修改' }))
    await waitFor(() =>
      expect(ipcApi.request).toHaveBeenCalledWith(
        'industrial_video.storyboard_submit',
        expect.objectContaining({
          storyboard: {
            ...board,
            scenes: [{ ...board.scenes[0], narration: [{ start: 0, end: 5, text: '修改数组旁白', voice: 'original' }] }]
          }
        })
      )
    )
  })

  it('未知费用不遍历泄露内部值，不猜测金额', async () => {
    mocks.estimate = { internal_id: 'secret-cost-token', duration: 20, currency: 'CNY' }
    const user = userEvent.setup()
    render(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    await user.click(await screen.findByRole('button', { name: '确认脚本与分镜' }))
    await screen.findByRole('button', { name: /确认开始生成/ })
    expect(ipcApi.request).not.toHaveBeenCalledWith('industrial_video.estimate', expect.anything())
    expect(screen.queryByText('secret-cost-token')).not.toBeInTheDocument()
    expect(screen.getByText(/本次生成可能产生费用/)).toBeInTheDocument()
    expect(screen.queryByText('费用预估')).not.toBeInTheDocument()
  })

  it('文件冲突可选择重新加载或保留草稿', async () => {
    mocks.conflict = true
    const user = userEvent.setup()
    render(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    await user.click(await screen.findByRole('button', { name: '保留草稿并覆盖' }))
    expect(mocks.keepDraft).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: '重新加载磁盘文件（放弃本地编辑）' }))
    expect(mocks.reload).toHaveBeenCalledOnce()
  })

  it('自动读取审核并落盘，跳过预估且必须二次确认才生成', async () => {
    const user = userEvent.setup()
    render(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    await screen.findByRole('button', { name: '脚本.md' })
    expect(mocks.write).toHaveBeenCalledWith(expect.stringMatching(/^\/workspace\/.+脚本\.md$/), '真实脚本')
    expect(screen.queryByText(/private-run|blocked|review_version/)).not.toBeInTheDocument()
    expect(ipcApi.request).not.toHaveBeenCalledWith('industrial_video.estimate', expect.anything())
    await user.click(screen.getByRole('button', { name: '确认脚本与分镜' }))
    await screen.findByRole('button', { name: /确认开始生成/ })
    const routes = vi.mocked(ipcApi.request).mock.calls.map(([route]) => route)
    expect(routes).toContain('industrial_video.review_confirm')
    expect(routes).not.toContain('industrial_video.estimate')
    expect(routes).not.toContain('industrial_video.video_start')
    await user.click(screen.getByRole('button', { name: /确认开始生成/ }))
    await waitFor(() =>
      expect(ipcApi.request).toHaveBeenCalledWith('industrial_video.video_start', {
        sessionId: 's',
        run: 'private-run',
        expectedSettingsVersion: 3
      })
    )
  })

  it('脚本修改是本地草稿，禁止旧版审批', async () => {
    const user = userEvent.setup()
    render(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    await user.click(await screen.findByRole('button', { name: '编辑文档' }))
    fireEvent.change(screen.getByRole('textbox', { name: '文档编辑器' }), { target: { value: '修改脚本' } })
    expect(screen.getByRole('status')).toHaveTextContent(/本地草稿.*重新编排/)
    await waitFor(() => expect(screen.getByRole('button', { name: '预览文档' })).toBeEnabled())
    expect(screen.getByRole('button', { name: '确认脚本与分镜' })).toBeDisabled()
    expect(ipcApi.request).not.toHaveBeenCalledWith('industrial_video.review_confirm', expect.anything())
  })

  it('仅审核版本变化不能解除本地脚本草稿阻断', async () => {
    const user = userEvent.setup()
    render(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    await user.click(await screen.findByRole('button', { name: '编辑文档' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '本地草稿' } })
    await waitFor(() => expect(screen.getByRole('button', { name: '预览文档' })).toBeEnabled())
    mocks.snapshot.review_version = 'v2'
    await user.click(screen.getByRole('button', { name: '刷新审核' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '预览文档' })).toBeEnabled())
    expect(screen.getByRole('textbox')).toHaveValue('本地草稿')
    expect(screen.getByRole('button', { name: '确认脚本与分镜' })).toBeDisabled()
  })

  it('版本更新和刷新均不覆盖未提交分镜草稿', async () => {
    const user = userEvent.setup()
    const view = render(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    await user.click(await screen.findByRole('button', { name: '分镜脚本.md' }))
    await user.click(screen.getByRole('button', { name: '编辑文档' }))
    const text = screen.getByRole<HTMLTextAreaElement>('textbox').value.replace('原旁白', '保留分镜草稿')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: text } })
    mocks.record = { ...mocks.record, version: 2 }
    view.rerender(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    await user.click(screen.getByRole('button', { name: '刷新审核' }))
    expect(screen.getByRole('textbox')).toHaveValue(text)
    expect(screen.getByRole('button', { name: '提交分镜修改' })).toBeEnabled()
    expect(mocks.write).toHaveBeenCalledTimes(2)
  })

  it('分镜编辑带真实指纹提交，重读后必须重新审核', async () => {
    const user = userEvent.setup()
    render(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    await user.click(await screen.findByRole('button', { name: '分镜脚本.md' }))
    await user.click(screen.getByRole('button', { name: '编辑文档' }))
    await waitFor(() => expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toContain('原旁白'))
    const editor = screen.getByRole<HTMLTextAreaElement>('textbox')
    fireEvent.change(editor, { target: { value: editor.value.replace('原旁白', '新旁白') } })
    await user.click(screen.getByRole('button', { name: '提交分镜修改' }))
    await waitFor(() =>
      expect(ipcApi.request).toHaveBeenCalledWith(
        'industrial_video.storyboard_submit',
        expect.objectContaining({
          expectedInputFingerprint: 'fp',
          expectedStoryboardSha256: 'sha',
          storyboard: expect.objectContaining({ scenes: [expect.objectContaining({ narration: '新旁白' })] })
        })
      )
    )
    await waitFor(() =>
      expect(
        vi.mocked(ipcApi.request).mock.calls.filter(([route]) => route === 'industrial_video.review_snapshot_get')
      ).toHaveLength(2)
    )
    expect(ipcApi.request).not.toHaveBeenCalledWith('industrial_video.review_confirm', expect.anything())
  })

  it('审核确认后外部改动文档不能沿用旧审批付费', async () => {
    const user = userEvent.setup()
    render(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    await user.click(await screen.findByRole('button', { name: '确认脚本与分镜' }))
    await screen.findByRole('button', { name: /确认开始生成/ })
    const board = [...mocks.files.keys()].find((path) => path.endsWith('分镜脚本.md'))!
    mocks.files.set(board, '外部修改')
    await user.click(screen.getByRole('button', { name: /确认开始生成/ }))
    await screen.findByRole('alert')
    expect(ipcApi.request).not.toHaveBeenCalledWith('industrial_video.video_start', expect.anything())
  })

  it('首次读取失败后版本更新会自动重试', async () => {
    vi.mocked(ipcApi.request).mockRejectedValueOnce(new Error('暂不可用'))
    const view = render(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    await screen.findByRole('alert')
    mocks.record = { ...mocks.record, version: 2 }
    view.rerender(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    await screen.findByRole('button', { name: '脚本.md' })
  })

  it('快照失败可刷新重试，且不自动审批', async () => {
    vi.mocked(ipcApi.request).mockRejectedValueOnce(new Error('快照暂不可用'))
    const user = userEvent.setup()
    render(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    await screen.findByRole('alert')
    await user.click(screen.getByRole('button', { name: '刷新审核' }))
    await screen.findByRole('button', { name: '脚本.md' })
    expect(ipcApi.request).not.toHaveBeenCalledWith('industrial_video.review_confirm', expect.anything())
  })

  it('未完成或失效成片不能自动下载', async () => {
    mocks.job = { status: 'done', progress: { final: 'output/old.mp4', final_stale: true } }
    render(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    await screen.findByRole('button', { name: '脚本.md' })
    expect(ipcApi.request).not.toHaveBeenCalledWith('industrial_video.download_artifact', expect.anything())
    expect(screen.queryByRole('button', { name: '重试下载' })).not.toBeInTheDocument()
  })

  it('完成后在线播放，点击下载后才能打开本地目录', async () => {
    mocks.job = {
      status: 'done',
      progress: {
        final: 'output/final.mp4',
        preview_url: 'https://video.example/preview?sig=x'
      }
    }
    const user = userEvent.setup()
    render(<IndustrialVideoTaskPanel sessionId="s" dedicated />)
    // 原 preview_url 字段保留，但成片优先使用媒体地址播放。
    expect(await screen.findByTitle('成片在线播放')).toHaveAttribute('src', 'https://video.example/preview?sig=x')
    expect(ipcApi.request).not.toHaveBeenCalledWith('industrial_video.download_artifact', expect.anything())
    await user.click(screen.getByRole('button', { name: '下载 MP4' }))
    await screen.findByText('已保存：/workspace/final.mp4')
    const details = screen.getByText('技术详情').closest('details')!
    expect(details).not.toHaveAttribute('open')
    expect(details).toHaveTextContent('/workspace/final.mp4')
    expect(screen.queryByText('/workspace/final.mp4', { selector: 'p.break-all' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '打开所在文件夹' }))
    expect(ipcApi.request).toHaveBeenCalledWith('file.show_in_folder', { kind: 'path', path: '/workspace/final.mp4' })
  })
})
