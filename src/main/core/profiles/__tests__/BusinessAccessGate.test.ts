import { describe, expect, it } from 'vitest'

import { BusinessAccessGate } from '../BusinessAccessGate'

function makeGate(now: () => number) {
  return new BusinessAccessGate({ clock: now, verificationWindowMs: 1000 })
}

describe('BusinessAccessGate', () => {
  it('requires the first online verification before business reads and writes', () => {
    const gate = makeGate(() => 0)
    gate.recordVerificationFailure('offline', true)
    expect(() => gate.assertReadable()).toThrow()
    expect(() => gate.assertWritable()).toThrow()
    gate.beginVerification()
    gate.recordVerificationSuccess()
    expect(() => gate.assertReadable()).not.toThrow()
    expect(() => gate.assertWritable()).not.toThrow()
  })

  it('keeps verified authorization during rechecks, temporary failures and indefinite network loss', () => {
    let now = 0
    const gate = makeGate(() => now)
    gate.recordVerificationSuccess()
    gate.beginVerification()
    expect(() => gate.assertWritable()).not.toThrow()
    gate.recordVerificationFailure('DNS lookup failed', true)
    now = 365 * 24 * 60 * 60_000
    gate.enforceDeadline()
    expect(() => gate.assertReadable()).not.toThrow()
    expect(() => gate.assertWritable()).not.toThrow()
  })

  it('does not manufacture a successful check time during a temporary failure', () => {
    let now = 100
    const gate = makeGate(() => now)
    gate.recordVerificationSuccess()
    now = 100_000
    gate.recordVerificationFailure('unavailable', true)
    expect(gate.state).toMatchObject({ kind: 'verified-online', checkedAt: 100 })
  })

  it('never unlocks a definitive block through late success or ordinary retry', () => {
    const gate = makeGate(() => 0)
    gate.recordVerificationSuccess()
    gate.recordVerificationFailure('identity-changed')
    gate.beginVerification()
    gate.recordVerificationSuccess()
    expect(() => gate.assertReadable()).toThrow(/blocked/)
    expect(() => gate.assertWritable()).toThrow(/blocked/)
    gate.recoverFromBlocked()
    gate.recordVerificationSuccess()
    expect(() => gate.assertWritable()).toThrow(/restart/)
  })
})
