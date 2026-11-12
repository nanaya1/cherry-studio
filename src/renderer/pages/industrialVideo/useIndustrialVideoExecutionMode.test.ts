import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { ipcApi } from '@renderer/ipc'

import { useIndustrialVideoExecutionMode } from './useIndustrialVideoExecutionMode'

vi.mock('@renderer/ipc', () => ({ ipcApi: { request: vi.fn() } }))
beforeEach(() => vi.resetAllMocks())
afterEach(cleanup)

it('旧记录和无记录保持 native，读取失败不能放行任何编排', async () => {
  vi.mocked(ipcApi.request).mockResolvedValue(null)
  const view = renderHook(({ id }) => useIndustrialVideoExecutionMode(id), { initialProps: { id: 'legacy' } })
  await waitFor(() => expect(view.result.current).toMatchObject({ ready: true, mode: 'native' }))
  vi.mocked(ipcApi.request).mockRejectedValue(new Error('读取失败'))
  view.rerender({ id: 'broken' })
  expect(view.result.current.ready).toBe(false)
  await waitFor(() => expect(view.result.current.error).toContain('读取失败'))
  expect(view.result.current.ready).toBe(false)
})

it('会话切换立即撤销旧绑定，迟到响应不能把新会话切回旧模式', async () => {
  let resolveOld!: (value: never) => void
  vi.mocked(ipcApi.request).mockImplementation(async (_channel, input) => {
    if ((input as { sessionId: string }).sessionId === 'old')
      return new Promise((resolve) => {
        resolveOld = resolve
      })
    return { execution_mode: 'structured-action' } as never
  })
  const view = renderHook(({ id }) => useIndustrialVideoExecutionMode(id), { initialProps: { id: 'old' } })
  view.rerender({ id: 'new' })
  expect(view.result.current.ready).toBe(false)
  // 旧 execution_mode 字段不能恢复已停用的专用链路。
  // await waitFor(() => expect(view.result.current.mode).toBe('structured-action'))
  await waitFor(() => expect(view.result.current.mode).toBe('native'))
  await act(async () => resolveOld({ execution_mode: 'native' } as never))
  // expect(view.result.current).toMatchObject({ ready: true, mode: 'structured-action' })
  expect(view.result.current).toMatchObject({ ready: true, mode: 'native' })
})
