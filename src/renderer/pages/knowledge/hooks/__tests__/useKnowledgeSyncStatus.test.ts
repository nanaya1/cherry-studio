import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

import { useKnowledgeSyncStatus } from '../useKnowledgeSyncStatus'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  session: undefined as ((value: any) => void) | undefined,
  change: undefined as (() => void) | undefined
}))
vi.mock('@renderer/ipc', () => ({
  ipcApi: { request: mocks.request },
  useIpcOn: (_event: string, listener: (value: any) => void) => {
    mocks.session = listener
  }
}))
vi.mock('@data/hooks/useDataApi', () => ({
  useDataChange: (_endpoints: unknown, listener: () => void) => {
    mocks.change = listener
  }
}))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.request.mockImplementation(async (route) =>
    route === 'enterprise.status.get' ? { generation: 1, phase: 'signed-in' } : { state: 'shared', lastSyncedAt: null }
  )
})

it('打开库和本地数据变化刷新，普通重渲染不扫描库，切账号后丢弃旧状态', async () => {
  const { result, rerender } = renderHook(({ baseId, version }) => useKnowledgeSyncStatus(baseId, version), {
    initialProps: { baseId: 'one', version: 0 }
  })
  await waitFor(() => expect(result.current.status?.state).toBe('shared'))
  const scans = () => mocks.request.mock.calls.filter(([route]) => route === 'enterprise.knowledge.sync_status').length
  const initial = scans()
  rerender({ baseId: 'one', version: 0 })
  expect(scans()).toBe(initial)
  mocks.request.mockResolvedValueOnce({ state: 'pending', lastSyncedAt: null })
  act(() => mocks.change?.())
  expect(result.current.status).toBeUndefined()
  await waitFor(() => expect(result.current.status?.state).toBe('pending'))
  let resolve!: (value: unknown) => void
  mocks.request.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  let pending!: Promise<void>
  act(() => {
    pending = result.current.refresh()
  })
  act(() => mocks.session?.({ generation: 2, phase: 'signed-out' }))
  await act(async () => {
    resolve({ state: 'shared', lastSyncedAt: null })
    await pending
  })
  expect(result.current.status).toBeUndefined()
  act(() => mocks.session?.({ generation: 1, phase: 'signed-in' }))
  expect(result.current.status).toBeUndefined()
})
