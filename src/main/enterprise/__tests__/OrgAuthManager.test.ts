/**
 * [enterprise] C3 OrgAuthManager 登出/重登的 org 资源状态标记测试
 * logout → orgStateStore.markUnavailable；登录成功 → markAvailable。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { stateStoreMock, authConfig } = vi.hoisted(() => ({
  authConfig: { mode: 'official-direct' },
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

vi.mock('@application', () => ({
  application: {
    get: vi.fn().mockReturnValue({ broadcast: vi.fn() })
  }
}))

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
  const actual = await importOriginal<typeof import('../OrgApiClient')>()
  return {
    ...actual,
    get ORG_AUTH_MODE() {
      return authConfig.mode
    },
    ORG_SERVER_BASE_URL: 'https://management.example'
  }
})

import { OrgAuthManager } from '@main/enterprise/OrgAuthManager'

import type { OrgCredentialStore, OrgSession } from '../OrgCredentialStore'

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

  it('signs out when refresh returns 401', async () => {
    const manager = new OrgAuthManager()
    seedSession(manager)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })))
    await expect(manager.getValidSession()).resolves.toBeNull()
    expect(manager.getStatus().phase).toBe('signed-out')
  })

  it('signs out when refresh explicitly reports a revoked token', async () => {
    const manager = new OrgAuthManager()
    seedSession(manager)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('refresh token revoked')))
    await expect(manager.getValidSession()).resolves.toBeNull()
    expect(manager.getStatus().phase).toBe('signed-out')
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

  it('rejects runtime authorization changes without overwriting the stored context', async () => {
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
    await expect(manager.verifyOnlineAuthority()).rejects.toThrow(/authorization/)
    expect((await manager.getValidSession())?.groupId).toBe('2')
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
    vi.spyOn(manager.apiClient, 'getCurrentUser').mockReturnValue(response.promise)
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
    vi.spyOn(manager.apiClient, 'getCurrentUser').mockResolvedValue({
      server_instance_id: 'server',
      user: { id: 7, group_id: 2, role: 'member', status: 'active' }
    })
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
