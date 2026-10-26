import { session } from 'electron'
/**
 * Integration of the startup verification gate through profileIsolationRuntime:
 * the candidate's stored session is recovered and verified online before any
 * business service would register; failures route to a recovery window, never to
 * a signed-out profile bound to the candidate business disk.
 *
 * The global main-process electron mock (tests/main.setup.ts) already provides
 * app/session; we only add `session.fromPath` (which the mock omits) so the
 * verifier can reopen the candidate's cookie jar.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()

const mocks = vi.hoisted(() => ({
  sessionFetch: vi.fn(),
  fromPath: vi.fn(() => ({ fetch: mocks.sessionFetch })),
  credentialLoad: vi.fn()
}))

vi.mock('@main/core/profiles/ProfileAuthRuntime', () => ({
  restoreProfileAuthSession: async () => ({ fetch: mocks.sessionFetch })
}))

vi.mock('@main/enterprise/OrgCredentialStore', () => ({
  OrgCredentialStore: class {
    load = mocks.credentialLoad
  }
}))

import type { ProfileLaunchContext } from '@main/core/profiles/ProfilePrebootCoordinator'
import { ProfileAuthBroker } from '@main/enterprise/ProfileAuthBroker'
import type { OrgSession } from '@main/enterprise/types'

import { buildSignedOutLaunchContext, verifyBusinessCandidate } from '../profileIsolationRuntime'

beforeAll(() => {
  ;(session as unknown as { fromPath: typeof mocks.fromPath }).fromPath = mocks.fromPath
})

function businessContext(over: Partial<ProfileLaunchContext> = {}): ProfileLaunchContext {
  return {
    mode: 'business',
    profileId: 'p1',
    identityDigest: ProfileAuthBroker.expectedIdentityDigest('management', 'inst-1', 'u-1'),
    kind: 'authenticated',
    dataRoot: '/data',
    profileRoot: '/data/profiles/p1',
    ...over
  }
}

function bearerSession(over: Partial<OrgSession> = {}): OrgSession {
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

const currentUserResponse = () =>
  new Response(
    JSON.stringify({
      server_instance_id: 'inst-1',
      user: { id: 'u-1', group_id: 'g-1', role: 'member', status: 'active' }
    }),
    { status: 200 }
  )

describe('buildSignedOutLaunchContext', () => {
  it('produces a signed-out context for fail-closed routing', () => {
    const ctx = buildSignedOutLaunchContext('/data')
    expect(ctx.mode).toBe('signed-out')
    expect(ctx.kind).toBe('signed-out')
    expect(ctx.profileId).toBe('signed-out')
    expect(ctx.profileRoot).toContain('signed-out')
  })
})

describe('verifyBusinessCandidate through the runtime', () => {
  beforeEach(() => {
    mocks.fromPath.mockClear()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    fetchMock.mockReset()
    mocks.sessionFetch.mockReset()
    mocks.credentialLoad.mockReset()
    vi.unstubAllGlobals()
  })

  it('verifies a Bearer candidate and opens the business profile', async () => {
    mocks.credentialLoad.mockResolvedValue(bearerSession())
    fetchMock.mockResolvedValue(currentUserResponse())

    const result = await verifyBusinessCandidate(businessContext())

    expect(result.kind).toBe('verified')
    expect(mocks.fromPath).not.toHaveBeenCalled()
  })

  it('fails closed when the stored session is missing', async () => {
    mocks.credentialLoad.mockResolvedValue(null)

    const result = await verifyBusinessCandidate(businessContext())

    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') throw new Error('Expected failed verification')
    expect(result.reason).toMatch(/no credential/i)
    expect(result.failureContext.mode).toBe('signed-out')
  })

  it('routes unreadable credentials to recovery without issuing a request', async () => {
    mocks.credentialLoad.mockRejectedValue(new Error('secure storage unavailable'))
    const result = await verifyBusinessCandidate(businessContext())
    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') throw new Error('Expected failed verification')
    expect(result.failureContext.mode).toBe('signed-out')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails closed when the online check rejects the session', async () => {
    mocks.credentialLoad.mockResolvedValue(bearerSession())
    fetchMock.mockResolvedValue(new Response('no', { status: 401 }))

    const result = await verifyBusinessCandidate(businessContext())

    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') throw new Error('Expected failed verification')
    expect(result.reason).toMatch(/401/)
  })

  it('verifies a Cookie candidate through the Electron session fetch', async () => {
    mocks.credentialLoad.mockResolvedValue(bearerSession({ authMode: 'management-cookie', accessToken: '' }))
    mocks.sessionFetch.mockResolvedValue(currentUserResponse())

    const result = await verifyBusinessCandidate(businessContext())

    expect(result.kind).toBe('verified')
    expect(mocks.sessionFetch).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
