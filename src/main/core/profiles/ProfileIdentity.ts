import { createHash } from 'node:crypto'

export type AuthenticatedAccountKind = 'management' | 'official'
// export type AuthenticatedAuthMode = 'management-exchange' | 'management-oauth' | 'official-direct'
export type AuthenticatedAuthMode = 'management-exchange' | 'management-oauth' | 'management-cookie' | 'official-direct'

export type ProfileIdentity =
  | { kind: 'signed-out'; bootstrapId: 'signed-out' }
  | { kind: 'local'; deviceInstallId: string; localUserId: string }
  | {
      kind: 'authenticated'
      accountKind: AuthenticatedAccountKind
      issuerId: string
      subjectId: string
    }

function validateIdentityField(fieldName: string, value: string): void {
  if (value.length === 0) {
    throw new Error(`${fieldName} must not be empty`)
  }
  if (value.includes('\0')) {
    throw new Error(`${fieldName} must not contain NUL`)
  }
}

export function canonicalizeProfileIdentity(identity: ProfileIdentity): string {
  switch (identity.kind) {
    case 'signed-out':
      return 'v2\0signed-out\0signed-out'
    case 'local':
      validateIdentityField('deviceInstallId', identity.deviceInstallId)
      validateIdentityField('localUserId', identity.localUserId)
      if (identity.localUserId !== 'default') {
        throw new Error('localUserId must be default in profile identity v2')
      }
      return `v2\0local\0${identity.deviceInstallId}\0${identity.localUserId}`
    case 'authenticated':
      validateIdentityField('issuerId', identity.issuerId)
      validateIdentityField('subjectId', identity.subjectId)
      return `v2\0authenticated\0${identity.accountKind}\0${identity.issuerId}\0${identity.subjectId}`
  }
}

export function computeIdentityDigest(identity: ProfileIdentity): string {
  return createHash('sha256').update(canonicalizeProfileIdentity(identity), 'utf8').digest('hex')
}

export function computeProfileId(identity: ProfileIdentity): string {
  return computeIdentityDigest(identity).slice(0, 32)
}

export function normalizeAuthenticatedSubject(
  authMode: AuthenticatedAuthMode,
  issuerId: string,
  subjectId: string
): Extract<ProfileIdentity, { kind: 'authenticated' }> {
  validateIdentityField('issuerId', issuerId)
  validateIdentityField('subjectId', subjectId)

  return {
    kind: 'authenticated',
    accountKind: authMode === 'official-direct' ? 'official' : 'management',
    issuerId,
    subjectId
  }
}
