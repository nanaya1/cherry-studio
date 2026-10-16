import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { OrgKnowledgeCatalog } from '@shared/data/types/enterpriseKnowledge'
import type { EnterpriseStatus } from '@shared/ipc/schemas/enterprise'

import { useOrgKnowledge } from '../useOrgKnowledge'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  listener: undefined as ((status: EnterpriseStatus) => void) | undefined
}))
vi.mock('@renderer/ipc', () => ({
  ipcApi: { request: mocks.request },
  useIpcOn: (_event: string, listener: (status: EnterpriseStatus) => void) => {
    mocks.listener = listener
  }
}))
const status = (generation: number, phase: EnterpriseStatus['phase'] = 'signed-in'): EnterpriseStatus => ({
  generation,
  phase,
  groupId: 'group',
  authMode: 'management-cookie',
  displayName: null,
  phone: null,
  role: null
})
const catalog: OrgKnowledgeCatalog = {
  public: [{ id: 'orgkb:b25l', name: '公共', description: null, documentCount: 1 }],
  shared: [],
  owned: []
}
const empty = { public: [], shared: [], owned: [] }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.request.mockImplementation(async (route: string) => (route === 'enterprise.status.get' ? status(1) : catalog))
})

describe('useOrgKnowledge', () => {
  it('在 StrictMode 重新挂载 effect 后仍可完成目录加载', async () => {
    const { result } = renderHook(() => useOrgKnowledge(), {
      wrapper: ({ children }) => createElement(StrictMode, null, children)
    })
    await waitFor(() => expect(result.current.catalog).toEqual(catalog))
    expect(result.current.loading).toBe(false)
  })

  it('公开目录、loading、error 和可恢复失败的 refresh', async () => {
    const { result } = renderHook(() => useOrgKnowledge())
    await waitFor(() => expect(result.current.catalog).toEqual(catalog))
    expect(result.current.loading).toBe(false)
    mocks.request.mockRejectedValueOnce(new Error('离线'))
    await act(() => result.current.refresh())
    expect(result.current.catalog).toEqual(empty)
    expect(result.current.error).toBe('离线')
    await act(() => result.current.refresh())
    expect(result.current.catalog).toEqual(catalog)
    expect(result.current.error).toBeNull()
  })

  it('generation 变化立即清除旧目录，丢弃旧账号的迟到响应', async () => {
    const { result } = renderHook(() => useOrgKnowledge())
    await waitFor(() => expect(result.current.catalog).toEqual(catalog))
    let resolveOld!: (value: OrgKnowledgeCatalog) => void
    mocks.request.mockImplementationOnce(
      () =>
        new Promise<OrgKnowledgeCatalog>((resolve) => {
          resolveOld = resolve
        })
    )
    let pending!: Promise<void>
    act(() => {
      pending = result.current.refresh()
    })
    act(() => mocks.listener?.(status(2, 'switching')))
    expect(result.current.catalog).toEqual(empty)
    await act(async () => {
      resolveOld(catalog)
      await pending
    })
    expect(result.current.catalog).toEqual(empty)
    act(() => mocks.listener?.(status(3)))
    await waitFor(() => expect(result.current.catalog).toEqual(catalog))
    act(() => mocks.listener?.(status(2, 'signed-out')))
    expect(result.current.catalog).toEqual(catalog)
    act(() => mocks.listener?.(status(4, 'signed-out')))
    expect(result.current.catalog).toEqual(empty)
  })

  it('状态事件先到时不允许旧的初始状态覆盖当前账号', async () => {
    let resolveStatus!: (value: EnterpriseStatus) => void
    mocks.request.mockImplementationOnce(
      () =>
        new Promise<EnterpriseStatus>((resolve) => {
          resolveStatus = resolve
        })
    )
    const { result } = renderHook(() => useOrgKnowledge())
    act(() => mocks.listener?.(status(3, 'signed-out')))
    await act(async () => resolveStatus(status(1)))
    expect(result.current.catalog).toEqual(empty)
    expect(result.current.loading).toBe(false)
  })
})
