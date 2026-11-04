// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  request: vi.fn()
}))

vi.mock('@renderer/ipc', () => ({ ipcApi: { request: mocks.request } }))
vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ warn: vi.fn(), error: vi.fn() }) }
}))

import { useOrgConnectors } from '../useOrgConnectors'

// 可控的 deferred promise：用于模拟「在途请求」，精确控制 resolve/reject 时机
function deferred<T = unknown>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const sampleConnector = {
  slug: 'c1',
  name: 'C1',
  description: '',
  type: 'sse' as const,
  baseUrl: 'http://example.com',
  config: {}
}

describe('useOrgConnectors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'enterprise.connectors.list') return { connectors: [] }
      throw new Error(`unexpected route: ${route}`)
    })
  })

  it('does not request while disabled and refetches after enabling', async () => {
    const { rerender } = renderHook(({ enabled }) => useOrgConnectors(enabled), {
      initialProps: { enabled: false }
    })

    expect(mocks.request).not.toHaveBeenCalled()

    rerender({ enabled: true })

    await waitFor(() => {
      expect(mocks.request).toHaveBeenCalledWith('enterprise.connectors.list')
    })
  })

  it('starts with available false before any directory response', async () => {
    const { result } = renderHook(() => useOrgConnectors(true))
    expect(result.current.available).toBe(false)
    // 让在途请求解析完成，避免 act 警告
    await waitFor(() => expect(result.current.loading).toBe(false))
  })

  it('sets available true on a successful list response, including an empty directory', async () => {
    const { result } = renderHook(() => useOrgConnectors(true))
    await waitFor(() => expect(result.current.available).toBe(true))
    expect(result.current.connectors).toEqual([])
  })

  it('resets available and the connector list when disabled', async () => {
    const connector = {
      slug: 'c1',
      name: 'C1',
      description: '',
      type: 'sse' as const,
      baseUrl: 'http://example.com',
      config: {}
    }
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'enterprise.connectors.list') return { connectors: [connector] }
      throw new Error(`unexpected route: ${route}`)
    })
    const { result, rerender } = renderHook(({ enabled }) => useOrgConnectors(enabled), {
      initialProps: { enabled: true }
    })

    await waitFor(() => expect(result.current.available).toBe(true))
    expect(result.current.connectors).toEqual([connector])

    rerender({ enabled: false })
    await waitFor(() => expect(result.current.available).toBe(false))
    expect(result.current.connectors).toEqual([])
  })

  it('keeps the list and available=true when a refresh fails after a successful load', async () => {
    const connector = {
      slug: 'c1',
      name: 'C1',
      description: '',
      type: 'sse' as const,
      baseUrl: 'http://example.com',
      config: {}
    }
    mocks.request.mockImplementation(async (route: string) => {
      if (route === 'enterprise.connectors.list') return { connectors: [connector] }
      throw new Error(`unexpected route: ${route}`)
    })
    const { result } = renderHook(() => useOrgConnectors(true))

    await waitFor(() => expect(result.current.available).toBe(true))
    expect(result.current.connectors).toEqual([connector])

    mocks.request.mockRejectedValueOnce(new Error('network down'))
    await act(async () => {
      await result.current.refetch()
    })

    expect(result.current.connectors).toEqual([connector])
    expect(result.current.available).toBe(true)
    expect(result.current.error).toBe('network down')
  })

  it('leaves available false when the initial directory request fails', async () => {
    mocks.request.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useOrgConnectors(true))

    await waitFor(() => expect(result.current.error).toBe('boom'))
    expect(result.current.available).toBe(false)
    expect(result.current.connectors).toEqual([])
  })

  it('re-requests and becomes available after the initial mount fails, is unmounted, and remounts', async () => {
    const initial = deferred<{ connectors: typeof sampleConnector[] }>()
    mocks.request.mockImplementation((route: string) => {
      if (route === 'enterprise.connectors.list') return initial.promise
      throw new Error(`unexpected route: ${route}`)
    })

    const first = renderHook(() => useOrgConnectors(true))
    // 初始请求处于 pending；unmount 前让其在途失败
    await waitFor(() => expect(first.result.current.loading).toBe(true))

    await act(async () => {
      initial.reject(new Error('boom'))
    })
    await waitFor(() => expect(first.result.current.error).toBe('boom'))
    expect(first.result.current.available).toBe(false)
    expect(first.result.current.connectors).toEqual([])

    // 卸载：清理使在途请求失效
    act(() => first.unmount())

    // 重新挂载，目录此时可达
    const restored = deferred<{ connectors: typeof sampleConnector[] }>()
    mocks.request.mockImplementation((route: string) => {
      if (route === 'enterprise.connectors.list') return restored.promise
      throw new Error(`unexpected route: ${route}`)
    })
    const second = renderHook(() => useOrgConnectors(true))

    await waitFor(() => expect(second.result.current.loading).toBe(true))
    await act(async () => {
      restored.resolve({ connectors: [sampleConnector] })
    })

    // 真实结果断言：重新请求后目录可用且列表正确
    await waitFor(() => expect(second.result.current.available).toBe(true))
    expect(second.result.current.connectors).toEqual([sampleConnector])
    expect(second.result.current.error).toBeNull()
    // 辅助断言：确实发起了新的请求（非唯一断言）
    expect(mocks.request.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('keeps the new list when an old pending request resolves after a newer request succeeds', async () => {
    const oldReq = deferred<{ connectors: typeof sampleConnector[] }>()
    const newReq = deferred<{ connectors: typeof sampleConnector[] }>()
    const oldConnector = { ...sampleConnector, slug: 'old', name: 'Old' }
    const newConnector = { ...sampleConnector, slug: 'new', name: 'New' }

    let call = 0
    mocks.request.mockImplementation((route: string) => {
      if (route === 'enterprise.connectors.list') {
        call += 1
        // 第一次 enabled=true：旧请求（一直 pending）
        // 第二次 enabled=true（中间经过 disabled）：新请求
        return call === 1 ? oldReq.promise : newReq.promise
      }
      throw new Error(`unexpected route: ${route}`)
    })

    const { result, rerender } = renderHook(({ enabled }) => useOrgConnectors(enabled), {
      initialProps: { enabled: true }
    })

    // 初始请求（旧）在途 pending
    await waitFor(() => expect(result.current.loading).toBe(true))
    expect(result.current.connectors).toEqual([])

    // 临时禁用：旧请求被失效（requestRef 自增），目录重置
    rerender({ enabled: false })
    await waitFor(() => expect(result.current.available).toBe(false))
    expect(result.current.connectors).toEqual([])

    // 重新启用：发起新请求
    rerender({ enabled: true })
    await waitFor(() => expect(result.current.loading).toBe(true))

    // 新请求先成功
    await act(async () => {
      newReq.resolve({ connectors: [newConnector] })
    })
    await waitFor(() => expect(result.current.available).toBe(true))
    expect(result.current.connectors).toEqual([newConnector])

    // 随后旧请求才 resolve，必须不能覆盖新列表
    await act(async () => {
      oldReq.resolve({ connectors: [oldConnector] })
    })

    // 真实结果断言：列表与可用状态保持由新请求决定
    expect(result.current.connectors).toEqual([newConnector])
    expect(result.current.available).toBe(true)
    expect(mocks.request.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
