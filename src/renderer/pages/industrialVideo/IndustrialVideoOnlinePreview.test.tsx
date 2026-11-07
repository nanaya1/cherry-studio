import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

import { ipcApi } from '@renderer/ipc'

import IndustrialVideoOnlinePreview from './IndustrialVideoOnlinePreview'

vi.mock('@renderer/ipc', () => ({ ipcApi: { request: vi.fn() } }))
beforeEach(() => vi.clearAllMocks())

// 防止预览再次自动下载，以及把网页链接误交给 video src。
it('embeds the signed preview page and downloads only on an explicit click', async () => {
  vi.mocked(ipcApi.request).mockResolvedValue({ filePath: '/workspace/final.mp4' })
  render(
    <IndustrialVideoOnlinePreview
      sessionId="s"
      run="r"
      finalPath="final.mp4"
      previewUrl="https://video.example/preview?sig=x"
    />
  )
  expect(screen.getByTitle('成片在线播放')).toHaveAttribute('src', 'https://video.example/preview?sig=x')
  expect(screen.getByTitle('成片在线播放').tagName).toBe('IFRAME')
  expect(ipcApi.request).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '下载 MP4' }))
  expect(await screen.findByText('已保存：/workspace/final.mp4')).toBeInTheDocument()
})
it('keeps download available when the save dialog is cancelled', async () => {
  vi.mocked(ipcApi.request).mockResolvedValue(null)
  render(
    <IndustrialVideoOnlinePreview
      sessionId="s"
      run="r"
      finalPath="final.mp4"
      previewUrl="https://video.example/preview"
    />
  )
  fireEvent.click(screen.getByRole('button', { name: '下载 MP4' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '下载 MP4' })).toBeEnabled())
  expect(screen.queryByText(/已保存/)).toBeNull()
  expect(ipcApi.request).toHaveBeenCalledWith('industrial_video.save_artifact', {
    sessionId: 's',
    run: 'r',
    path: 'final.mp4'
  })
})
it('retrieves missing preview information without downloading and can refresh unavailable links', async () => {
  vi.mocked(ipcApi.request)
    .mockResolvedValueOnce({ preview_url: null })
    .mockResolvedValueOnce({ preview_url: 'https://video.example/preview?sig=new' })
  render(<IndustrialVideoOnlinePreview sessionId="s" run="r" finalPath="final.mp4" />)
  expect(await screen.findByRole('alert')).toHaveTextContent('服务端未提供可用的在线预览链接')
  fireEvent.click(screen.getByRole('button', { name: '刷新预览链接' }))
  await waitFor(() =>
    expect(screen.getByTitle('成片在线播放')).toHaveAttribute('src', 'https://video.example/preview?sig=new')
  )
  expect(vi.mocked(ipcApi.request).mock.calls.every(([channel]) => channel === 'industrial_video.preview_create')).toBe(
    true
  )
})
it('accepts a first valid polled URL but preserves playback across subsequent signed URL changes', async () => {
  vi.mocked(ipcApi.request).mockResolvedValue({ preview_url: null })
  const { rerender } = render(<IndustrialVideoOnlinePreview sessionId="s" run="r" finalPath="final.mp4" />)
  await screen.findByRole('alert')
  rerender(
    <IndustrialVideoOnlinePreview
      sessionId="s"
      run="r"
      finalPath="final.mp4"
      previewUrl="https://video.example/preview?sig=first"
    />
  )
  expect(await screen.findByTitle('成片在线播放')).toHaveAttribute('src', 'https://video.example/preview?sig=first')
  rerender(
    <IndustrialVideoOnlinePreview
      sessionId="s"
      run="r"
      finalPath="final.mp4"
      previewUrl="https://video.example/preview?sig=next"
    />
  )
  expect(screen.getByTitle('成片在线播放')).toHaveAttribute('src', 'https://video.example/preview?sig=first')
})
it('rejects executable preview URLs and reports download failures without regenerating', async () => {
  const unsafeUrl = ['javascript', 'alert(1)'].join(':')
  vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
    if (channel === 'industrial_video.preview_create') return { preview_url: unsafeUrl } as never
    throw new Error('network unavailable')
  })
  render(<IndustrialVideoOnlinePreview sessionId="s" run="r" finalPath="final.mp4" previewUrl={unsafeUrl} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('服务端未提供')
  expect(screen.queryByTitle('成片在线播放')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '下载 MP4' }))
  expect(await screen.findByText('下载失败：network unavailable')).toBeInTheDocument()
})
