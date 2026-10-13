import { describe, expect, it } from 'vitest'

import { enterpriseRequestSchemas } from '../enterprise'

describe('enterprise IPC schemas', () => {
  const listSkills = enterpriseRequestSchemas['enterprise.skills.list'].input

  it('accepts both legacy no-input calls and force refresh calls', () => {
    expect(listSkills.safeParse(undefined).success).toBe(true)
    expect(listSkills.safeParse({}).success).toBe(true)
    expect(listSkills.safeParse({ force: true }).success).toBe(true)
  })
})
