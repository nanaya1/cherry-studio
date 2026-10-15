import { describe, expect, it } from 'vitest'

import { ProfileAuthEpoch, type ProfileAuthSnapshot } from '../ProfileAuthEpoch'

describe('ProfileAuthEpoch', () => {
  it('accepts a snapshot taken at the current epoch', () => {
    const epoch = new ProfileAuthEpoch()
    const snapshot = epoch.snapshot()

    expect(() => epoch.assertCurrent(snapshot)).not.toThrow()
  })

  it('invalidates a held snapshot once the auth epoch advances', () => {
    const epoch = new ProfileAuthEpoch()
    const snapshot = epoch.snapshot()

    epoch.advanceAuth()

    expect(() => epoch.assertCurrent(snapshot)).toThrow(/stale|expired|auth epoch/i)
  })

  it('accepts a freshly taken snapshot after an advance', () => {
    const epoch = new ProfileAuthEpoch()
    epoch.advanceAuth()

    const fresh = epoch.snapshot()
    expect(() => epoch.assertCurrent(fresh)).not.toThrow()
  })

  it('invalidates snapshots when profileGeneration advances', () => {
    const epoch = new ProfileAuthEpoch()
    const snapshot = epoch.snapshot()

    epoch.advanceProfile()

    expect(() => epoch.assertCurrent(snapshot)).toThrow(/stale|expired/i)
  })

  it('invalidates snapshots when authorizationGeneration advances', () => {
    const epoch = new ProfileAuthEpoch()
    const snapshot = epoch.snapshot()

    epoch.advanceAuthorization()

    expect(() => epoch.assertCurrent(snapshot)).toThrow(/stale|expired/i)
  })

  it('captures the live generation numbers in the snapshot', () => {
    const epoch = new ProfileAuthEpoch({ authEpoch: 3, profileGeneration: 7, authorizationGeneration: 2 })
    const snapshot = epoch.snapshot()

    expect(snapshot.authEpoch).toBe(3)
    expect(snapshot.profileGeneration).toBe(7)
    expect(snapshot.authorizationGeneration).toBe(2)
  })

  it('rejects a caller-forged snapshot that copies the current values but lacks the seal', () => {
    const epoch = new ProfileAuthEpoch()
    const live = epoch.snapshot()

    const forged = {
      authEpoch: live.authEpoch,
      profileGeneration: live.profileGeneration,
      authorizationGeneration: live.authorizationGeneration
    } as unknown as ProfileAuthSnapshot

    expect(() => epoch.assertCurrent(forged)).toThrow(/not authentic|seal|unauthentic/i)
  })

  it('rejects a snapshot carrying an unrelated seal but missing the genuine key', () => {
    const epoch = new ProfileAuthEpoch()
    const live = epoch.snapshot()

    const tampered = {
      authEpoch: live.authEpoch,
      profileGeneration: live.profileGeneration,
      authorizationGeneration: live.authorizationGeneration,
      [Symbol.for('some-other-seal')]: true
    } as unknown as ProfileAuthSnapshot

    expect(() => epoch.assertCurrent(tampered)).toThrow(/not authentic|seal|unauthentic/i)
  })

  it('does not accept a snapshot minted by a different epoch instance', () => {
    const a = new ProfileAuthEpoch()
    const b = new ProfileAuthEpoch()
    const fromA = a.snapshot()

    expect(() => b.assertCurrent(fromA)).toThrow(/not authentic|seal|unauthentic|stale/i)
  })
})
