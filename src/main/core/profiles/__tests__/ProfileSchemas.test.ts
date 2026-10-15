import { describe, expect, it } from 'vitest'

import {
  ActiveProfilePointerV1Schema,
  InstallationRecordV1Schema,
  ProfileRecordV1Schema,
  ProfileRegistryV1Schema,
  ProfileSwitchJournalV1Schema
} from '..'

const UUID = '550e8400-e29b-41d4-a716-446655440000'
const PROFILE_ID = '0123456789abcdef0123456789abcdef'
const DIGEST = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const ISO_TIME = '2026-10-14T12:34:56.000Z'

const profileRecord = {
  version: 1,
  profileId: PROFILE_ID,
  identityDigest: DIGEST,
  kind: 'authenticated',
  state: 'ready',
  createdAt: ISO_TIME,
  display: { label: 'Alice' },
  authorizationContext: {
    groupId: 'group-1',
    role: 'admin',
    status: 'active',
    checkedAt: ISO_TIME
  }
} as const

describe('ProfileSchemas', () => {
  it('parses every fixed v1 control-plane document', () => {
    expect(InstallationRecordV1Schema.parse({ version: 1, deviceInstallId: UUID, createdAt: ISO_TIME })).toEqual({
      version: 1,
      deviceInstallId: UUID,
      createdAt: ISO_TIME
    })
    expect(ProfileRecordV1Schema.parse(profileRecord)).toEqual(profileRecord)
    expect(ProfileRegistryV1Schema.parse({ version: 1, profiles: [profileRecord] })).toEqual({
      version: 1,
      profiles: [profileRecord]
    })
    expect(
      ActiveProfilePointerV1Schema.parse({
        version: 1,
        profileId: PROFILE_ID,
        identityDigest: DIGEST,
        committedAt: ISO_TIME
      })
    ).toBeTruthy()
  })

  it.each([
    [InstallationRecordV1Schema, { version: 1, deviceInstallId: UUID, createdAt: ISO_TIME, extra: true }],
    [ProfileRecordV1Schema, { ...profileRecord, extra: true }],
    [ProfileRegistryV1Schema, { version: 1, profiles: [], extra: true }],
    [
      ActiveProfilePointerV1Schema,
      { version: 1, profileId: PROFILE_ID, identityDigest: DIGEST, committedAt: ISO_TIME, extra: true }
    ],
    [
      ProfileSwitchJournalV1Schema,
      {
        version: 1,
        operationId: UUID,
        phase: 'prepared',
        fromProfileId: 'signed-out',
        targetProfileId: PROFILE_ID,
        targetIdentityDigest: DIGEST,
        createdAt: ISO_TIME,
        extra: true
      }
    ]
  ])('rejects unknown top-level fields', (schema, value) => {
    expect(schema.safeParse(value).success).toBe(false)
  })

  it('rejects unknown nested display and authorization fields', () => {
    expect(
      ProfileRecordV1Schema.safeParse({ ...profileRecord, display: { label: 'Alice', extra: true } }).success
    ).toBe(false)
    expect(
      ProfileRecordV1Schema.safeParse({
        ...profileRecord,
        authorizationContext: { ...profileRecord.authorizationContext, token: 'secret' }
      }).success
    ).toBe(false)
  })

  it.each([
    [InstallationRecordV1Schema, { version: 2, deviceInstallId: UUID, createdAt: ISO_TIME }],
    [ProfileRecordV1Schema, { ...profileRecord, version: 2 }],
    [ProfileRegistryV1Schema, { version: 2, profiles: [] }],
    [ActiveProfilePointerV1Schema, { version: 2, profileId: PROFILE_ID, identityDigest: DIGEST, committedAt: ISO_TIME }]
  ])('rejects future schema versions', (schema, value) => {
    expect(schema.safeParse(value).success).toBe(false)
  })

  it.each([
    [{ ...profileRecord, profileId: undefined }],
    [{ ...profileRecord, identityDigest: undefined }],
    [{ ...profileRecord, kind: undefined }]
  ])('requires profile identity metadata', (value) => {
    expect(ProfileRecordV1Schema.safeParse(value).success).toBe(false)
  })

  it('rejects persisted identity details', () => {
    expect(
      ProfileRecordV1Schema.safeParse({
        ...profileRecord,
        identity: { kind: 'authenticated', accountKind: 'management', issuerId: 'issuer-1', subjectId: 'subject-1' }
      }).success
    ).toBe(false)
  })

  it('stores authorization context without making it part of identity metadata', () => {
    const parsed = ProfileRecordV1Schema.parse(profileRecord)

    expect(parsed.authorizationContext?.groupId).toBe('group-1')
    expect(parsed.profileId).toBe(PROFILE_ID)
    expect(parsed.identityDigest).toBe(DIGEST)
  })

  it('accepts only prepared and committed journal variants', () => {
    const prepared = {
      version: 1,
      operationId: UUID,
      phase: 'prepared',
      fromProfileId: 'signed-out',
      targetProfileId: PROFILE_ID,
      targetIdentityDigest: DIGEST,
      createdAt: ISO_TIME
    } as const

    expect(ProfileSwitchJournalV1Schema.safeParse(prepared).success).toBe(true)
    expect(
      ProfileSwitchJournalV1Schema.safeParse({ ...prepared, phase: 'committed', committedAt: ISO_TIME }).success
    ).toBe(true)
    expect(ProfileSwitchJournalV1Schema.safeParse({ ...prepared, phase: 'committed' }).success).toBe(false)
    expect(ProfileSwitchJournalV1Schema.safeParse({ ...prepared, phase: 'applying' }).success).toBe(false)
  })

  it.each([
    [InstallationRecordV1Schema, { version: 1, deviceInstallId: 'not-a-uuid', createdAt: ISO_TIME }],
    [ProfileRecordV1Schema, { ...profileRecord, profileId: 'ABC' }],
    [ProfileRecordV1Schema, { ...profileRecord, identityDigest: '0123' }],
    [
      ActiveProfilePointerV1Schema,
      { version: 1, profileId: '../escape', identityDigest: DIGEST, committedAt: ISO_TIME }
    ]
  ])('strictly validates UUID, profileId, and digest formats', (schema, value) => {
    expect(schema.safeParse(value).success).toBe(false)
  })

  it.each([
    [InstallationRecordV1Schema, { version: 1, deviceInstallId: UUID, createdAt: '' }],
    [ProfileRecordV1Schema, { ...profileRecord, createdAt: 'today' }],
    [ProfileRecordV1Schema, { ...profileRecord, authorizationContext: { checkedAt: '2026-99-99' } }],
    [
      ActiveProfilePointerV1Schema,
      { version: 1, profileId: PROFILE_ID, identityDigest: DIGEST, committedAt: 'not-iso' }
    ]
  ])('requires valid ISO date-time strings', (schema, value) => {
    expect(schema.safeParse(value).success).toBe(false)
  })

  it('does not expose credential or document-content fields in parsed control data', () => {
    expect(ProfileRecordV1Schema.safeParse({ ...profileRecord, token: 'secret' }).success).toBe(false)
    expect(ProfileRegistryV1Schema.safeParse({ version: 1, profiles: [], apiKey: 'secret' }).success).toBe(false)
    expect(
      ActiveProfilePointerV1Schema.safeParse({
        version: 1,
        profileId: PROFILE_ID,
        identityDigest: DIGEST,
        committedAt: ISO_TIME,
        documentContent: 'private'
      }).success
    ).toBe(false)
  })
})
