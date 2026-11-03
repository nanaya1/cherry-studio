import { describe, expect, it } from 'vitest'

import { enterpriseRequestSchemas, verificationStatusSchema } from '../enterprise'

describe('enterprise IPC schemas', () => {
  const listSkills = enterpriseRequestSchemas['enterprise.skills.list'].input

  it('validates account-owned verification revisions and authoritative block reasons', () => {
    const status = { owner: 'profile:runtime', revision: 2, state: 'blocked', reason: 'credentials-invalid' }
    expect(verificationStatusSchema.parse(status)).toEqual(status)
    expect(verificationStatusSchema.safeParse({ ...status, revision: -1 }).success).toBe(false)
    expect(verificationStatusSchema.safeParse({ ...status, revision: 1.5 }).success).toBe(false)
    expect(verificationStatusSchema.safeParse({ ...status, reason: 'network-error' }).success).toBe(false)
    expect(verificationStatusSchema.safeParse({ ...status, generation: 5 }).success).toBe(false)
    expect(enterpriseRequestSchemas['enterprise.verification.get'].output.parse(status)).toEqual(status)
    expect(enterpriseRequestSchemas['enterprise.verification.retry'].output.parse(undefined)).toBeUndefined()
  })

  it('accepts both legacy no-input calls and force refresh calls', () => {
    expect(listSkills.safeParse(undefined).success).toBe(true)
    expect(listSkills.safeParse({}).success).toBe(true)
    expect(listSkills.safeParse({ force: true }).success).toBe(true)
  })
})
