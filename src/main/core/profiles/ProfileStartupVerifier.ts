import type { StartupCurrentUserTransport } from '@main/enterprise/orgCurrentUserTransport'
import type { OrgCurrentUser, OrgSession } from '@main/enterprise/types'
import { isDefinitiveVerificationError } from '@main/enterprise/verification'

/**
 * ProfileStartupVerifier gates business startup on a live online identity check.
 * The HTTP contract is injected so this module stays Electron-free and testable.
 */
import { computeIdentityDigest } from './ProfileIdentity'
import type { ProfileLaunchContext } from './ProfilePrebootCoordinator'

export type StartupVerificationResult =
  | { kind: 'verified'; currentUser: OrgCurrentUser; session: OrgSession }
  | { kind: 'failed'; reason: string; failureKind?: 'unavailable' | 'invalid'; failureContext: ProfileLaunchContext }

export interface VerifyCandidateProfileParams {
  context: ProfileLaunchContext
  session: OrgSession | null
  transport: StartupCurrentUserTransport
  buildFailureContext: (dataRoot: string) => ProfileLaunchContext
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function verifyCandidateProfile(params: VerifyCandidateProfileParams): Promise<StartupVerificationResult> {
  const { context, session, transport, buildFailureContext } = params
  const fail = (reason: string, failureKind: 'unavailable' | 'invalid' = 'unavailable'): StartupVerificationResult => ({
    kind: 'failed',
    reason,
    failureKind,
    failureContext: buildFailureContext(context.dataRoot)
  })

  if (context.kind !== 'authenticated') {
    return fail('candidate profile is not an authenticated business profile')
  }
  if (!session) {
    return fail('no credential stored for candidate profile; login required', 'invalid')
  }
  // official is legacy schema-compat and cannot obtain business qualification.
  if (session.accountKind === 'official') {
    return fail('official account kind cannot launch business; management login required')
  }

  let currentUser: OrgCurrentUser
  try {
    currentUser = await transport.getCurrentUser()
  } catch (error) {
    return fail(
      `currentuser verification failed: ${errorMessage(error)}`,
      isDefinitiveVerificationError(error) ? 'invalid' : 'unavailable'
    )
  }

  // if (!currentUser?.user || typeof currentUser.user !== 'object') {
  if (!currentUser?.user || typeof currentUser.user !== 'object' || Array.isArray(currentUser.user)) {
    return fail('currentuser response did not include a user')
  }
  const serverInstanceId = currentUser.server_instance_id
  // if (typeof serverInstanceId !== 'string' || serverInstanceId.length === 0) {
  if (typeof serverInstanceId !== 'string' || serverInstanceId.trim().length === 0) {
    return fail('currentuser response missing server_instance_id')
  }
  const user = currentUser.user
  // const userId = typeof user.id === 'number' ? String(user.id) : user.id
  const userId =
    typeof user.id === 'number' && Number.isSafeInteger(user.id) && user.id >= 0 ? String(user.id) : user.id
  // if (typeof userId !== 'string' || userId.length === 0) {
  if (typeof userId !== 'string' || userId.trim().length === 0) {
    return fail('currentuser response missing user.id')
  }
  // MEA:profile-verification-network-tolerance Incomplete evidence never becomes an identity rejection.
  if (
    typeof user.role !== 'string' ||
    !user.role.trim() ||
    !(
      (typeof user.group_id === 'string' && user.group_id.trim()) ||
      (typeof user.group_id === 'number' && Number.isSafeInteger(user.group_id) && user.group_id >= 0)
    ) ||
    typeof user.status !== 'string'
  ) {
    return fail('currentuser response has incomplete account context')
  }
  for (const field of ['username', 'displayName', 'phone', 'officialUserId'] as const) {
    if (user[field] !== undefined && user[field] !== null && typeof user[field] !== 'string') {
      return fail(`currentuser response has invalid ${field}`)
    }
  }
  if (user.status !== 'active') {
    return fail(`management account is not active (${user.status})`)
  }

  // Strict identity: serverInstanceId + userId + accountKind must match the
  // canonical digest. A wrong instance/user/auth domain must never become business.
  const expectedDigest = computeIdentityDigest({
    kind: 'authenticated',
    accountKind: session.accountKind,
    issuerId: serverInstanceId,
    subjectId: userId
  })
  if (expectedDigest !== context.identityDigest) {
    return fail('live identity digest does not match candidate profile', 'invalid')
  }
  if (session.userId !== userId || session.issuerId !== serverInstanceId) {
    return fail('live identity does not match the stored session', 'invalid')
  }

  return { kind: 'verified', currentUser, session }
}
