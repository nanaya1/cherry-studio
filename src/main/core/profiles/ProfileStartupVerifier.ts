import type { StartupCurrentUserTransport } from '@main/enterprise/orgCurrentUserTransport'
import type { OrgCurrentUser, OrgSession } from '@main/enterprise/types'

/**
 * ProfileStartupVerifier gates business startup on a live online identity check.
 * The HTTP contract is injected so this module stays Electron-free and testable.
 */
import { computeIdentityDigest } from './ProfileIdentity'
import type { ProfileLaunchContext } from './ProfilePrebootCoordinator'

export type StartupVerificationResult =
  | { kind: 'verified'; currentUser: OrgCurrentUser; session: OrgSession }
  | { kind: 'failed'; reason: string; failureContext: ProfileLaunchContext }

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
  const fail = (reason: string): StartupVerificationResult => ({
    kind: 'failed',
    reason,
    failureContext: buildFailureContext(context.dataRoot)
  })

  if (context.kind !== 'authenticated') {
    return fail('candidate profile is not an authenticated business profile')
  }
  if (!session) {
    return fail('no credential stored for candidate profile; login required')
  }
  // official is legacy schema-compat and cannot obtain business qualification.
  if (session.accountKind === 'official') {
    return fail('official account kind cannot launch business; management login required')
  }

  let currentUser: OrgCurrentUser
  try {
    currentUser = await transport.getCurrentUser()
  } catch (error) {
    return fail(`currentuser verification failed: ${errorMessage(error)}`)
  }

  if (!currentUser?.user || typeof currentUser.user !== 'object') {
    return fail('currentuser response did not include a user')
  }
  const serverInstanceId = currentUser.server_instance_id
  if (typeof serverInstanceId !== 'string' || serverInstanceId.length === 0) {
    return fail('currentuser response missing server_instance_id')
  }
  const user = currentUser.user
  const userId = typeof user.id === 'number' ? String(user.id) : user.id
  if (typeof userId !== 'string' || userId.length === 0) {
    return fail('currentuser response missing user.id')
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
    return fail('live identity digest does not match candidate profile')
  }
  if (session.userId !== userId || session.issuerId !== serverInstanceId) {
    return fail('live identity does not match the stored session')
  }

  return { kind: 'verified', currentUser, session }
}
