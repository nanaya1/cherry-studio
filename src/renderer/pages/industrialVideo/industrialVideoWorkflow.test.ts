import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/ipc', () => ({ ipcApi: { request: vi.fn() } }))
import { ipcApi } from '@renderer/ipc'

// import { parseIndustrialStoryboard, prepareIndustrialStoryboard } from './industrialVideoWorkflow'
import { parseIndustrialStoryboard, prepareIndustrialStoryboard, uploadIndustrialLogo } from './industrialVideoWorkflow'

beforeEach(() => vi.resetAllMocks())

describe('工业视频 Logo 上传句柄', () => {
  it.each(['工匠png.png', '品牌 logo_最终版 (1).PNG', `${'a'.repeat(120)}.png`, 'logo.png'])(
    '为 %s 生成合法上传句柄并保留图片字节与服务端返回值',
    async (name) => {
      const uploaded = { name: 'server-logo.png' }
      vi.mocked(ipcApi.request).mockResolvedValueOnce(uploaded)
      const result = await uploadIndustrialLogo('s', name, 'data:image/png;base64,AQID')
      const [channel, input] = vi.mocked(ipcApi.request).mock.calls[0]
      expect(channel).toBe('industrial_video.upload')
      expect(input).toMatchObject({ sessionId: 's', content: new Uint8Array([1, 2, 3]) })
      const handle = (input as { name: string }).name
      expect(handle).toMatch(/^logo-[a-f0-9-]+\.png$/)
      expect(handle).toMatch(/^[A-Za-z0-9.-]+$/)
      expect(handle.length).toBeLessThan(120)
      expect(result).toEqual(uploaded)
    }
  )

  it.each(['jpg', 'jpeg', 'webp'])('保留 %s 图片后缀', async (extension) => {
    await uploadIndustrialLogo('s', `品牌.${extension}`, 'data:image/png;base64,AQID')
    expect(ipcApi.request).toHaveBeenCalledWith(
      'industrial_video.upload',
      expect.objectContaining({ name: expect.stringMatching(new RegExp(`^logo-[a-f0-9-]+\\.${extension}$`)) })
    )
  })

  it('同名 Logo 的不同上传不会复用同一句柄', async () => {
    await uploadIndustrialLogo('s', '工匠.png', 'data:image/png;base64,AQID')
    await uploadIndustrialLogo('s', '工匠.png', 'data:image/png;base64,BAUG')
    const names = vi.mocked(ipcApi.request).mock.calls.map(([, input]) => (input as { name: string }).name)
    expect(names[0]).not.toBe(names[1])
  })
})
describe('工业视频分镜准备契约', () => {
  it('拒绝没有场景、重复ID和无效时长，避免提交不可制作分镜', () => {
    for (const scenes of [
      [],
      [{ id: 1, title: '镜头', duration: -1 }],
      [
        { id: 1, title: 'a' },
        { id: 1, title: 'b' }
      ]
    ]) {
      expect(() => parseIndustrialStoryboard(JSON.stringify({ video_title: '视频', scenes }))).toThrow()
    }
    expect(
      parseIndustrialStoryboard('```json\n{"video_title":"产品","scenes":[{"id":1,"title":"全景","duration":5}]}\n```')
        .scenes
    ).toHaveLength(1)
  })
  it('解析完成前不读取规划上下文，更不会自动调用付费生成', async () => {
    vi.mocked(ipcApi.request).mockResolvedValue({ status: 'running' })
    await expect(prepareIndustrialStoryboard('s', 'r', 'j', async () => '')).rejects.toThrow()
    expect(vi.mocked(ipcApi.request).mock.calls.map(([channel]) => channel)).toEqual(['industrial_video.job_get'])
  })
  it('沿用服务端指纹提交模型分镜，草稿提交不等于生成批准', async () => {
    vi.mocked(ipcApi.request)
      .mockResolvedValueOnce({ status: 'done', run: 'r' })
      .mockResolvedValueOnce({ input_fingerprint: 'fp', expected_storyboard_sha256: 'sha256', sources_ready: true })
      .mockResolvedValueOnce({ submitted: true, reviewRequired: true })
    const board = await prepareIndustrialStoryboard(
      's',
      'r',
      'j',
      async () => '{"video_title":"产品","scenes":[{"id":1,"title":"全景"}]}'
    )
    expect(board.video_title).toBe('产品')
    expect(ipcApi.request).toHaveBeenLastCalledWith(
      'industrial_video.storyboard_submit',
      expect.objectContaining({ expectedInputFingerprint: 'fp', expectedStoryboardSha256: 'sha256' })
    )
    expect(vi.mocked(ipcApi.request).mock.calls.some(([channel]) => channel === 'industrial_video.video_start')).toBe(
      false
    )
  })
  it('缺少指纹就停止，不猜测指纹或提交空值', async () => {
    vi.mocked(ipcApi.request).mockResolvedValueOnce({ status: 'done', run: 'r' }).mockResolvedValueOnce({})
    const generate = vi.fn()
    await expect(prepareIndustrialStoryboard('s', 'r', 'j', generate)).rejects.toThrow()
    expect(generate).not.toHaveBeenCalled()
  })
  it('素材未就绪（sources_ready=false）阻止提交分镜，不读取分镜指纹', async () => {
    vi.mocked(ipcApi.request)
      .mockResolvedValueOnce({ status: 'done', run: 'r' })
      .mockResolvedValueOnce({ input_fingerprint: 'fp', expected_storyboard_sha256: 'sha256', sources_ready: false })
    const generate = vi.fn()
    await expect(prepareIndustrialStoryboard('s', 'r', 'j', generate)).rejects.toThrow(/素材尚未就绪/)
    expect(generate).not.toHaveBeenCalled()
    expect(
      vi.mocked(ipcApi.request).mock.calls.some(([channel]) => channel === 'industrial_video.storyboard_submit')
    ).toBe(false)
  })
})
