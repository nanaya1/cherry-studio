import { afterEach, describe, expect, it, vi } from 'vitest'

import { BusinessAccessGate } from '../../core/profiles/BusinessAccessGate'
import { ProfileOnlineMonitor } from '../ProfileOnlineMonitor'
import { VerificationError } from '../verification'

function setup() {
  const gate = new BusinessAccessGate({ clock: () => Date.now(), verificationWindowMs: 5000 })
  gate.recordVerificationSuccess()
  const verify = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  const blocked = vi.fn()
  const monitor = new ProfileOnlineMonitor({ gate, verify, onBlocked: blocked, intervalMs: 1000, random: () => 0.5 })
  return { gate, verify, blocked, monitor }
}

afterEach(() => vi.useRealTimers())

describe('ProfileOnlineMonitor', () => {
  it('keeps verified business access through long network failures with bounded retry backoff', async () => {
    vi.useFakeTimers()
    const { gate, verify, blocked, monitor } = setup()
    verify.mockRejectedValue(new Error('401 token revoked in unrelated network message'))
    monitor.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(gate.isAllowed()).toBe(true)
    await vi.advanceTimersByTimeAsync(1999)
    expect(verify.mock.calls.length).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(verify.mock.calls.length).toBe(2)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(gate.isAllowed()).toBe(true)
    expect(blocked).not.toHaveBeenCalled()
    expect(verify.mock.calls.length).toBeLessThan(30)
    monitor.stop()
  })

  it('does not revoke verified authority when a verification hangs past the old deadline', async () => {
    vi.useFakeTimers()
    const { gate, verify, monitor } = setup()
    verify.mockImplementation(() => new Promise(() => undefined))
    monitor.start()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(gate.isAllowed()).toBe(true)
    expect(verify.mock.calls.length).toBe(1)
    monitor.stop()
  })

  it('closes authority only on structured definitive evidence and notifies once', async () => {
    vi.useFakeTimers()
    const { gate, verify, blocked, monitor } = setup()
    verify.mockRejectedValue(
      new VerificationError('identity changed', {
        stage: 'identity',
        endpoint: '/api/currentuser',
        kind: 'invalid',
        reason: 'identity-changed'
      })
    )
    monitor.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(gate.isAllowed()).toBe(false)
    expect(blocked.mock.calls.length).toBe(1)
    monitor.stop()
  })

  it('discards a stopped monitor result even if the same instance starts again', async () => {
    vi.useFakeTimers()
    const { gate, verify, monitor } = setup()
    let finish!: () => void
    verify.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    monitor.start()
    await vi.advanceTimersByTimeAsync(1000)
    monitor.stop()
    monitor.start()
    gate.recordVerificationFailure('user logout')
    finish()
    await Promise.resolve()
    expect(gate.isAllowed()).toBe(false)
    monitor.stop()
  })
})
