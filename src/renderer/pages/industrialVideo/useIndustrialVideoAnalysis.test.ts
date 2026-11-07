import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/ipc', () => ({ ipcApi: { request: vi.fn() } }))
import { ipcApi } from '@renderer/ipc'
import type { Model } from '@shared/data/types/model'

import { useIndustrialVideoAnalysis } from './useIndustrialVideoAnalysis'

const model: Model = {
  id: 'test::model',
  providerId: 'test',
  name: '测试模型',
  capabilities: [],
  supportsStreaming: false,
  isEnabled: true,
  isHidden: false
}
beforeEach(() => vi.resetAllMocks())
describe('前置分析请求生命周期', () => {
  it('取消后晚到的旧结果不能替换新分析结果', async () => {
    let finishOld!: (value: string) => void
    vi.mocked(ipcApi.request)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = (value) => resolve({ text: value })
          })
      )
      .mockResolvedValueOnce({ text: '新资料分析' })
    const { result } = renderHook(useIndustrialVideoAnalysis)
    let old!: Promise<string | undefined>
    act(() => {
      old = result.current.analyze(model, '分析', '旧资料')
    })
    act(() => result.current.cancel())
    await act(() => result.current.analyze(model, '分析', '新资料'))
    await act(async () => {
      finishOld('旧资料分析')
      await old
    })
    expect(result.current.result).toBe('新资料分析')
    expect(result.current.running).toBe(false)
  })
  it('卸载后取消底层请求，重新挂载不显示旧会话结果', async () => {
    let finish!: (value: string) => void
    let requestId = ''
    vi.mocked(ipcApi.request).mockImplementation((channel, input) => {
      if (channel === 'ai.text.generate') {
        requestId = (input as { requestId: string }).requestId
        return new Promise((resolve) => {
          finish = (value) => resolve({ text: value })
        })
      }
      return Promise.resolve(undefined as never)
    })
    const first = renderHook(useIndustrialVideoAnalysis)
    let request!: Promise<string | undefined>
    act(() => {
      request = first.result.current.analyze(model, '分析', '旧会话资料')
    })
    first.unmount()
    expect(ipcApi.request).toHaveBeenCalledWith('ai.text.abort', { requestId })
    const second = renderHook(useIndustrialVideoAnalysis)
    await act(async () => {
      finish('旧会话结果')
      await request
    })
    expect(second.result.current.result).toBe('')
    expect(second.result.current.running).toBe(false)
  })
  it('通过一次性 UI 消息携带标准附件，不创建聊天话题', async () => {
    vi.mocked(ipcApi.request).mockResolvedValue({ text: '附件分析结果' })
    const { result } = renderHook(useIndustrialVideoAnalysis)
    await act(() =>
      result.current.analyze(model, '分析', '需求快照', [
        {
          type: 'file',
          mediaType: 'text/html',
          url: 'file:///tmp/guide.html',
          filename: 'guide.html',
          providerMetadata: { cherry: { fileEntryId: 'fe-html', fileTokenSourceId: 'source-html' } }
        }
      ])
    )

    expect(ipcApi.request).toHaveBeenCalledWith(
      'ai.text.generate',
      expect.objectContaining({
        uniqueModelId: model.id,
        uiMessages: [
          expect.objectContaining({
            role: 'user',
            parts: expect.arrayContaining([expect.objectContaining({ type: 'file', filename: 'guide.html' })])
          })
        ]
      })
    )
  })

  it('空模型输出显示错误而不是成功', async () => {
    vi.mocked(ipcApi.request).mockResolvedValue({ text: ' ' })
    const { result } = renderHook(useIndustrialVideoAnalysis)
    await act(() => result.current.analyze(model, '分析', '真实资料'))
    expect(result.current.result).toBe('')
    expect(result.current.error).toBe('industrial_video.empty_analysis')
  })
})
