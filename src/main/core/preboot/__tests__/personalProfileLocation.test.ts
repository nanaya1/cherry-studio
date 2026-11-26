import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolvePersonalProfileLocation } from '../personalProfileLocation'

const root = path.resolve('test-user-data')
const account = { kind: 'account', serverInstanceId: 'server-a', userId: '1' } as const

describe('personal profile location', () => {
  it('keeps legacy local data at the original root for guests', () => {
    expect(resolvePersonalProfileLocation(root, { kind: 'guest' })).toBe(root)
  })

  it('opens the same directory for the same account and separates users and server instances', () => {
    const first = resolvePersonalProfileLocation(root, account)
    expect(resolvePersonalProfileLocation(root, { ...account })).toBe(first)
    expect(resolvePersonalProfileLocation(root, { ...account, userId: '2' })).not.toBe(first)
    expect(resolvePersonalProfileLocation(root, { ...account, serverInstanceId: 'server-b' })).not.toBe(first)
  })

  it('contains account directories under the profile root and rejects invalid user IDs', () => {
    const location = resolvePersonalProfileLocation(root, { ...account, serverInstanceId: '../../outside' })
    expect(path.dirname(location)).toBe(path.join(root, 'PersonalProfiles'))
    expect(() => resolvePersonalProfileLocation(root, { ...account, userId: '../guest' })).toThrow()
  })
})
