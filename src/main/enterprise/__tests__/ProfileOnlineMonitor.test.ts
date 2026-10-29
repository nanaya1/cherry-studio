import { afterEach, describe, expect, it, vi } from 'vitest'

import { BusinessAccessGate } from '@main/core/profiles'

import { isRetryableVerificationError, ProfileOnlineMonitor } from '../ProfileOnlineMonitor'

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
    // expect(gate.isAllowed()).toBe(false)
    // expect(gate.state.kind).toBe('verifying')
    expect(gate.isAllowed()).toBe(true)
    expect(gate.state).toMatchObject({ kind: 'verified-online', expiresAt: Date.now() + 4000 })
    await vi.advanceTimersByTimeAsync(2000)
    expect(verify.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(gate.isAllowed()).toBe(true)
    expect(blocked).not.toHaveBeenCalled()
    monitor.stop()
  })

  it.each([
    'Runtime identity changed; explicit login is required',
    'Runtime authorization changed; restart is required',
    'Management session is unavailable',
    'currentuser request failed (401)',
    'currentuser request failed (403)'
  ])('never retries an authority failure: %s', async (message) => {
    vi.useFakeTimers()
    const { gate, verify, monitor } = setup()
    verify.mockRejectedValueOnce(new Error(message))
    monitor.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(gate.isAllowed()).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(gate.isAllowed()).toBe(false)
    monitor.stop()
  })

  it('expires the original lease after repeated transient failures', async () => {
    vi.useFakeTimers()
    const { gate, verify, blocked, monitor } = setup()
    verify.mockRejectedValue(new Error('fetch failed'))
    monitor.start()
    await vi.advanceTimersByTimeAsync(4999)
    expect(gate.isAllowed()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(gate.isAllowed()).toBe(false)
    expect(blocked).toHaveBeenCalledTimes(1)
    monitor.stop()
  })

  it.each([408, 429, 500, 502, 503, 504])('retries temporary HTTP status %s', (status) => {
    expect(isRetryableVerificationError(Object.assign(new Error('request failed'), { status }))).toBe(true)
    expect(isRetryableVerificationError(new Error(`currentuser request failed (${status})`))).toBe(true)
  })

  it.each([401, 403, '401', '403'])('blocks structured authority status %s immediately', async (status) => {
    vi.useFakeTimers()
    const { gate, verify, monitor } = setup()
    verify.mockRejectedValueOnce(Object.assign(new Error('request rejected'), { status }))
    monitor.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(gate.isAllowed()).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(gate.isAllowed()).toBe(false)
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
