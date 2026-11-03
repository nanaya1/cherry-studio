import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { EnterpriseVerificationStatus } from '@shared/ipc/schemas/enterprise'

const boundary = vi.hoisted(() => ({
  request: vi.fn(),
  subscribe: vi.fn(),
  listeners: new Set<(status: EnterpriseVerificationStatus) => void>()
}))

vi.mock('@renderer/ipc', () => ({
  ipcApi: {
    request: boundary.request,
    on: (event: string, listener: (status: EnterpriseVerificationStatus) => void) => {
      boundary.subscribe(event)
      boundary.listeners.add(listener)
      return () => boundary.listeners.delete(listener)
    }
  }
}))

import { useEnterpriseVerificationRecovery, useEnterpriseVerificationStatus } from '../useEnterpriseVerificationStatus'

const status = (
  owner: string,
  revision: number,
  state: EnterpriseVerificationStatus['state']
): EnterpriseVerificationStatus => ({ owner, revision, state })

function emit(next: EnterpriseVerificationStatus) {
  act(() => boundary.listeners.forEach((listener) => listener(next)))
}

describe('enterprise verification reader', () => {
  beforeEach(() => {
    boundary.listeners.clear()
    vi.clearAllMocks()
  })

  it('keeps a newer event when the initial query returns an older revision of the same owner', async () => {
    let resolve!: (value: EnterpriseVerificationStatus) => void
    boundary.request.mockImplementation(() => {
      expect(boundary.listeners.size).toBe(1)
      return new Promise<EnterpriseVerificationStatus>((done) => {
        resolve = done
      })
    })
    const { result } = renderHook(() => useEnterpriseVerificationStatus())
    emit(status('owner-a', 3, 'blocked'))
    await act(async () => resolve(status('owner-a', 2, 'verified')))
    expect(result.current).toEqual(status('owner-a', 3, 'blocked'))
  })

  it('rejects a different-owner initial query even when that owner was never observed in an event', async () => {
    let resolve!: (value: EnterpriseVerificationStatus) => void
    boundary.request.mockImplementation(
      () =>
        new Promise<EnterpriseVerificationStatus>((done) => {
          resolve = done
        })
    )
    const { result } = renderHook(() => useEnterpriseVerificationStatus())
    emit(status('owner-b', 1, 'verified'))
    await act(async () => resolve(status('owner-a', 99, 'blocked')))
    emit(status('owner-a', 100, 'blocked'))
    expect(result.current).toEqual(status('owner-b', 1, 'verified'))
  })

  it('rejects an old-owner initial query and retired-owner events after an account switch', async () => {
    let resolve!: (value: EnterpriseVerificationStatus) => void
    boundary.request.mockImplementation(
      () =>
        new Promise<EnterpriseVerificationStatus>((done) => {
          resolve = done
        })
    )
    const { result } = renderHook(() => useEnterpriseVerificationStatus())
    emit(status('owner-a', 7, 'switching'))
    emit(status('owner-b', 1, 'verified'))
    await act(async () => resolve(status('owner-a', 99, 'blocked')))
    emit(status('owner-a', 100, 'blocked'))
    expect(result.current).toEqual(status('owner-b', 1, 'verified'))
  })

  it('refreshes once on same-owner recovery, never for healthy polls or another account', async () => {
    boundary.request.mockResolvedValue(status('owner-a', 1, 'verified'))
    const recovery = vi.fn()
    const { rerender } = renderHook(({ enabled }) => useEnterpriseVerificationRecovery(recovery, enabled), {
      initialProps: { enabled: true }
    })
    await act(async () => {})
    emit(status('owner-a', 2, 'unavailable'))
    emit(status('owner-a', 3, 'verified'))
    emit(status('owner-a', 4, 'verified'))
    expect(recovery).toHaveBeenCalledOnce()
    emit(status('owner-a', 5, 'unavailable'))
    emit(status('owner-b', 1, 'verified'))
    expect(recovery).toHaveBeenCalledOnce()
    rerender({ enabled: false })
    emit(status('owner-b', 2, 'unavailable'))
    emit(status('owner-b', 3, 'verified'))
    expect(recovery).toHaveBeenCalledOnce()
    rerender({ enabled: true })
    expect(recovery).toHaveBeenCalledTimes(2)
    rerender({ enabled: true })
    expect(recovery).toHaveBeenCalledTimes(2)
  })
})
