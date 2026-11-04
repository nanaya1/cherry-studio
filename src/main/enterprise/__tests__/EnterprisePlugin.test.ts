import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { OrgVerificationStatus } from '../OrgAuthManager'

vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  const mock = mockApplicationFactory()
  Object.assign(mock.application, { prepareProfileSwitch: vi.fn(async () => ({ clean: true })) })
  return mock
})

// Avoid loading business startup and native SQLite through the profiles barrel.
vi.mock('@main/core/profiles', async () => ({
  ...(await import('../../core/profiles/ProfileRuntimeContext')),
  ...(await import('../../core/profiles/ProfilePaths')),
  ...(await import('../../core/profiles/ProfileRegistry')),
  ...(await import('../../core/profiles/ProfileActivePointer')),
  ...(await import('../../core/profiles/ProfileSwitchJournal')),
  ...(await import('../../core/profiles/ProfileSessionService')),
  ...(await import('../../core/profiles/ProfileInstallation')),
  ...(await import('../../core/profiles/ProfileClaimService')),
  ...(await import('../../core/profiles/ProfileSwitchCoordinator')),
  ...(await import('../../core/profiles/SwitchFence')),
  closeProfileBootstrapWindows: vi.fn(),
  confirmProfileClaim: vi.fn(),
  createProfileBootstrapWindow: vi.fn()
}))

vi.mock('../OrgAuthManager', async () => {
  const { Emitter } = await import('@main/core/lifecycle')
  return {
    OrgAuthManager: class {
      private verificationChanged = new Emitter<OrgVerificationStatus>()
      private authorizationChanged = new Emitter<void>()
      private status: OrgVerificationStatus = { owner: 'profile:auth', revision: 0, state: 'unknown' }
      disposed = false

      onVerificationChanged(listener: (status: OrgVerificationStatus) => void) {
        return this.verificationChanged.event(listener)
      }

      onAuthorizationChanged(listener: () => void) {
        return this.authorizationChanged.event(listener)
      }

      async initialize() {
        this.setVerification('verified')
      }

      async verifyOnlineAuthority() {}

      setVerification(state: OrgVerificationStatus['state'], reason?: OrgVerificationStatus['reason']) {
        if (this.status.state === state && this.status.reason === reason) return
        this.status = {
          owner: this.status.owner,
          revision: this.status.revision + 1,
          state,
          ...(reason ? { reason } : {})
        }
        this.verificationChanged.fire({ ...this.status })
      }

      changeAuthorization() {
        this.authorizationChanged.fire()
      }

      dispose() {
        this.disposed = true
        this.verificationChanged.dispose()
        this.authorizationChanged.dispose()
      }
    }
  }
})

vi.mock('../OrgCredentialStore', () => ({ OrgCredentialStore: class {} }))
vi.mock('../OrgSkillCatalog', () => ({
  OrgSkillCatalog: class {
    migrateLegacyCopies() {
      return 0
    }
  }
}))
vi.mock('../OrgMcpCatalog', () => ({
  OrgMcpCatalog: class {
    migrateLegacyCopies() {
      return 0
    }
  }
}))
vi.mock('../OrgKnowledgeService', () => ({
  OrgKnowledgeService: class {
    available = false
    authorizationCache = new Map<string, string>()

    initialize() {
      this.available = true
    }

    invalidateAuthorizationContext() {
      this.authorizationCache.clear()
    }

    dispose() {
      this.available = false
    }
  }
}))

import { application } from '@application'
import { BaseService } from '@main/core/lifecycle'
import { WindowType } from '@main/core/window/types'

import {
  getProfileLaunchContext,
  profileBusinessAccessGate,
  setProfileLaunchContext
} from '../../core/profiles/ProfileRuntimeContext'
import { profileSwitchFence } from '../../core/profiles/SwitchFence'
import { EnterprisePlugin } from '../EnterprisePlugin'

type AuthHarness = {
  disposed: boolean
  setVerification(state: OrgVerificationStatus['state'], reason?: OrgVerificationStatus['reason']): void
  changeAuthorization(): void
}

type KnowledgeHarness = {
  available: boolean
  authorizationCache: Map<string, string>
}

