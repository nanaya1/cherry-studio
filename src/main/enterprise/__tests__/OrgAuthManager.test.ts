/**
 * [enterprise] C3 OrgAuthManager 登出/重登的 org 资源状态标记测试
 * logout → orgStateStore.markUnavailable；登录成功 → markAvailable。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as OrgApiClientModule from '../OrgApiClient'

const { stateStoreMock, authConfig, cookieSession, replaceCookies } = vi.hoisted(() => ({
  authConfig: { mode: 'official-direct' },
  cookieSession: { fetch: vi.fn(), cookies: { get: vi.fn(), remove: vi.fn(), flushStore: vi.fn() } },
  replaceCookies: vi.fn(),
  stateStoreMock: {
    markUnavailable: vi.fn(),
    markAvailable: vi.fn(),
    snapshotUnavailable: vi.fn().mockReturnValue(false)
  }
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) }
}))

vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: vi.fn(() => '/tmp') },
  shell: { openExternal: vi.fn().mockResolvedValue(undefined) }
}))

vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  return mockApplicationFactory()
})

vi.mock('@main/enterprise/OrgCredentialStore', () => ({
  OrgCredentialStore: class {
    load = vi.fn().mockReturnValue(null)
    save = vi.fn()
    clear = vi.fn()
  }
}))

vi.mock('@main/enterprise/OrgStateStore', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, orgStateStore: stateStoreMock }
})

vi.mock('../OrgApiClient', async (importOriginal) => {
  const actual = await importOriginal<typeof OrgApiClientModule>()
  return {
    ...actual,
    get ORG_AUTH_MODE() {
      return authConfig.mode
    },
    ORG_SERVER_BASE_URL: 'https://management.example'
  }
})

vi.mock('@main/core/profiles', async () => {
  const runtime = await import('../../core/profiles/ProfileRuntimeContext')
  return {
    ...(await import('../../core/profiles/ProfileIdentity')),
    ...runtime,
    ...(await import('../../core/profiles/ProfileAuthEpoch')),
    ...(await import('../../core/profiles/SwitchFence')),
    ...(await import('../../core/profiles/ProfileAuthSession')),
    getProfileAuthSession: () => cookieSession,
    runAuthSessionOperation: replaceCookies,
    get profileBusinessAccessGate() {
      return runtime.profileBusinessAccessGate
    }
  }
})

import { application } from '@application'
import { OrgAuthManager } from '@main/enterprise/OrgAuthManager'

import { profileBusinessAccessGate, setProfileLaunchContext } from '../../core/profiles/ProfileRuntimeContext'
import type { OrgCredentialStore, OrgSession } from '../OrgCredentialStore'
import { ProfileAuthBroker } from '../ProfileAuthBroker'
import { VerificationError } from '../verification'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const managementSession: OrgSession = {
  authMode: 'management-oauth',
  accountKind: 'management',
  issuerId: 'server',
  authOrigin: 'https://management.example',
  userId: '7',
  officialUserId: '',
  groupId: '2',
  displayName: 'Alice',
  phone: '',
  role: 'member',
  status: 'active',
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  expiresAt: 0
}

function seedSession(manager: OrgAuthManager, session = managementSession) {
  ;(manager as unknown as { session: OrgSession }).session = session
}

describe('OrgAuthManager C3 组织可用性标记', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authConfig.mode = 'official-direct'
    setProfileLaunchContext(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('persists logout intent before contacting the server and retains signed-out state on switch failure', async () => {
    let durableIntent = false
    const profileSession = {
      beginLogout: vi.fn(async () => {
        durableIntent = true
      }),
      logout: vi.fn(async () => ({ kind: 'teardown-failed', error: 'busy' }))
    }
    const manager = new OrgAuthManager({
      credentialStore: { clear: vi.fn() } as never,
      profileSession: profileSession as never
    })
    seedSession(manager)
    vi.spyOn(manager.apiClient, 'revoke').mockImplementation(async () => {
      expect(durableIntent).toBe(true)
    })
    await expect(manager.logout()).rejects.toThrow('profile logout failed')
    expect(await manager.getValidSession()).toBeNull()
    await expect(manager.startLogin()).rejects.toThrow('requires restart')
  })

  it('continues the local logout when remote revocation is offline', async () => {
    const profileSession = {
      beginLogout: vi.fn(async () => undefined),
      logout: vi.fn(async () => ({ kind: 'relaunching' }))
    }
    const manager = new OrgAuthManager({ credentialStore: {} as never, profileSession: profileSession as never })
    seedSession(manager)
    vi.spyOn(manager.apiClient, 'revoke').mockRejectedValue(new Error('offline'))
    await expect(manager.logout()).resolves.toEqual({ state: 'switching', revocationWarning: 'offline' })
    expect(await manager.getValidSession()).toBeNull()
    expect(profileSession.logout).toHaveBeenCalledOnce()
  })

  it.each([502, 503, 504])('retains the local session when refresh returns %s', async (status) => {
    const manager = new OrgAuthManager()
    seedSession(manager)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status })))
    await expect(manager.getValidSession()).resolves.toMatchObject({ accessToken: 'old-access' })
    expect(manager.getStatus().phase).toBe('signed-in')
  })

  it('retains the local session when refresh fails from a network error', async () => {
    const manager = new OrgAuthManager()
    seedSession(manager)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    await expect(manager.getValidSession()).resolves.toMatchObject({ accessToken: 'old-access' })
    expect(manager.getStatus().phase).toBe('signed-in')
  })

  it('does not infer invalidity from an undocumented refresh 401', async () => {
    const manager = new OrgAuthManager()
    seedSession(manager)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })))
    await expect(manager.getValidSession()).resolves.toMatchObject({ accessToken: 'old-access' })
    expect(manager.getVerificationStatus().state).toBe('unavailable')
  })

  it('does not infer credential invalidity from a network error message', async () => {
    const manager = new OrgAuthManager()
    seedSession(manager)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('refresh token revoked')))
    await expect(manager.getValidSession()).resolves.toMatchObject({ accessToken: 'old-access' })
    expect(manager.getStatus().phase).toBe('signed-in')
  })

  it('merges manual and background verification and refreshes once without recursive verification', async () => {
    const manager = new OrgAuthManager()
    seedSession(manager)
    let refreshes = 0
    let checks = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith('/refresh')) {
          refreshes++
          return new Response(JSON.stringify({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 1 }))
        }
        checks++
        expect(init.headers).toEqual({ authorization: 'Bearer new-access' })
        return new Response(
          JSON.stringify({
            server_instance_id: 'server',
            user: { id: 7, group_id: 2, role: 'member', status: 'active' }
          })
        )
      })
    )
    const first = manager.retryVerification()
    expect(manager.verifyOnlineAuthority()).toBe(first)
    expect(manager.revalidateAuthority()).toBe(first)
    await first
    expect(refreshes).toBe(1)
    expect(checks).toBe(1)
    expect(manager.getVerificationStatus().state).toBe('verified')
  })

  it('synchronously fences and merges duplicate user logout before durable intent resolves', async () => {
    const intent = deferred<void>()
    const manager = new OrgAuthManager({
      credentialStore: {} as never,
      profileSession: {
        beginLogout: () => intent.promise,
        logout: async () => ({ kind: 'signed-out' })
      } as never
    })
    seedSession(manager)
    profileBusinessAccessGate.recordVerificationSuccess()
    vi.spyOn(manager.apiClient, 'revoke').mockResolvedValue(undefined)
    const logout = manager.logout()
    expect(manager.logout()).toBe(logout)
    expect(profileBusinessAccessGate.isAllowed()).toBe(false)
    expect(manager.getVerificationStatus().state).toBe('switching')
    expect(manager.getStatus().phase).toBe('switching')
    expect(application.beginProfileLogout).toHaveBeenCalledOnce()
    intent.resolve()
    await logout
  })

  // 捕获完成后的重复退出再次执行撤销或持久化转换、重新开放业务权限的缺陷。
  it('重复 logout 在转换中及完成后复用同一结果，不重复撤销或转换', async () => {
    const transition = deferred<{ kind: 'signed-out' }>()
    let durableIntent = false
    let transitions = 0
    let revocations = 0
    const manager = new OrgAuthManager({
      credentialStore: {} as never,
      profileSession: {
        beginLogout: async () => {
          durableIntent = true
        },
        logout: async () => {
          transitions++
          return transition.promise
        }
      } as never
    })
    seedSession(manager)
    profileBusinessAccessGate.recordVerificationSuccess()
    vi.spyOn(manager.apiClient, 'revoke').mockImplementation(async () => {
      expect(durableIntent).toBe(true)
      revocations++
    })
    const first = manager.logout()
    await vi.waitFor(() => expect(transitions).toBe(1))
    expect(manager.logout()).toBe(first)
    transition.resolve({ kind: 'signed-out' })
    expect(await first).toEqual({ state: 'switching', revocationWarning: null })
    expect(manager.logout()).toBe(first)
    expect(await manager.logout()).toEqual(await first)
    expect(transitions).toBe(1)
    expect(revocations).toBe(1)
    expect(await manager.getValidSession()).toBeNull()
    expect(profileBusinessAccessGate.isAllowed()).toBe(false)
    manager.dispose()
  })

  it('keeps a proven identity block terminal for normal retry and never logs out in background', async () => {
    const manager = new OrgAuthManager()
    seedSession(manager, { ...managementSession, expiresAt: Number.MAX_SAFE_INTEGER })
    profileBusinessAccessGate.recordVerificationSuccess()
    const logout = vi.spyOn(manager, 'logout')
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              server_instance_id: 'other-server',
              user: { id: 7, group_id: 2, role: 'member', status: 'active' }
            })
          )
      )
    )
    await expect(manager.retryVerification()).rejects.toMatchObject({
      evidence: { kind: 'invalid', reason: 'identity-changed' }
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              server_instance_id: 'server',
              user: { id: 7, group_id: 2, role: 'member', status: 'active' }
            })
          )
      )
    )
    await expect(manager.retryVerification()).rejects.toThrow(/authentication/)
    expect(profileBusinessAccessGate.isAllowed()).toBe(false)
    expect(manager.getVerificationStatus()).toMatchObject({ state: 'blocked', reason: 'identity-changed' })
    expect(logout).not.toHaveBeenCalled()
    expect(() => manager.acquireLease()).toThrow(/unavailable|blocked/)
  })

  it('rejects runtime identity changes instead of switching accounts', async () => {
    const manager = new OrgAuthManager()
    seedSession(manager, { ...managementSession, expiresAt: Number.MAX_SAFE_INTEGER })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            server_instance_id: 'other-server',
            user: { id: 7, group_id: 2, role: 'member', status: 'active' }
          })
        )
      )
    )
    await expect(manager.verifyOnlineAuthority()).rejects.toThrow(/identity/)
    expect((await manager.getValidSession())?.issuerId).toBe('server')
  })

  it('updates same-identity group changes without global reauthentication', async () => {
    const manager = new OrgAuthManager()
    seedSession(manager, { ...managementSession, expiresAt: Number.MAX_SAFE_INTEGER })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            server_instance_id: 'server',
            user: { id: 7, group_id: 3, role: 'member', status: 'active' }
          })
        )
      )
    )
    await expect(manager.verifyOnlineAuthority()).resolves.toBeUndefined()
    expect((await manager.getValidSession())?.groupId).toBe('3')
    expect(manager.getStatus().generation).toBe(1)
    expect(manager.getVerificationStatus().state).toBe('verified')
  })

  it('publishes only health transitions with an instance owner and monotonically increasing revision', async () => {
    const manager = new OrgAuthManager()
    const other = new OrgAuthManager()
    seedSession(manager, { ...managementSession, expiresAt: Number.MAX_SAFE_INTEGER })
    const states: ReturnType<OrgAuthManager['getVerificationStatus']>[] = []
    const subscription = manager.onVerificationChanged((state) => states.push(state))
    const good = () =>
      new Response(
        JSON.stringify({ server_instance_id: 'server', user: { id: 7, group_id: 2, role: 'member', status: 'active' } })
      )
    const fetcher = vi.fn(async () => good())
    vi.stubGlobal('fetch', fetcher)
    await manager.retryVerification()
    await manager.retryVerification()
    fetcher.mockRejectedValueOnce(new Error('offline'))
    await expect(manager.retryVerification()).rejects.toThrow()
    expect(profileBusinessAccessGate.isAllowed()).toBe(true)
    await manager.retryVerification()
    expect(states.map((state) => state.state)).toEqual(['verified', 'unavailable', 'verified'])
    expect(states.map((state) => state.revision)).toEqual([1, 2, 3])
    expect(new Set(states.map((state) => state.owner)).size).toBe(1)
    expect(states[0].owner).not.toBe(other.getVerificationStatus().owner)
    subscription.dispose()
    manager.dispose()
    other.dispose()
  })

  it('updates role and group in durable authorization without revoking unrelated business access', async () => {
    let persisted: OrgSession | undefined
    let groupId: string | undefined
    const manager = new OrgAuthManager({
      credentialStore: {
        save: async (value: OrgSession) => {
          persisted = value
        }
      } as never,
      profileSession: {
        updateAuthorizationContext: async (_identity: unknown, context: { groupId: string }) => {
          groupId = context.groupId
        }
      } as never
    })
    seedSession(manager, { ...managementSession, expiresAt: Number.MAX_SAFE_INTEGER })
    profileBusinessAccessGate.recordVerificationSuccess()
    const lease = manager.acquireLease()
    let nextContext: { groupId: string | null; role: string | null } | undefined
    manager.onAuthorizationChanged(() => {
      nextContext = manager.getStatus()
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              server_instance_id: 'server',
              user: { id: 7, group_id: 3, role: 'admin', status: 'active' }
            })
          )
      )
    )
    await manager.retryVerification()
    expect(groupId).toBe('3')
    expect(persisted).toMatchObject({ groupId: '3', role: 'admin', accessToken: 'old-access' })
    expect(nextContext).toMatchObject({ groupId: '3', role: 'admin' })
    expect(() => manager.assertLease(lease)).toThrow(/stale/)
    expect(profileBusinessAccessGate.isAllowed()).toBe(true)
  })

  it('discards old currentuser evidence when concurrent token refresh installs newer credentials', async () => {
    const response = deferred<Response>()
    const started = deferred<void>()
    const manager = new OrgAuthManager()
    seedSession(manager, { ...managementSession, expiresAt: Number.MAX_SAFE_INTEGER })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/refresh'))
          return new Response(
            JSON.stringify({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600 })
          )
        started.resolve()
        return response.promise
      })
    )
    const verification = manager.retryVerification()
    const rejected = expect(verification).rejects.toThrow(/superseded/)
    await started.promise
    seedSession(manager, { ...managementSession, expiresAt: 0 })
    await manager.getValidSession()
    response.resolve(
      new Response(
        JSON.stringify({ server_instance_id: 'server', user: { id: 7, group_id: 99, role: 'admin', status: 'active' } })
      )
    )
    await rejected
    expect(await manager.getValidSession()).toMatchObject({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      groupId: '2'
    })
  })

  it('rechecks the credential version inside the write queue before persisting old authority', async () => {
    const user = deferred<Response>()
    const writing = deferred<void>()
    const release = deferred<void>()
    const persisted: OrgSession[] = []
    const manager = new OrgAuthManager({
      credentialStore: {
        save: async (session: OrgSession) => {
          writing.resolve()
          await release.promise
          persisted.push(session)
        }
      } as never
    })
    seedSession(manager, { ...managementSession, expiresAt: Number.MAX_SAFE_INTEGER })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/refresh')
          ? new Response(JSON.stringify({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600 }))
          : user.promise
      )
    )
    const validating = manager.retryVerification()
    const rejected = expect(validating).rejects.toThrow(/version.*stale/i)
    seedSession(manager, { ...managementSession, expiresAt: 0 })
    const refresh = manager.getValidSession()
    await writing.promise
    user.resolve(
      new Response(
        JSON.stringify({ server_instance_id: 'server', user: { id: 7, group_id: 99, role: 'admin', status: 'active' } })
      )
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    release.resolve()
    await refresh
    await rejected
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({ accessToken: 'new-access', groupId: '2' })
    expect(await manager.getValidSession()).toMatchObject({ accessToken: 'new-access', groupId: '2' })
  })

  it('does not block newer credentials on a definitive rejection of a superseded verification snapshot', async () => {
    const rejectedEvidence = deferred<void>()
    vi.spyOn(ProfileAuthBroker.prototype, 'revalidateManagement').mockImplementationOnce(async () => {
      await rejectedEvidence.promise
      throw new VerificationError('Old credential rejected', {
        stage: 'current-user',
        endpoint: '/api/currentuser',
        kind: 'invalid',
        reason: 'credentials-invalid'
      })
    })
    const manager = new OrgAuthManager()
    seedSession(manager, { ...managementSession, expiresAt: Number.MAX_SAFE_INTEGER })
    profileBusinessAccessGate.recordVerificationSuccess()
    const verifying = manager.retryVerification()
    const rejected = expect(verifying).rejects.toMatchObject({ evidence: { kind: 'uncertain' } })
    seedSession(manager, { ...managementSession, expiresAt: 0 })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600 }))
      )
    )
    await manager.getValidSession()
    rejectedEvidence.resolve()
    await rejected
    expect(manager.getVerificationStatus().state).not.toBe('blocked')
    expect(profileBusinessAccessGate.isAllowed()).toBe(true)
    expect(manager.acquireLease()).toMatchObject({ userId: '7' })
  })

  it('does not publish or commit a verification result after disposal', async () => {
    const response = deferred<Response>()
    const manager = new OrgAuthManager()
    seedSession(manager, { ...managementSession, expiresAt: Number.MAX_SAFE_INTEGER })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => response.promise)
    )
    const verification = manager.retryVerification()
    const rejected = expect(verification).rejects.toThrow(/epoch|stale/)
    const before = manager.getVerificationStatus()
    manager.dispose()
    response.resolve(
      new Response(
        JSON.stringify({ server_instance_id: 'server', user: { id: 7, group_id: 99, role: 'admin', status: 'active' } })
      )
    )
    await rejected
    expect(manager.getVerificationStatus()).toEqual(before)
    expect(manager.getStatus().groupId).toBe('2')
  })

  it('retains credentials and startup authority when initialize performs a redundant network recheck offline', async () => {
    authConfig.mode = 'management-oauth'
    const manager = new OrgAuthManager({
      credentialStore: {
        load: async () => ({ ...managementSession, expiresAt: Number.MAX_SAFE_INTEGER }),
        discardQuarantined: async () => undefined
      } as never
    })
    profileBusinessAccessGate.recordVerificationSuccess()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    await expect(manager.initialize()).resolves.toBeUndefined()
    expect(await manager.getValidSession()).toMatchObject({ userId: '7', accessToken: 'old-access' })
    expect(profileBusinessAccessGate.isAllowed()).toBe(true)
    expect(manager.getVerificationStatus().state).toBe('unavailable')
  })

  it('preserves a blocked initialize recheck for the window control plane instead of failing bootstrap', async () => {
    authConfig.mode = 'management-oauth'
    const manager = new OrgAuthManager({
      credentialStore: {
        load: async () => ({ ...managementSession, expiresAt: Number.MAX_SAFE_INTEGER }),
        discardQuarantined: async () => undefined
      } as never
    })
    profileBusinessAccessGate.recordVerificationSuccess()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              server_instance_id: 'other-server',
              user: { id: 7, group_id: 2, role: 'member', status: 'active' }
            })
          )
      )
    )
    await expect(manager.initialize()).resolves.toBeUndefined()
    expect(manager.getVerificationStatus()).toMatchObject({ state: 'blocked', reason: 'identity-changed' })
    expect(() => profileBusinessAccessGate.assertWritable()).toThrow()
    expect(() => manager.acquireLease()).toThrow()
  })

  it('still rejects credential-store failures during initialization', async () => {
    const manager = new OrgAuthManager({
      credentialStore: {
        discardQuarantined: async () => undefined,
        load: async () => {
          throw new Error('disk unavailable')
        }
      } as never
    })
    await expect(manager.initialize()).rejects.toThrow('disk unavailable')
  })

  it.each([
    {},
    { accessToken: '', refreshToken: 'new', expiresIn: 3600 },
    { accessToken: 'new', refreshToken: 'new', expiresIn: '3600' },
    { accessToken: 'new', refreshToken: 'new', expiresIn: -1 }
  ])('does not replace stored credentials with a malformed refresh response: %o', async (body) => {
    const manager = new OrgAuthManager()
    seedSession(manager)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body)))
    )
    expect(await manager.getValidSession()).toMatchObject({ accessToken: 'old-access', refreshToken: 'old-refresh' })
    expect(manager.getVerificationStatus().state).toBe('unavailable')
  })

  it('merges concurrent credential refresh without issuing currentuser recursively', async () => {
    const response = deferred<Response>()
    const fetcher = vi.fn(() => response.promise)
    vi.stubGlobal('fetch', fetcher)
    const manager = new OrgAuthManager()
    seedSession(manager)
    const first = manager.getValidSession()
    const second = manager.getValidSession()
    response.resolve(
      new Response(JSON.stringify({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600 }))
    )
    expect(await first).toMatchObject({ accessToken: 'new-access' })
    expect(await second).toMatchObject({ accessToken: 'new-access' })
    expect(fetcher.mock.calls.length).toBe(1)
  })

  it('never refreshes Bearer credentials for cookie verification', async () => {
    setProfileLaunchContext({
      profileId: 'profile-cookie',
      profileRoot: '/profile-cookie',
      mode: 'business',
      kind: 'authenticated'
    } as never)
    const manager = new OrgAuthManager()
    seedSession(manager, { ...managementSession, authMode: 'management-cookie' })
    cookieSession.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({ server_instance_id: 'server', user: { id: 7, group_id: 2, role: 'member', status: 'active' } })
      )
    )
    const bearer = vi.fn().mockRejectedValue(new Error('Bearer must not be used'))
    vi.stubGlobal('fetch', bearer)
    await manager.retryVerification()
    expect(manager.getVerificationStatus().state).toBe('verified')
    expect(bearer).not.toHaveBeenCalled()
  })

  it('uses a fixed logout cookie snapshot and never sends response cookies to the login partition', async () => {
    setProfileLaunchContext({
      profileId: 'profile-cookie',
      profileRoot: '/profile-cookie',
      mode: 'business',
      kind: 'authenticated'
    } as never)
    const manager = new OrgAuthManager({ credentialStore: { clear: async () => undefined } as never })
    seedSession(manager, { ...managementSession, authMode: 'management-cookie' })
    cookieSession.cookies.get.mockResolvedValue([{ name: 'sid', value: 'old-cookie', path: '/' }])
    cookieSession.cookies.remove.mockResolvedValue(undefined)
    replaceCookies.mockResolvedValue([])
    let sent: RequestInit | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        sent = init
        return new Response('', { headers: { 'set-cookie': 'sid=late-old-cookie' } })
      })
    )
    await manager.logout()
    expect(sent).toMatchObject({ credentials: 'omit', headers: { cookie: 'sid=old-cookie' } })
    expect(cookieSession.fetch).not.toHaveBeenCalled()
    expect(manager.getStatus().phase).toBe('signed-out')
  })

  it('hands local cookie cleanup failure to native recovery once while keeping authority closed', async () => {
    setProfileLaunchContext({
      profileId: 'profile-cookie',
      profileRoot: '/profile-cookie',
      mode: 'business',
      kind: 'authenticated'
    } as never)
    let recoveryStage: string | undefined
    let recoveries = 0
    const manager = new OrgAuthManager({
      credentialStore: {} as never,
      profileSession: {
        beginLogout: async () => undefined,
        logout: async () => {
          throw new Error('unsafe transition must not run')
        }
      } as never,
      onLogoutFailure: (stage) => {
        recoveryStage = stage
        recoveries++
      }
    })
    seedSession(manager, { ...managementSession, authMode: 'management-cookie' })
    profileBusinessAccessGate.recordVerificationSuccess()
    cookieSession.cookies.get.mockResolvedValue([{ name: 'sid', value: 'old-cookie', path: '/' }])
    replaceCookies.mockRejectedValueOnce(new Error('cookie disk unavailable'))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(''))
    )
    const logout = manager.logout()
    await expect(logout).rejects.toThrow('cookie disk unavailable')
    await expect(manager.logout()).rejects.toThrow('cookie disk unavailable')
    expect(recoveryStage).toBe('logout-cookie-cleanup')
    expect(recoveries).toBe(1)
    expect(manager.getVerificationStatus().state).toBe('switching')
    expect(profileBusinessAccessGate.isAllowed()).toBe(false)
    expect(await manager.getValidSession()).toBeNull()
  })

  it('bounds remote logout so offline revocation cannot stall the local durable transition', async () => {
    vi.useFakeTimers()
    try {
      const manager = new OrgAuthManager({ credentialStore: { clear: async () => undefined } as never })
      seedSession(manager)
      vi.spyOn(manager.apiClient, 'revoke').mockImplementation(() => new Promise(() => undefined))
      const logout = manager.logout()
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(logout).resolves.toMatchObject({ state: 'signed-out', revocationWarning: 'Remote logout timed out' })
      expect(await manager.getValidSession()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not restore credentials loaded after logout', async () => {
    const loaded = deferred<OrgSession | null>()
    const loading = deferred<void>()
    const store = {
      discardQuarantined: vi.fn().mockResolvedValue(undefined),
      load: vi.fn(() => {
        loading.resolve()
        return loaded.promise
      }),
      clear: vi.fn().mockResolvedValue(undefined),
      save: vi.fn()
    }
    const manager = new OrgAuthManager({ credentialStore: store as unknown as OrgCredentialStore })
    const initializing = manager.initialize()
    await loading.promise
    await manager.logout()
    loaded.resolve({ ...managementSession, authMode: 'official-direct', accountKind: 'official' })
    await expect(initializing).rejects.toThrow(/stale|epoch/)
    expect(await manager.getValidSession()).toBeNull()
  })

  it('does not revive a session when token refresh finishes after logout', async () => {
    const refreshed = deferred<Response>()
    const manager = new OrgAuthManager()
    seedSession(manager)
    vi.spyOn(manager.apiClient, 'revoke').mockResolvedValue(undefined)
    vi.spyOn(manager.apiClient, 'getCurrentUser').mockResolvedValue({
      server_instance_id: 'server',
      user: { id: 7, group_id: 2, role: 'member', status: 'active' }
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => refreshed.promise)
    )
    const refreshing = manager.getValidSession()
    await manager.logout()
    refreshed.resolve(new Response(JSON.stringify({ accessToken: 'late', refreshToken: 'late', expiresIn: 3600 })))
    await expect(refreshing).resolves.toBeNull()
    expect(manager.getStatus().phase).toBe('signed-out')
  })

  it('rejects authority validation that finishes after logout without saving it', async () => {
    const response = deferred<{
      server_instance_id: string
      user: { id: number; group_id: number; role: string; status: string }
    }>()
    const save = vi.fn()
    const store = { save, clear: vi.fn().mockResolvedValue(undefined) }
    const manager = new OrgAuthManager({ credentialStore: store as unknown as OrgCredentialStore })
    seedSession(manager, { ...managementSession, expiresAt: Number.MAX_SAFE_INTEGER })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(await response.promise)))
    )
    vi.spyOn(manager.apiClient, 'revoke').mockResolvedValue(undefined)
    const validation = manager.revalidateAuthority()
    const rejected = expect(validation).rejects.toThrow(/stale|epoch/)
    await manager.logout()
    response.resolve({ server_instance_id: 'server', user: { id: 7, group_id: 2, role: 'member', status: 'active' } })
    await rejected
    expect(await manager.getValidSession()).toBeNull()
    expect(save).not.toHaveBeenCalled()
  })

  it.each([false, true])('clears credentials after an in-flight save (write fails: %s)', async (writeFails) => {
    const writing = deferred<void>()
    const release = deferred<void>()
    let persisted: OrgSession | null = null
    const store = {
      save: vi.fn(async (session: OrgSession) => {
        writing.resolve()
        await release.promise
        persisted = session
        if (writeFails) throw new Error('durability failed after write')
      }),
      clear: vi.fn(async () => {
        persisted = null
      })
    }
    const manager = new OrgAuthManager({ credentialStore: store as unknown as OrgCredentialStore })
    seedSession(manager, { ...managementSession, expiresAt: Number.MAX_SAFE_INTEGER })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              server_instance_id: 'server',
              user: { id: 7, group_id: 2, role: 'member', status: 'active' }
            })
          )
      )
    )
    vi.spyOn(manager.apiClient, 'revoke').mockResolvedValue(undefined)
    const validating = manager.revalidateAuthority()
    const outcome = validating.catch((error: unknown) => error)
    await writing.promise
    const logout = manager.logout()
    release.resolve()
    await logout
    await outcome
    expect(persisted).toBeNull()
    expect(await manager.getValidSession()).toBeNull()
    expect(await outcome).toBeInstanceOf(Error)
  })

  it('does not publish login after its credential save is overtaken by logout', async () => {
    const writing = deferred<void>()
    const release = deferred<void>()
    let persisted: OrgSession | null = null
    const store = {
      save: vi.fn(async (session: OrgSession) => {
        writing.resolve()
        await release.promise
        persisted = session
      }),
      clear: vi.fn(async () => {
        persisted = null
      })
    }
    const manager = new OrgAuthManager({ credentialStore: store as unknown as OrgCredentialStore })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 200,
            data: { userId: 7, userNickname: 'Alice' }
          })
        )
      )
    )
    await manager.startLogin()
    const callback = manager.handleAuthCallback(new URL('meacowork://auth/sso/callback?token=old'))
    const rejected = expect(callback).rejects.toThrow(/stale|epoch/)
    await writing.promise
    const logout = manager.logout()
    release.resolve()
    await logout
    await rejected
    expect(persisted).toBeNull()
    expect(await manager.getValidSession()).toBeNull()
    expect(manager.getStatus().phase).toBe('signed-out')
  })

  it('does not install OAuth tokens returned after logout', async () => {
    authConfig.mode = 'management-oauth'
    const response = deferred<Response>()
    const manager = new OrgAuthManager()
    const { authorizationUrl } = await manager.startLogin()
    const state = new URL(authorizationUrl).searchParams.get('state')!
    vi.stubGlobal(
      'fetch',
      vi.fn(() => response.promise)
    )
    const callback = manager.handleAuthCallback(new URL(`meacowork://auth/callback?code=old&state=${state}`))
    const rejected = expect(callback).rejects.toThrow(/stale|epoch/)
    await manager.logout()
    response.resolve(
      new Response(
        JSON.stringify({
          access_token: 'late',
          refresh_token: 'late',
          expires_in: 3600,
          user: { id: 7 }
        })
      )
    )
    await rejected
    expect(await manager.getValidSession()).toBeNull()
  })

  it('keeps a new login pending when an older callback fails after logout', async () => {
    const response = deferred<Response>()
    const manager = new OrgAuthManager()
    await manager.startLogin()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => response.promise)
    )
    const callback = manager.handleAuthCallback(new URL('meacowork://auth/sso/callback?token=old'))
    const rejected = expect(callback).rejects.toThrow()
    await manager.logout()
    await manager.startLogin()
    response.resolve(new Response('{}', { status: 401 }))
    await rejected
    expect(manager.getStatus().phase).toBe('authorizing')
  })

  // copy 模式下，登出只结束目录访问会话，不改变已复制到本地的资源状态。
  it('logout 不改变已安装资源的可用性', async () => {
    const mgr = new OrgAuthManager()
    await mgr.logout()
    expect(stateStoreMock.markUnavailable).not.toHaveBeenCalled()
    expect(stateStoreMock.markAvailable).not.toHaveBeenCalled()
  })

  it('登录成功不改变已安装资源的可用性', async () => {
    const mgr = new OrgAuthManager()
    // 走私有路径太绕：直接验证 doFinishLogin 逻辑不可行，改用 fetch mock 走完整回调
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          code: 200,
          data: { userId: 1000272, userPhone: '13900000000', userNickname: 'test999' }
        })
    })
    globalThis.fetch = fetchMock as never

    // 注入 pending（模拟 startLogin 后收到回调）
    ;(mgr as unknown as { pending: unknown }).pending = { createdAt: Date.now(), generation: 0 }

    const url = new URL('meacowork://auth/sso/callback?token=official-token')
    await mgr.handleAuthCallback(url)

    expect(stateStoreMock.markAvailable).not.toHaveBeenCalled()
    expect(stateStoreMock.markUnavailable).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/xlyApi/business/user/userInfo'),
      expect.objectContaining({ headers: { authorization: 'Bearer official-token' } })
    )
    expect(mgr.getStatus()).toMatchObject({
      phase: 'signed-in',
      displayName: 'test999'
    })
  })

  it('treats an activated transition as success instead of a relaunch', async () => {
    authConfig.mode = 'management-oauth'
    const profileSession = {
      beginLogout: vi.fn(),
      logout: vi.fn(),
      completeAuthentication: vi.fn().mockResolvedValue({ kind: 'activated', record: {} })
    }
    const manager = new OrgAuthManager({
      credentialStore: { clear: vi.fn() } as never,
      profileSession: profileSession as never
    })
    seedSession(manager)
    const completed = {
      session: managementSession,
      identity: { kind: 'authenticated' },
      authorizationContext: {},
      prepareTargetSession: async () => undefined
    } as never
    vi.spyOn(
      manager as unknown as { exchangeAndValidate: (...args: unknown[]) => Promise<typeof completed> },
      'exchangeAndValidate'
    ).mockResolvedValue(completed)
    ;(manager as unknown as { pending: unknown }).pending = {
      createdAt: Date.now(),
      generation: manager['generation'],
      state: 'y'
    }

    await manager.handleAuthCallback(new URL('meacowork://auth/callback?code=x&state=y'))

    expect(profileSession.completeAuthentication).toHaveBeenCalled()
    expect(manager['switching']).toBe(false)
    expect(manager.getStatus().phase).toBe('signed-in')
  })
})
