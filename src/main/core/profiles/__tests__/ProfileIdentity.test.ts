import { describe, expect, it } from 'vitest'

import {
  canonicalizeProfileIdentity,
  computeIdentityDigest,
  computeProfileId,
  normalizeAuthenticatedSubject,
  type ProfileIdentity
} from '..'

const DEVICE_INSTALL_ID = '550e8400-e29b-41d4-a716-446655440000'

describe('ProfileIdentity', () => {
  it('uses the fixed canonical forms for all three identity kinds', () => {
    expect(canonicalizeProfileIdentity({ kind: 'signed-out', bootstrapId: 'signed-out' })).toBe(
      'v2\0signed-out\0signed-out'
    )
    expect(
      canonicalizeProfileIdentity({ kind: 'local', deviceInstallId: DEVICE_INSTALL_ID, localUserId: 'default' })
    ).toBe(`v2\0local\0${DEVICE_INSTALL_ID}\0default`)
    expect(
      canonicalizeProfileIdentity({
        kind: 'authenticated',
        accountKind: 'management',
        issuerId: 'issuer-1',
        subjectId: 'subject-1'
      })
    ).toBe('v2\0authenticated\0management\0issuer-1\0subject-1')
  })

  it('normalizes exchange and oauth to management and official-direct to official', () => {
    const exchange = normalizeAuthenticatedSubject('management-exchange', 'issuer-1', 'subject-1')
    const oauth = normalizeAuthenticatedSubject('management-oauth', 'issuer-1', 'subject-1')
    const official = normalizeAuthenticatedSubject('official-direct', 'issuer-1', 'subject-1')

    expect(exchange).toEqual({
      kind: 'authenticated',
      accountKind: 'management',
      issuerId: 'issuer-1',
      subjectId: 'subject-1'
    })
    expect(oauth).toEqual(exchange)
    expect(computeProfileId(oauth)).toBe(computeProfileId(exchange))
    expect(official.accountKind).toBe('official')
    expect(computeProfileId(official)).not.toBe(computeProfileId(exchange))
  })

  it('keeps identity namespaces and issuers collision-free', () => {
    const local: ProfileIdentity = { kind: 'local', deviceInstallId: DEVICE_INSTALL_ID, localUserId: 'default' }
    const management = normalizeAuthenticatedSubject('management-oauth', 'issuer-1', DEVICE_INSTALL_ID)
    const anotherIssuer = normalizeAuthenticatedSubject('management-oauth', 'issuer-2', DEVICE_INSTALL_ID)

    expect(computeProfileId(local)).not.toBe(computeProfileId(management))
    expect(computeProfileId(management)).not.toBe(computeProfileId(anotherIssuer))
  })

  it('does not include authorization context such as groupId in authenticated identity', () => {
    const first = normalizeAuthenticatedSubject('management-oauth', 'issuer-1', 'subject-1')
    const second = normalizeAuthenticatedSubject('management-oauth', 'issuer-1', 'subject-1')

    expect(computeProfileId(first)).toBe(computeProfileId(second))
  })

  it('uses stable SHA-256 vectors, truncating only profileId', () => {
    const identity: ProfileIdentity = {
      kind: 'local',
      deviceInstallId: DEVICE_INSTALL_ID,
      localUserId: 'default'
    }

    expect(computeIdentityDigest(identity)).toBe('dbdc5f543bbf6ccbf10a036d02301c608f6654de30d62d1561a0650b25100d0a')
    expect(computeProfileId(identity)).toBe('dbdc5f543bbf6ccbf10a036d02301c60')
    expect(computeProfileId(identity)).toMatch(/^[a-f0-9]{32}$/)
    expect(computeIdentityDigest(identity)).toMatch(/^[a-f0-9]{64}$/)
  })

  it.each([
    [{ kind: 'local', deviceInstallId: '', localUserId: 'default' }],
    [{ kind: 'local', deviceInstallId: DEVICE_INSTALL_ID, localUserId: '' }],
    [{ kind: 'local', deviceInstallId: 'device\0id', localUserId: 'default' }],
    [{ kind: 'authenticated', accountKind: 'management', issuerId: '', subjectId: 'subject' }],
    [{ kind: 'authenticated', accountKind: 'management', issuerId: 'issuer', subjectId: '' }],
    [{ kind: 'authenticated', accountKind: 'management', issuerId: 'issuer', subjectId: 'subject\0id' }]
  ] as const)('rejects empty or NUL-containing identity fields: %j', (identity) => {
    expect(() => canonicalizeProfileIdentity(identity as ProfileIdentity)).toThrow()
  })

  it('preserves whitespace and case instead of trimming or folding identifiers', () => {
    const identity = normalizeAuthenticatedSubject('management-oauth', ' Issuer ', ' Subject ')

    expect(identity.issuerId).toBe(' Issuer ')
    expect(identity.subjectId).toBe(' Subject ')
    expect(canonicalizeProfileIdentity(identity)).toBe('v2\0authenticated\0management\0 Issuer \0 Subject ')
  })

  it.each(['management-exchange', 'management-oauth', 'official-direct'] as const)(
    'validates normalized input fields for %s',
    (authMode) => {
      expect(() => normalizeAuthenticatedSubject(authMode, '', 'subject')).toThrow()
      expect(() => normalizeAuthenticatedSubject(authMode, 'issuer', 'subject\0id')).toThrow()
    }
  )
})
