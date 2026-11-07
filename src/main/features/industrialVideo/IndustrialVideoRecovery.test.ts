import { describe, expect, it } from 'vitest'

import { canSubmitIndustrialVideo, reconcileIndustrialVideoJob } from './industrialVideoRecovery'

describe('industrial video recovery without duplicate submission', () => {
  it('does not infer identity from run alone or auto-claim an ambiguous candidate', () => {
    expect(reconcileIndustrialVideoJob(null, [{ job_id: 'j1', run: 'r1' }])).toEqual({ state: 'unknown' })
  })
  it('recovers only the exact persisted job identity', () => {
    expect(
      reconcileIndustrialVideoJob('j1', [
        { job_id: 'j2', status: 'done' },
        { job_id: 'j1', status: 'running' }
      ])
    ).toEqual({ state: 'found', job: { job_id: 'j1', status: 'running' } })
    expect(reconcileIndustrialVideoJob('j1', [])).toEqual({ state: 'unknown' })
  })
  it('blocks new submissions after unknown outcome or interrupted intent', () => {
    expect(canSubmitIndustrialVideo({ pendingIntent: true, unknownCount: 0, activeJob: false })).toBe(false)
    expect(canSubmitIndustrialVideo({ pendingIntent: false, unknownCount: 1, activeJob: false })).toBe(false)
    expect(canSubmitIndustrialVideo({ pendingIntent: false, unknownCount: 0, activeJob: true })).toBe(false)
    expect(canSubmitIndustrialVideo({ pendingIntent: false, unknownCount: 0, activeJob: false })).toBe(true)
  })
})
