import { describe, expect, it } from 'vitest'

import { BusinessAccessGate } from '../BusinessAccessGate'

function makeGate(now: () => number, windowMs = 1000) {
  return new BusinessAccessGate({ clock: now, verificationWindowMs: windowMs })
}

describe('BusinessAccessGate', () => {
  it('starts in the verifying state and blocks reads and writes', () => {
    const now = 0
    const gate = makeGate(() => now)

    expect(gate.state).toMatchObject({ kind: 'verifying' })
    expect(() => gate.assertReadable()).toThrow(/verifying|blocked/i)
    expect(() => gate.assertWritable()).toThrow(/verifying|blocked/i)
    expect(gate.isAllowed()).toBe(false)
  })

  it('allows reads and writes after a successful verification with a monotonic deadline', () => {
    const now = 500
    const gate = makeGate(() => now, 1000)

    gate.recordVerificationSuccess()

    expect(gate.state).toMatchObject({ kind: 'verified-online', expiresAt: 1500 })
    expect(gate.isAllowed()).toBe(true)
    expect(() => gate.assertReadable()).not.toThrow()
    expect(() => gate.assertWritable()).not.toThrow()
  })

  it('refreshes the deadline on a normal re-verify instead of re-blocking', () => {
    let now = 0
    const gate = makeGate(() => now, 1000)

    gate.recordVerificationSuccess()
    const firstExpiry = (gate.state as { expiresAt: number }).expiresAt

    now = 900
    gate.beginVerification()
    expect(gate.state).toMatchObject({ kind: 'verifying' })
    expect(() => gate.assertWritable()).toThrow(/verifying|blocked/i)

    gate.recordVerificationSuccess()
    const secondExpiry = (gate.state as { expiresAt: number }).expiresAt

    expect(secondExpiry).toBe(1900)
    expect(secondExpiry).toBeGreaterThan(firstExpiry)
    expect(gate.isAllowed()).toBe(true)
  })

  it('blocks access once the monotonic deadline elapses', () => {
    let now = 0
    const gate = makeGate(() => now, 1000)

    gate.recordVerificationSuccess()

    now = 1000
    // Access boundary enforces expiry even before the state machine is updated.
    expect(() => gate.assertReadable()).toThrow(/expired|blocked/i)

    gate.enforceDeadline()
    expect(gate.state).toMatchObject({ kind: 'blocked' })
    expect(gate.isAllowed()).toBe(false)
    expect(() => gate.assertWritable()).toThrow(/blocked|expired/i)
  })

  it('retains the deadline while verification is in flight', () => {
    let now = 0
    const gate = makeGate(() => now)
    gate.recordVerificationSuccess()
    now = 900
    gate.beginVerification()
    now = 1000
    gate.recordVerificationSuccess()
    expect(gate.isAllowed()).toBe(false)
    expect(gate.state.kind).toBe('blocked')
  })

  it('cannot renew an expired lease with a late successful response', () => {
    let now = 0
    const gate = makeGate(() => now)
    gate.recordVerificationSuccess()
    now = 1000
    gate.recordVerificationSuccess()
    expect(gate.isAllowed()).toBe(false)
    expect(gate.state.kind).toBe('blocked')
  })

  it('preserves only the remaining lease on retryable failures', () => {
    let now = 0
    const gate = makeGate(() => now)
    gate.recordVerificationSuccess()
    now = 900
    gate.recordVerificationFailure('network unavailable', true)
    expect(gate.isAllowed()).toBe(true)
    expect(() => gate.assertReadable()).not.toThrow()
    expect(() => gate.assertWritable()).not.toThrow()
    now = 999
    gate.recordVerificationFailure('still unavailable', true)
    expect(gate.isAllowed()).toBe(true)
    now = 1000
    expect(gate.isAllowed()).toBe(false)
    gate.recordVerificationSuccess()
    expect(gate.isAllowed()).toBe(false)
  })

  it('does not grant access on a retryable failure before any successful verification', () => {
    const gate = makeGate(() => 0)
    gate.recordVerificationFailure('offline', true)
    expect(gate.isAllowed()).toBe(false)
  })

  it('transitions to blocked on verification failure', () => {
    const now = 0
    const gate = makeGate(() => now)

    gate.recordVerificationSuccess()
    gate.recordVerificationFailure('token rejected')

    expect(gate.state).toMatchObject({ kind: 'blocked', reason: 'token rejected' })
    expect(() => gate.assertReadable()).toThrow(/blocked/i)
  })

  it('recovers from blocked only to restart-required, never back to verified-online', () => {
    const now = 0
    const gate = makeGate(() => now)

    gate.recordVerificationSuccess()
    gate.recordVerificationFailure('hard failure')
    gate.recoverFromBlocked()

    expect(gate.state).toMatchObject({ kind: 'restart-required' })
    expect(() => gate.assertReadable()).toThrow(/restart/i)
    expect(() => gate.assertWritable()).toThrow(/restart/i)

    // A late successful verification must not silently unblock a durable state.
    gate.recordVerificationSuccess()
    expect(gate.state).toMatchObject({ kind: 'restart-required' })
    expect(gate.isAllowed()).toBe(false)
  })

  it('ignores verification attempts while blocked or restart-required', () => {
    const now = 0
    const gate = makeGate(() => now)

    gate.recordVerificationFailure('initial')
    gate.beginVerification()
    expect(gate.state).toMatchObject({ kind: 'blocked' })

    gate.recoverFromBlocked()
    gate.beginVerification()
    expect(gate.state).toMatchObject({ kind: 'restart-required' })
  })

  it('keeps restart-required idempotent under repeat recovery', () => {
    const now = 0
    const gate = makeGate(() => now)

    gate.recordVerificationFailure('x')
    gate.recoverFromBlocked()
    gate.recoverFromBlocked()

    expect(gate.state).toMatchObject({ kind: 'restart-required' })
  })
})
