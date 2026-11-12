import { MockCacheUtils } from '@test-mocks/renderer/CacheService'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { cacheService } from '@data/CacheService'

vi.unmock('@renderer/data/hooks/useCache')

vi.mock('@renderer/ipc', () => ({ ipcApi: { request: vi.fn() } }))
import { ipcApi } from '@renderer/ipc'

import { createIndustrialVideoSettings } from './industrialVideoSettings'
import { useIndustrialVideoProduction } from './useIndustrialVideoProduction'

const saved = (state: string, jobId: string | null = 'job-1') => ({
  sessionId: 'session-1',
  version: 1,
  run: 'run-1',
  jobId,
  state,
  rounds: [],
  unknownSubmissions: [],
  updatedAt: 1
})

// beforeEach(() => vi.resetAllMocks())
beforeEach(() => {
  vi.clearAllMocks()
  MockCacheUtils.resetMocks()
})

describe('工业视频制作恢复', () => {
  it('轮询失败保留最后真实进度，重试恢复且不发取消或重提', async () => {
    let offline = false
    vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
      if (channel === 'industrial_video.get_records') return saved('generating') as never
      if (channel !== 'industrial_video.job_get') throw new Error(`unexpected write: ${channel}`)
      if (offline) throw new Error('offline')
      return { run: 'run-1', status: 'running', progress: { scenes_total: 5, scenes_done: 2 } } as never
    })
    const { result } = renderHook(() => useIndustrialVideoProduction('session-1'))
    await waitFor(() => expect(result.current.job?.status).toBe('running'))
    offline = true
    await act(async () => result.current.refresh())
    expect(result.current.error).toBe('offline')
    expect(result.current.record?.state).toBe('generating')
    expect(result.current.job?.progress).toEqual({ scenes_total: 5, scenes_done: 2 })
    expect(result.current.jobError).toBe('')
    offline = false
    await act(async () => result.current.refresh())
    expect(result.current.error).toBe('')
    expect(result.current.job?.status).toBe('running')
    expect(
      vi
        .mocked(ipcApi.request)
        .mock.calls.every(([channel]) => ['industrial_video.get_records', 'industrial_video.job_get'].includes(channel))
    ).toBe(true)
  })

  it('保留失败任务的服务端错误信息和错误码供页面展示', async () => {
    vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
      if (channel === 'industrial_video.get_records') return saved('failed') as never
      return {
        status: 'failed',
        run: 'run-1',
        error: { code: 'quota_exceeded', message: '余额不足', token: 'not-for-display' }
      } as never
    })
    const { result } = renderHook(() => useIndustrialVideoProduction('session-1'))
    await waitFor(() => expect(result.current.jobError).toContain('余额不足'))
    expect(result.current.jobError).toContain('quota_exceeded')
    expect(result.current.jobError).not.toContain('not-for-display')
  })

  it('无任务ID时不读取或订阅准备缓存，获得ID后恢复订阅，清空后停止读取', async () => {
    vi.mocked(ipcApi.request).mockResolvedValue(null)
    const { rerender } = renderHook(({ id }: { id: string | undefined }) => useIndustrialVideoProduction(id), {
      initialProps: { id: undefined as string | undefined }
    })
    expect(cacheService.getPersist).not.toHaveBeenCalled()
    expect(cacheService.subscribe).not.toHaveBeenCalled()
    rerender({ id: 'session-1' })
    expect(cacheService.getPersist).toHaveBeenCalledWith('industrial_video.preparation.session-1')
    expect(cacheService.subscribe).toHaveBeenCalledWith('industrial_video.preparation.session-1', expect.any(Function))
    await act(async () => {})
    vi.mocked(cacheService.getPersist).mockClear()
    vi.mocked(cacheService.subscribe).mockClear()
    rerender({ id: '' })
    await act(async () => {})
    expect(cacheService.getPersist).not.toHaveBeenCalled()
    expect(cacheService.subscribe).not.toHaveBeenCalled()
  })

  it('有效任务的准备状态变为submitted后仍刷新制作记录', async () => {
    vi.mocked(ipcApi.request).mockResolvedValue(null)
    const { result } = renderHook(() => useIndustrialVideoProduction('session-1'))
    await act(async () => {})
    vi.mocked(ipcApi.request).mockResolvedValue(saved('draft', null))
    act(() => {
      cacheService.setPersist('industrial_video.preparation.session-1', {
        stage: 'submitted',
        result: '',
        error: '',
        startedAt: 1,
        updatedAt: 2,
        input: { requirement: '需求', modelId: null, settings: createIndustrialVideoSettings('marketing') }
      })
    })
    await waitFor(() => expect(result.current.record?.run).toBe('run-1'))
  })

  it('任务轮询完成后立即显示主进程对账后的状态，不滞后一轮', async () => {
    let reconciled = false
    vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
      if (channel === 'industrial_video.get_records') return saved(reconciled ? 'done' : 'generating') as never
      reconciled = true
      return { status: 'done', run: 'run-1' } as never
    })
    const { result } = renderHook(() => useIndustrialVideoProduction('session-1'))
    await waitFor(() => expect(result.current.job?.status).toBe('done'))
    expect(result.current.record?.state).toBe('done')
  })

  it('同一任务对账等待期间保留已确认成片，避免播放器闪烁和重复下载', async () => {
    vi.mocked(ipcApi.request).mockImplementation(
      async (channel) =>
        (channel === 'industrial_video.get_records'
          ? saved('done')
          : { status: 'done', progress: { final: 'final.mp4' } }) as never
    )
    const { result } = renderHook(() => useIndustrialVideoProduction('session-1'))
    await waitFor(() => expect(result.current.job?.status).toBe('done'))
    let finish!: (value: never) => void
    vi.mocked(ipcApi.request).mockImplementation(async (channel) => {
      if (channel === 'industrial_video.get_records') return saved('done') as never
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.refresh()
    })
    expect(result.current.job?.progress).toEqual({ final: 'final.mp4' })
    await act(async () => {
      finish({ status: 'done', progress: { final: 'final.mp4' } } as never)
      await pending
    })
  })

  it('新版本没有任务时清除上一版本任务，不能显示旧成片', async () => {
    let current = saved('done')
    vi.mocked(ipcApi.request).mockImplementation(
      async (channel) => (channel === 'industrial_video.get_records' ? current : { status: 'done' }) as never
    )
    const { result } = renderHook(() => useIndustrialVideoProduction('session-1'))
    await waitFor(() => expect(result.current.job?.status).toBe('done'))
    current = saved('draft', null)
    await act(() => result.current.refresh())
    expect(result.current.job).toBeNull()
    expect(result.current.record?.jobId).toBeNull()
  })

  it('同一会话的旧刷新晚到也不能覆盖较新的任务状态', async () => {
    vi.mocked(ipcApi.request).mockResolvedValue(null)
    const { result } = renderHook(() => useIndustrialVideoProduction('session-1'))
    await act(async () => {})
    let finish!: (value: never) => void
    vi.mocked(ipcApi.request).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    let older!: Promise<void>
    act(() => {
      older = result.current.refresh()
    })
    vi.mocked(ipcApi.request).mockResolvedValue(saved('draft', null))
    await act(() => result.current.refresh())
    await act(async () => {
      finish(saved('failed', null) as never)
      await older
    })
    expect(result.current.record?.state).toBe('draft')
  })

  it('切换会话后忽略旧请求，卸载不取消服务端制作任务', async () => {
    let finish!: (value: never) => void
    vi.mocked(ipcApi.request).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const { result, rerender, unmount } = renderHook(({ id }) => useIndustrialVideoProduction(id), {
      initialProps: { id: 'session-1' }
    })
    vi.mocked(ipcApi.request).mockResolvedValue(null)
    rerender({ id: 'session-2' })
    await act(async () => {
      finish(saved('done') as never)
    })
    expect(result.current.record).toBeNull()
    expect(result.current.job).toBeNull()
    unmount()
    expect(vi.mocked(ipcApi.request).mock.calls.some(([channel]) => channel === 'industrial_video.job_cancel')).toBe(
      false
    )
  })
})
