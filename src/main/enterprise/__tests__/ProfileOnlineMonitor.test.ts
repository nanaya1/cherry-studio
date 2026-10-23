import { afterEach, describe, expect, it, vi } from 'vitest'

import { BusinessAccessGate } from '@main/core/profiles'

import { ProfileOnlineMonitor } from '../ProfileOnlineMonitor'

function setup() {
  const gate = new BusinessAccessGate({ clock: () => Date.now(), verificationWindowMs: 5000 })
  gate.recordVerificationSuccess()
  const verify = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const blocked = vi.fn()
  const monitor = new ProfileOnlineMonitor({ gate, verify, onBlocked: blocked, intervalMs: 1000 })
  return { gate, verify, blocked, monitor }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ProfileOnlineMonitor', () => {
  it('renews a valid lease without interrupting access', async () => {
    vi.useFakeTimers()
    const { gate, verify, monitor } = setup()
    monitor.start()
    await vi.advanceTimersByTimeAsync(6000)
    expect(gate.isAllowed()).toBe(true)
    expect(verify).toHaveBeenCalledTimes(6)
    monitor.stop()
  })

  it('blocks on the first verification failure and never hot recovers', async () => {
    vi.useFakeTimers()
    const { gate, verify, blocked, monitor } = setup()
    verify.mockRejectedValueOnce(new Error('401'))
    monitor.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(gate.isAllowed()).toBe(false)
    await vi.advanceTimersByTimeAsync(6000)
    expect(blocked).toHaveBeenCalledTimes(1)
    expect(gate.state.kind).toBe('blocked')
    monitor.stop()
  })

  it('retries a temporary service failure and restores access after recovery', async () => {
    vi.useFakeTimers()
    const { gate, verify, blocked, monitor } = setup()
    verify.mockRejectedValueOnce(new Error('currentuser request failed (503)')).mockResolvedValue(undefined)
    monitor.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(gate.isAllowed()).toBe(false)
    expect(gate.state.kind).toBe('verifying')
    await vi.advanceTimersByTimeAsync(2000)
    expect(verify.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(gate.isAllowed()).toBe(true)
    expect(blocked).not.toHaveBeenCalled()
    monitor.stop()
  })

  it('blocks a hung request at the deadline and rejects its late success', async () => {
    vi.useFakeTimers()
    const { gate, verify, monitor } = setup()
    let finish!: () => void
    verify.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    monitor.start()
    await vi.advanceTimersByTimeAsync(6000)
    expect(gate.isAllowed()).toBe(false)
    expect(verify).toHaveBeenCalledTimes(1)
    finish()
    await Promise.resolve()
    expect(gate.isAllowed()).toBe(false)
    monitor.stop()
  })

  it('discards verification success after the service stops', async () => {
    vi.useFakeTimers()
    const { gate, verify, monitor } = setup()
    let finish!: () => void
    verify.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    monitor.start()
    await vi.advanceTimersByTimeAsync(1000)
    monitor.stop()
    gate.recordVerificationFailure('logout')
    finish()
    await Promise.resolve()
    expect(gate.isAllowed()).toBe(false)
  })
})
