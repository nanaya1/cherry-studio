import { describe, expect, it } from 'vitest'

import { profileRequestSchemas } from '../profile'

describe('profile claim IPC schemas', () => {
  it('does not expose claim after authenticated business bootstrap', () => {
    expect(Object.keys(profileRequestSchemas)).not.toContain('profile.claim.preview')
    expect(Object.keys(profileRequestSchemas)).not.toContain('profile.claim.confirm')
  })
})
