import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ dialog: vi.fn(), download: vi.fn(), copy: vi.fn(), guard: vi.fn(), stat: vi.fn() }))
vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  const overrides = {
    WindowManager: { getWindow: () => ({}) },
    IndustrialVideoService: { downloadArtifact: mocks.download }
  }
  return mockApplicationFactory(overrides)
})
vi.mock('electron', () => ({ dialog: { showSaveDialog: mocks.dialog } }))
vi.mock('@main/services/file', () => ({ assertOutsideManagedStorageMutation: mocks.guard }))
vi.mock('@main/utils/file', () => ({ copyNew: mocks.copy }))
vi.mock('node:fs/promises', () => ({ lstat: mocks.stat }))

import { industrialVideoHandlers } from '../industrialVideo'

const input = { sessionId: 's', run: 'r', path: 'final/video.mp4' }
const context = { senderId: 'w1' }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.dialog.mockResolvedValue({ canceled: false, filePath: '/chosen/video.mp4' })
  mocks.stat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
  mocks.download.mockResolvedValue({ filePath: '/workspace/video.mp4', size: 42 })
})
// 取消保存必须无网络下载，已选路径只能由主进程对话框产生。
it('does not download or write when the user cancels', async () => {
  mocks.dialog.mockResolvedValue({ canceled: true })
  expect(await industrialVideoHandlers['industrial_video.save_artifact'](input, context)).toBeNull()
  expect(mocks.download).not.toHaveBeenCalled()
  expect(mocks.copy).not.toHaveBeenCalled()
})
it('saves the verified artifact to the selected path', async () => {
  expect(await industrialVideoHandlers['industrial_video.save_artifact'](input, context)).toEqual({
    filePath: '/chosen/video.mp4',
    size: 42
  })
  expect(mocks.copy).toHaveBeenCalledWith('/workspace/video.mp4', '/chosen/video.mp4')
  expect(mocks.dialog.mock.invocationCallOrder[0]).toBeLessThan(mocks.download.mock.invocationCallOrder[0])
})
it('does not download or overwrite an existing target', async () => {
  mocks.stat.mockResolvedValue({})
  await expect(industrialVideoHandlers['industrial_video.save_artifact'](input, context)).rejects.toThrow(
    '目标文件已存在'
  )
  expect(mocks.download).not.toHaveBeenCalled()
  expect(mocks.copy).not.toHaveBeenCalled()
})
