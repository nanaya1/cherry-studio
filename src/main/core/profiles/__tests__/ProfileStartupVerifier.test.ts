/**
 * ProfileStartupVerifier must gate business startup on a live online identity
 * check. The transport is injected so the HTTP/Cookie contract is exercised by
 * the transport tests, not here.
 */
import { describe, expect, it, vi } from 'vitest'

import { computeIdentityDigest } from '@main/core/profiles'
import type { OrgCurrentUser, OrgSession } from '@main/enterprise/types'

import type { ProfileLaunchContext } from '../ProfilePrebootCoordinator'
import { verifyCandidateProfile, type StartupVerificationResult } from '../ProfileStartupVerifier'

function businessContext(over: Partial<ProfileLaunchContext> = {}): ProfileLaunchContext {
  return {
    mode: 'business',
    profileId: 'p1',
    identityDigest: 'digest',
    kind: 'authenticated',
    dataRoot: '/data',
    profileRoot: '/data/profiles/p1',
    ...over
  }
}

function session(over: Partial<OrgSession> = {}): OrgSession {
  return {
    authMode: 'management-oauth',
    accountKind: 'management',
    issuerId: 'inst-1',
    authOrigin: 'inst-1',
    userId: 'u-1',
    officialUserId: '',
    groupId: 'g-1',
    displayName: 'Alice',
    phone: '',
    role: 'member',
    status: 'active',
    accessToken: 'tok',
    refreshToken: 'rt',
    expiresAt: 0,
    ...over
  }
}

function currentUser(over: Partial<OrgCurrentUser> = {}): OrgCurrentUser {
  return {
    server_instance_id: 'inst-1',
    user: { id: 'u-1', group_id: 'g-1', role: 'member', status: 'active' },
    ...over
  }
}

const signedOut: ProfileLaunchContext = businessContext({ mode: 'signed-out', kind: 'signed-out' })

function run(args: {
  context?: ProfileLaunchContext
  session?: OrgSession | null
  currentUser?: OrgCurrentUser
  transportError?: string
}): Promise<StartupVerificationResult> {
  const transport = {
    getCurrentUser: vi.fn().mockImplementation(async () => {
      if (args.transportError) throw new Error(args.transportError)
      return args.currentUser ?? currentUser()
    })
  }
  return verifyCandidateProfile({
    context:
      args.context ??
      businessContext({
        identityDigest: computeIdentityDigest({
          kind: 'authenticated',
          accountKind: 'management',
          issuerId: 'inst-1',
          subjectId: 'u-1'
        })
      }),
    session: args.session === undefined ? session() : args.session,
    transport,
    buildFailureContext: () => signedOut
  })
}

describe('ProfileStartupVerifier identity gate', () => {
  it('verifies when the live identity matches the candidate profile digest', async () => {
    const result = await run({})

    expect(result.kind).toBe('verified')
  })

  it('fails closed when no credential is stored for the candidate', async () => {
    const result = await run({ session: null })

    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') throw new Error('Expected failed verification')
    expect(result.reason).toMatch(/no credential/i)
    expect(result.failureContext).toBe(signedOut)
  })

  it('fails closed on a network/transport error', async () => {
    const result = await run({ transportError: 'currentuser request failed (network)' })

    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') throw new Error('Expected failed verification')
    expect(result.reason).toMatch(/network/)
  })

  it('fails closed when the server rejects the session (401)', async () => {
    const result = await run({ transportError: 'currentuser request failed (401)' })

    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') throw new Error('Expected failed verification')
    expect(result.reason).toMatch(/401/)
  })

  it('fails closed when the account is not active', async () => {
    const result = await run({
      currentUser: currentUser({ user: { id: 'u-1', group_id: 'g-1', role: 'member', status: 'inactive' } })
    })

    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') throw new Error('Expected failed verification')
    expect(result.reason).toMatch(/not active/i)
  })

  it('fails closed when the live server instance differs from the stored one', async () => {
    const result = await run({
      context: businessContext({
        identityDigest: computeIdentityDigest({
          kind: 'authenticated',
          accountKind: 'management',
          issuerId: 'inst-2',
          subjectId: 'u-1'
        })
      }),
      currentUser: currentUser({ server_instance_id: 'inst-1' })
    })

    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') throw new Error('Expected failed verification')
    expect(result.reason).toMatch(/digest|stored session/i)
  })

  it('fails closed when the live user id differs from the stored one', async () => {
    const result = await run({
      context: businessContext({
        identityDigest: computeIdentityDigest({
          kind: 'authenticated',
          accountKind: 'management',
          issuerId: 'inst-1',
          subjectId: 'u-2'
        })
      }),
      currentUser: currentUser({ user: { id: 'u-1', group_id: 'g-1', role: 'member', status: 'active' } })
    })

    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') throw new Error('Expected failed verification')
    expect(result.reason).toMatch(/digest|stored session/i)
  })

  it('fails closed when the candidate profile is not authenticated', async () => {
    const result = await run({ context: businessContext({ kind: 'local' }) })

    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') throw new Error('Expected failed verification')
    expect(result.reason).toMatch(/not an authenticated/i)
  })

  it('fails closed when the stored session is an official (legacy) account', async () => {
    const result = await run({ session: session({ accountKind: 'official', authMode: 'official-direct' }) })

    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') throw new Error('Expected failed verification')
    expect(result.reason).toMatch(/official/i)
  })

  it('treats numeric user ids from modern as their string form', async () => {
    const result = await run({
      context: businessContext({
        identityDigest: computeIdentityDigest({
          kind: 'authenticated',
          accountKind: 'management',
          issuerId: 'inst-1',
          subjectId: '7'
        })
      }),
      session: session({ userId: '7' }),
      currentUser: currentUser({ user: { id: 7, group_id: 'g-1', role: 'member', status: 'active' } })
    })

    expect(result.kind).toBe('verified')
  })
})
