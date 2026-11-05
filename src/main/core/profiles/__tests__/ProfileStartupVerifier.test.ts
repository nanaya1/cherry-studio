/**
 * ProfileStartupVerifier must gate business startup on a live online identity
 * check. The transport is injected so the HTTP/Cookie contract is exercised by
 * the transport tests, not here.
 */
import { describe, expect, it, vi } from 'vitest'

import type { OrgCurrentUser, OrgSession } from '@main/enterprise/types'
import { VerificationError } from '@main/enterprise/verification'

import { computeIdentityDigest } from '../ProfileIdentity'
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

function session(over: Partial<Exclude<OrgSession, { authMode: 'management-java' }>> = {}): OrgSession {
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
  transportError?: string | Error
}): Promise<StartupVerificationResult> {
  const transport = {
    getCurrentJavaProfile: vi.fn().mockImplementation(async () => {
      if (args.transportError) {
        throw args.transportError instanceof Error ? args.transportError : new Error(args.transportError)
      }
      const value = args.currentUser ?? currentUser()
      return {
        serverInstanceId: value.server_instance_id,
        userId: String(value.user.id),
        groupId: value.user.group_id,
        tenantId: 'tenant',
        roleCode: value.user.role,
        username: null
      }
    }),
    getCurrentUser: vi.fn().mockImplementation(async () => {
      if (args.transportError)
        throw typeof args.transportError === 'string' ? new Error(args.transportError) : args.transportError
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
    // session: args.session === undefined ? session() : args.session,
    session:
      args.session === undefined
        ? {
            authMode: 'management-java',
            accountKind: 'management',
            issuerId: 'inst-1',
            authOrigin: 'inst-1',
            userId: 'u-1',
            officialUserId: '',
            groupId: 'g-1',
            tenantId: 'tenant',
            role: 'member',
            displayName: null,
            phone: '',
            accessToken: 'raw',
            expiresAt: null
          }
        : args.session,
    transport,
    buildFailureContext: () => signedOut
  })
}

describe('ProfileStartupVerifier identity gate', () => {
  it('旧凭据在任何网络验证之前要求重登', async () => {
    const transport = { getCurrentUser: vi.fn() }
    const result = await verifyCandidateProfile({
      context: businessContext(),
      session: session(),
      transport,
      buildFailureContext: () => signedOut
    })
    expect(result.kind).toBe('failed')
    expect(transport.getCurrentUser).not.toHaveBeenCalled()
  })
  it('Java 无 status 会话以真实 me 身份通过且企业变化阻断', async () => {
    const candidate: OrgSession = {
      authMode: 'management-java',
      accountKind: 'management',
      issuerId: 'inst-1',
      authOrigin: 'inst-1',
      userId: 'u-1',
      officialUserId: '',
      groupId: null,
      tenantId: 'tenant',
      displayName: null,
      phone: '',
      role: 'member',
      accessToken: 'raw',
      expiresAt: null
    }
    const live = {
      serverInstanceId: 'inst-1',
      userId: 'u-1',
      tenantId: 'tenant',
      groupId: null,
      roleCode: 'member',
      username: null
    }
    const transport = { getCurrentUser: vi.fn(), getCurrentJavaProfile: vi.fn(async () => live) }
    const args = {
      context: businessContext({
        identityDigest: computeIdentityDigest({
          kind: 'authenticated',
          accountKind: 'management',
          issuerId: 'inst-1',
          subjectId: 'u-1'
        })
      }),
      session: candidate,
      transport,
      buildFailureContext: () => signedOut
    }
    expect((await verifyCandidateProfile(args)).kind).toBe('verified')
    transport.getCurrentJavaProfile.mockResolvedValueOnce({ ...live, tenantId: 'other' })
    expect((await verifyCandidateProfile(args)).kind).toBe('failed')
  })
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

  /* it('fails closed when the account is not active', async () => {
    const result = await run({
      currentUser: currentUser({ user: { id: 'u-1', group_id: 'g-1', role: 'member', status: 'inactive' } })
    })

    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') throw new Error('Expected failed verification')
    expect(result.reason).toMatch(/not active/i)
  }) */

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
    expect(result.reason).toMatch(/在线身份与本地账号不一致/)
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
    expect(result.reason).toMatch(/在线身份与本地账号不一致/)
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

  it.each(['network timeout', 'currentuser request failed (401)', '503', 'token expired', 'unexpected JSON'])(
    'keeps ambiguous transport failure retryable: %s',
    async (transportError) => {
      expect(await run({ transportError })).toMatchObject({ kind: 'failed', failureKind: 'unavailable' })
    }
  )

  it('recognizes only definitive structured authentication evidence as invalid', async () => {
    expect(
      await run({
        transportError: new VerificationError('confirmed rejection', {
          stage: 'current-user',
          endpoint: '/api/currentuser',
          kind: 'invalid',
          reason: 'credentials-invalid'
        })
      })
    ).toMatchObject({ kind: 'failed', failureKind: 'invalid' })
  })

  // 旧 currentuser status 契约已停用；Java /me 归一化后不提供 status。
  it.skip.each([
    { server_instance_id: 'inst-1', user: { id: 'u-1', status: 'active' } },
    currentUser({ user: { id: 'u-1', group_id: 'g-1', role: 'member', status: 'unexpected-status' } }),
    currentUser({ user: { id: 'u-1', group_id: 'g-1', role: 'member', status: 'inactive' } })
  ])('does not authorize or invalidate an incomplete or unknown response', async (response) => {
    expect(await run({ currentUser: response as OrgCurrentUser })).toMatchObject({
      kind: 'failed',
      failureKind: 'unavailable'
    })
  })

  it('classifies a complete but mismatched identity as invalid', async () => {
    expect(await run({ currentUser: currentUser({ server_instance_id: 'other-instance' }) })).toMatchObject({
      kind: 'failed',
      failureKind: 'invalid'
    })
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
      // session: session({ userId: '7' }),
      session: {
        authMode: 'management-java',
        accountKind: 'management',
        issuerId: 'inst-1',
        authOrigin: 'inst-1',
        userId: '7',
        officialUserId: '',
        groupId: 'g-1',
        tenantId: 'tenant',
        role: 'member',
        displayName: null,
        phone: '',
        accessToken: 'raw',
        expiresAt: null
      },
      currentUser: currentUser({ user: { id: 7, group_id: 'g-1', role: 'member', status: 'active' } })
    })

    expect(result.kind).toBe('verified')
  })
})