function runningWork() {
  const controller = new AbortController()
  let status = 'running'
  const finished = new Promise<string>((resolve) => {
    controller.signal.addEventListener(
      'abort',
      () => {
        status = 'cancelled'
        resolve(status)
      },
      { once: true }
    )
  })
  return {
    controller,
    finished,
    get status() {
      return status
    }
  }
}

describe('EnterprisePlugin account verification lifecycle', () => {
  let plugin: EnterprisePlugin
  let auth: AuthHarness
  let knowledge: KnowledgeHarness
  let work: ReturnType<typeof runningWork>[]
  let window: { isDestroyed(): boolean }
  let hostAlive: boolean
  let rendererEvents: Array<{ event: string; payload: unknown }>

  beforeEach(async () => {
    vi.useFakeTimers()
    BaseService.resetInstances()
    profileSwitchFence.resetForTesting()
    setProfileLaunchContext(undefined)
    work = Array.from({ length: 5 }, () => runningWork())
    hostAlive = true
    let windowDestroyed = false
    window = { isDestroyed: () => windowDestroyed }
    rendererEvents = []

    const stopHost = () => {
      hostAlive = false
      windowDestroyed = true
    }
    vi.spyOn(application, 'forceExit').mockImplementation(stopHost)
    vi.spyOn(application, 'relaunch').mockImplementation(stopHost)
    vi.spyOn(application, 'quit').mockImplementation(stopHost)
    vi.spyOn(application, 'shutdown').mockImplementation(async () => {
      stopHost()
    })
    vi.spyOn(application, 'prepareProfileSwitch').mockImplementation(async () => {
      stopHost()
      return { clean: true } as never
    })
    const windows = application.get('WindowManager')
    vi.spyOn(windows, 'getWindowsByType').mockImplementation(
      (type) => (type === WindowType.Main && !windowDestroyed ? [window] : []) as never
    )
    vi.spyOn(windows, 'close').mockImplementation(() => {
      windowDestroyed = true
      return true
    })
    vi.spyOn(application.get('IpcApiService'), 'broadcast').mockImplementation((event, payload) => {
      if (!window.isDestroyed()) rendererEvents.push({ event, payload })
    })

    const jobs = application.getExisting('JobManager')!
    const services: Record<string, unknown> = {
      JobManager: {
        ...jobs,
        cancelMany: async (filter: { type: string }, reason: string) => {
          if (filter.type === 'agent.task') work[0].controller.abort(reason)
        }
      },
      AiStreamManager: { cancelActiveWork: async (reason: string) => work[1].controller.abort(reason) },
      AgentSessionRuntimeService: { cancelActiveWork: async (reason: string) => work[2].controller.abort(reason) },
      McpRuntimeService: { abortActiveToolCalls: () => work[3].controller.abort() }
    }
    vi.spyOn(application, 'get').mockImplementation(
      ((name: string) => services[name] ?? application.getExisting(name as never)) as typeof application.get
    )

    plugin = new EnterprisePlugin()
    auth = plugin.auth as unknown as AuthHarness
    knowledge = plugin.knowledge as unknown as KnowledgeHarness
    setProfileLaunchContext({
      mode: 'business',
      kind: 'authenticated',
      profileId: 'a'.repeat(32),
      identityDigest: 'identity',
      dataRoot: '/enterprise',
      profileRoot: '/enterprise/profiles/account'
    })
    profileBusinessAccessGate.recordVerificationSuccess()
    await plugin._doInit()
  })

  afterEach(async () => {
    await plugin?._doDestroy()
    for (const task of work ?? []) task.controller.abort()
    vi.useRealTimers()
    vi.restoreAllMocks()
    profileSwitchFence.resetForTesting()
    setProfileLaunchContext(undefined)
    BaseService.resetInstances()
  })

  function expectHostAvailable() {
    expect(hostAlive).toBe(true)
    expect(application.isReady()).toBe(true)
    expect(application.get('WindowManager').getWindowsByType(WindowType.Main)).toEqual([window])
    expect(window.isDestroyed()).toBe(false)
    expect(plugin.isReady).toBe(true)
    expect(auth.disposed).toBe(false)
    expect(knowledge.available).toBe(true)
    expect(profileSwitchFence.state).toEqual({ kind: 'open' })
    expect(application.prepareProfileSwitch).not.toHaveBeenCalled()
    expect(application.forceExit).not.toHaveBeenCalled()
    expect(application.relaunch).not.toHaveBeenCalled()
  }

  // Catches missing event wiring and the old monitor-triggered profile teardown.
  it('broadcasts revocation and cancels in-flight execution without closing the live host', async () => {
    expect(rendererEvents).toEqual([
      {
        event: 'enterprise.verification_changed',
        payload: { owner: 'profile:auth', revision: 1, state: 'verified' }
      }
    ])
    profileBusinessAccessGate.recordVerificationFailure('account-disabled')
    auth.setVerification('blocked', 'account-disabled')

    await expect(Promise.all(work.slice(0, 4).map((task) => task.finished))).resolves.toEqual([
      'cancelled',
      'cancelled',
      'cancelled',
      'cancelled'
    ])
    expect(work.slice(0, 3).map((task) => task.controller.signal.reason)).toEqual(
      Array(3).fill('Account authorization is no longer valid')
    )
    expect(work[4].status).toBe('running')
    expect(rendererEvents.at(-1)).toEqual({
      event: 'enterprise.verification_changed',
      payload: { owner: 'profile:auth', revision: 2, state: 'blocked', reason: 'account-disabled' }
    })
    await vi.advanceTimersByTimeAsync(65_000)

    expect(profileBusinessAccessGate.isAllowed()).toBe(false)
    expect(getProfileLaunchContext()?.mode).toBe('business')
    expectHostAvailable()
  })

  // Catches one failing cancellation boundary leaving other execution running.
  it('still cancels other execution and preserves recovery UI if one cancellation fails', async () => {
    vi.spyOn(application.get('AiStreamManager'), 'cancelActiveWork').mockRejectedValue(new Error('stream unavailable'))
    profileBusinessAccessGate.recordVerificationFailure('credentials-invalid')
    auth.setVerification('blocked', 'credentials-invalid')

    await expect(Promise.all([work[0].finished, work[2].finished, work[3].finished])).resolves.toEqual([
      'cancelled',
      'cancelled',
      'cancelled'
    ])
    expect(work[1].status).toBe('running')
    expect(rendererEvents.at(-1)?.payload).toMatchObject({ state: 'blocked' })
    await vi.advanceTimersByTimeAsync(1_000)
    expectHostAvailable()
  })

  // Catches treating transient verification health or duplicate success as revocation.
  it('keeps active work and knowledge context through unavailable and unchanged verification', async () => {
    knowledge.authorizationCache.set('catalog', 'permitted')
    auth.setVerification('verified')
    expect(rendererEvents).toHaveLength(1)
    auth.setVerification('unavailable')
    await vi.advanceTimersByTimeAsync(250)
    auth.setVerification('verified')
    await vi.advanceTimersByTimeAsync(250)

    expect(work.map((task) => task.status)).toEqual(Array(5).fill('running'))
    expect(knowledge.authorizationCache.get('catalog')).toBe('permitted')
    expect(profileBusinessAccessGate.isAllowed()).toBe(true)
    expect(rendererEvents.map(({ payload }) => (payload as OrgVerificationStatus).state)).toEqual([
      'verified',
      'unavailable',
      'verified'
    ])
    expectHostAvailable()
  })

  // Catches authorization changes leaving stale knowledge access or stopping unrelated execution.
  it('invalidates only knowledge authorization and removes event wiring on lifecycle disposal', async () => {
    knowledge.authorizationCache.set('catalog', 'old-role')
    auth.changeAuthorization()
    await vi.advanceTimersByTimeAsync(250)

    expect(knowledge.authorizationCache.size).toBe(0)
    expect(work.map((task) => task.status)).toEqual(Array(5).fill('running'))
    expect(rendererEvents).toHaveLength(1)
    expectHostAvailable()

    await plugin._doDestroy()
    knowledge.authorizationCache.set('catalog', 'new-lifecycle')
    auth.changeAuthorization()
    auth.setVerification('blocked', 'credentials-invalid')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(knowledge.authorizationCache.get('catalog')).toBe('new-lifecycle')
    expect(rendererEvents).toHaveLength(1)
    expect(work.map((task) => task.status)).toEqual(Array(5).fill('running'))
    expect(auth.disposed).toBe(true)
    expect(plugin.isDestroyed).toBe(true)
  })
})
