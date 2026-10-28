/**
 * Shutdown-path tests for the composition root.
 *
 * These live here rather than in LifecycleManager.test.ts because the
 * force-exit fuse is NOT part of shutdown() — it is armed by the `will-quit`
 * handler (and by the signal handlers) around it. Proving that a stuck service
 * no longer costs the process a `process.exit(1)` therefore has to start from
 * that handler, with a real LifecycleManager underneath.
 */

import { mockMainLoggerService } from '@test-mocks/MainLoggerService'
import { app, dialog } from 'electron'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

import { bootConfigService } from '@main/data/bootConfig'

import { BaseService } from '../../lifecycle/BaseService'
import { SERVICE_STOP_TIMEOUT_MS, SHUTDOWN_TIMEOUT_MS } from '../../lifecycle/constants'
import { DependsOn, Injectable } from '../../lifecycle/decorators'
import { LifecycleManager } from '../../lifecycle/LifecycleManager'
import { ServiceContainer } from '../../lifecycle/ServiceContainer'
import { Phase, ServiceInitError } from '../../lifecycle/types'
import { profileSwitchFence } from '../../profiles/SwitchFence'
import { Application } from '../Application'

// The `@application` alias resolves to Application.ts, so the global
// vi.mock('@application') in tests/main.setup.ts would otherwise hand back the
// stub singleton instead of the real class under test.
vi.unmock('@application')

/**
 * Reset the Application singleton between cases.
 *
 * `Application` has no reset API and `isShuttingDown` is one-way: once true,
 * `shutdown()` early-returns forever, so a second scenario would silently not
 * run at all. The private static is cleared directly — same escape hatch the
 * lifecycle tests use for `manager['container']`.
 */
function resetApplication(): void {
  LifecycleManager.reset()
  ServiceContainer.reset()
  BaseService.resetInstances()
  ;(Application as unknown as { instance: Application | null }).instance = null
}

/** The `will-quit` listener Application registered, as Electron would call it. */
type QuitListener = (event: { preventDefault: () => void }) => void

describe('Application shutdown', () => {
  let exitSpy: MockInstance<typeof process.exit>
  let appOn: ReturnType<typeof vi.fn>
  let appExit: ReturnType<typeof vi.fn>

  beforeEach(() => {
    resetApplication()
    profileSwitchFence.resetForTesting()
    vi.useFakeTimers()

    // Extend (not replace) the global electron mock: it ships `getPath` and
    // friends but no `on` / `exit` / `quit`, and we need to capture the
    // listeners Application registers.
    appOn = vi.fn()
    appExit = vi.fn()
    Object.assign(app, { on: appOn, exit: appExit, quit: vi.fn(), whenReady: vi.fn() })
    Object.assign(dialog, { showMessageBox: vi.fn() })

    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    vi.spyOn(bootConfigService, 'flush').mockImplementation(() => {})
    vi.spyOn(mockMainLoggerService, 'finish').mockImplementation(() => {})
    mockMainLoggerService.info.mockClear()
    mockMainLoggerService.warn.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    resetApplication()
  })

  /** Messages a mocked logger level received, for `stringContaining` matching. */
  const messages = (level: 'info' | 'warn'): string[] =>
    mockMainLoggerService[level].mock.calls.map((call) => String(call[0]))

  /** An onStop that never settles — the framework has to abandon it. */
  const neverSettles = (): Promise<void> => new Promise<void>(() => {})

  /**
   * Arm the quit handlers, initialize the registered services, and drive the
   * `will-quit` path to completion.
   *
   * The handler is not async — it `preventDefault()`s and kicks off a promise
   * chain — so completion is observed through `app.exit`, which its `.finally`
   * calls. Draining the fake timer queue covers both the per-service ceilings
   * and the force-exit fuse: if the fuse were still armed and due, it would
   * fire here.
   */
  async function runWillQuit(application: Application): Promise<void> {
    application['setupQuitHandlers']()
    await application.getLifecycleManager().startPhase(Phase.WhenReady)

    const willQuit = appOn.mock.calls.find(([event]) => event === 'will-quit')?.[1] as QuitListener
    expect(willQuit).toBeTypeOf('function')

    const preventDefault = vi.fn()
    willQuit({ preventDefault })
    expect(preventDefault).toHaveBeenCalled()

    await vi.runAllTimersAsync()
  }

  it('restarts silently after logout destroys windows but AI stop fails', async () => {
    let windowsDestroyed = false
    @Injectable('LogoutWindowOwner')
    class LogoutWindowOwner extends BaseService {
      protected override onDestroy(): void {
        windowsDestroyed = true
      }
    }
    @Injectable('LogoutAiWorker')
    class LogoutAiWorker extends BaseService {
      protected override async onStop(): Promise<void> {
        throw new Error('AI process did not exit')
      }
    }
    const application = Application.getInstance()
    application.getContainer().register(LogoutWindowOwner)
    application.getContainer().register(LogoutAiWorker)
    await application.getLifecycleManager().startPhase(Phase.WhenReady)
    const relaunch = vi.spyOn(application, 'relaunch').mockImplementation(() => {})
    vi.spyOn(application, 'forceExit').mockImplementation(() => {})

    const result = await application.prepareProfileLogout()

    expect(windowsDestroyed).toBe(true)
    expect(result.clean).toBe(false)
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    expect(relaunch).toHaveBeenCalledOnce()
    expect(() => application.prepareProfileRuntime()).toThrow()
  })

  it('does not mistake a concurrent logout for a teardown failure', async () => {
    const application = Application.getInstance()
    let release!: () => void
    vi.spyOn(profileSwitchFence, 'drainTasks').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const first = application.prepareProfileLogout()
    await expect(application.prepareProfileLogout()).rejects.toThrow('already shutting down')
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    release()
    expect((await first).clean).toBe(true)
  })

  it('force-exits if silent logout recovery cannot schedule a relaunch', async () => {
    const application = Application.getInstance()
    vi.spyOn(profileSwitchFence, 'drainTasks').mockRejectedValue(new Error('AI task'))
    const relaunch = vi.spyOn(application, 'relaunch').mockImplementation(() => {
      throw new Error('relaunch failed')
    })
    const forceExit = vi.spyOn(application, 'forceExit').mockImplementation(() => {})

    await expect(application.prepareProfileLogout()).rejects.toThrow('AI task')

    expect(relaunch).toHaveBeenCalledOnce()
    expect(forceExit).toHaveBeenCalledWith(1)
  })

  it('offers recovery when logout task draining throws before teardown', async () => {
    const application = Application.getInstance()
    vi.spyOn(profileSwitchFence, 'drainTasks').mockRejectedValue(new Error('in-flight AI task'))
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false })
    const relaunch = vi.spyOn(application, 'relaunch').mockImplementation(() => {})

    await expect(application.prepareProfileLogout()).rejects.toThrow('in-flight AI task')

    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    expect(relaunch).toHaveBeenCalledOnce()
    expect(() => application.prepareProfileRuntime()).toThrow()
  })

  it('should not force-exit when a single service times out, and still stop the rest', async () => {
    const stopped: string[] = []

    @Injectable('TailService')
    class TailService extends BaseService {
      protected override onStop() {
        stopped.push('Tail')
      }
    }

    @Injectable('StuckService')
    @DependsOn(['TailService'])
    class StuckService extends BaseService {
      protected override onStop() {
        return neverSettles()
      }
    }

    const application = Application.getInstance()
    ServiceContainer.getInstance().register(TailService)
    ServiceContainer.getInstance().register(StuckService)

    await runWillQuit(application)

    expect(exitSpy).not.toHaveBeenCalled()
    expect(appExit).toHaveBeenCalledWith(0)
    expect(stopped).toEqual(['Tail'])
    expect(messages('warn')).toContainEqual(expect.stringContaining('Shutdown complete, but not cleanly'))
  })

  it('should not force-exit when three services time out', async () => {
    const stopped: string[] = []

    @Injectable('TailService')
    class TailService extends BaseService {
      protected override onStop() {
        stopped.push('Tail')
      }
    }

    @Injectable('StuckOneService')
    @DependsOn(['TailService'])
    class StuckOneService extends BaseService {
      protected override onStop() {
        return neverSettles()
      }
    }

    @Injectable('StuckTwoService')
    @DependsOn(['StuckOneService'])
    class StuckTwoService extends BaseService {
      protected override onStop() {
        return neverSettles()
      }
    }

    @Injectable('StuckThreeService')
    @DependsOn(['StuckTwoService'])
    class StuckThreeService extends BaseService {
      protected override onStop() {
        return neverSettles()
      }
    }

    const application = Application.getInstance()
    const container = ServiceContainer.getInstance()
    container.register(TailService)
    container.register(StuckOneService)
    container.register(StuckTwoService)
    container.register(StuckThreeService)

    await runWillQuit(application)

    // Three services burning their full ceiling still fit inside the fuse.
    expect(exitSpy).not.toHaveBeenCalled()
    expect(appExit).toHaveBeenCalledWith(0)
    expect(stopped).toEqual(['Tail'])
  })

  it('should still fall back to the fuse once enough services exhaust their ceilings', async () => {
    // Positive control for the two cases above: the fuse is not dead code, it is
    // just no longer what ends a normal quit. One more stuck service than the
    // budget can hold is the documented boundary, not a regression.
    const stuckCount = Math.ceil(SHUTDOWN_TIMEOUT_MS / SERVICE_STOP_TIMEOUT_MS) + 1
    const container = ServiceContainer.getInstance()
    for (let i = 0; i < stuckCount; i++) {
      const StuckService = class extends BaseService {
        protected override onStop(): Promise<void> {
          return neverSettles()
        }
      }
      Injectable(`Stuck${i}Service`)(StuckService)
      container.register(StuckService)
    }

    await runWillQuit(Application.getInstance())

    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('tears down partially initialized services before relaunching after a fatal init failure', async () => {
    const order: string[] = []
    const application = Application.getInstance()
    const manager = application.getLifecycleManager()
    vi.spyOn(app, 'whenReady').mockResolvedValue(undefined)
    vi.spyOn(dialog, 'showMessageBox').mockResolvedValue({ response: 1, checkboxChecked: false })
    vi.spyOn(manager, 'stopAll').mockImplementation(async () => {
      order.push('stop')
      return { timedOut: [], failed: [] }
    })
    vi.spyOn(manager, 'destroyAll').mockImplementation(async () => {
      order.push('destroy')
      return { timedOut: [], failed: [] }
    })
    vi.spyOn(application, 'relaunch').mockImplementation(() => {
      order.push('relaunch')
    })

    await application['handleFatalServiceError'](new ServiceInitError('DbService', new Error('init failed')))

    expect(order).toEqual(['stop', 'destroy', 'relaunch'])
  })

  it('reports an unsuccessful bootstrap after a fatal init failure was handled', async () => {
    const application = Application.getInstance()
    const manager = application.getLifecycleManager()
    application.__setPathMapForTesting({} as never)
    vi.spyOn(app, 'whenReady').mockResolvedValue(undefined)
    vi.spyOn(dialog, 'showMessageBox').mockResolvedValue({ response: 1, checkboxChecked: false })
    vi.spyOn(manager, 'startPhase').mockRejectedValueOnce(new ServiceInitError('DbService', new Error('init failed')))
    vi.spyOn(manager, 'stopAll').mockResolvedValue({ timedOut: [], failed: [] })
    vi.spyOn(manager, 'destroyAll').mockResolvedValue({ timedOut: [], failed: [] })
    vi.spyOn(application, 'relaunch').mockImplementation(() => {})

    await expect(application.bootstrap()).resolves.toBe(false)
  })

  it('returns structured teardown failures for a profile switch without finishing the logger', async () => {
    const application = Application.getInstance()
    const manager = application.getLifecycleManager()
    vi.spyOn(manager, 'stopAll').mockResolvedValue({ timedOut: ['JobManager'], failed: ['McpRuntimeService'] })
    vi.spyOn(manager, 'destroyAll').mockResolvedValue({ timedOut: [], failed: ['DbService'] })

    const result = await application.prepareProfileSwitch()

    expect(result).toEqual({
      clean: false,
      stop: { timedOut: ['JobManager'], failed: ['McpRuntimeService'] },
      destroy: { timedOut: [], failed: ['DbService'] }
    })
    expect(mockMainLoggerService.finish).not.toHaveBeenCalled()
  })

  it('allows login after logout to reuse the clean teardown without stopping services twice', async () => {
    const application = Application.getInstance()
    const manager = application.getLifecycleManager()
    const stop = vi.spyOn(manager, 'stopAll').mockResolvedValue({ timedOut: [], failed: [] })
    vi.spyOn(manager, 'destroyAll').mockResolvedValue({ timedOut: [], failed: [] })
    const result = await application.prepareProfileLogout()
    application.finishProfileLogout()
    await expect(application.prepareProfileSwitch()).resolves.toEqual(result)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(appExit).not.toHaveBeenCalled()
  })

  it('waits for old IPC work before stopping profile services', async () => {
    const application = Application.getInstance()
    const order: string[] = []
    let finish!: () => void
    const work = profileSwitchFence.runTask(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const manager = application.getLifecycleManager()
    vi.spyOn(manager, 'stopAll').mockImplementation(async () => {
      order.push('stop')
      return { timedOut: [], failed: [] }
    })
    vi.spyOn(manager, 'destroyAll').mockResolvedValue({ timedOut: [], failed: [] })
    profileSwitchFence.beginSwitch('logout')
    const teardown = application.prepareProfileSwitch()
    await Promise.resolve()
    expect(order).toEqual([])
    finish()
    await work
    await expect(teardown).resolves.toMatchObject({ clean: true })
    expect(order).toEqual(['stop'])
  })

  it('blocks runtime rebuild when old IPC cannot finish within the shutdown budget', async () => {
    const application = Application.getInstance()
    let finish!: () => void
    const work = profileSwitchFence.runTask(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    profileSwitchFence.beginSwitch('logout')
    const teardown = application.prepareProfileSwitch()
    const rejected = expect(teardown).rejects.toThrow(/in-flight/i)
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS)
    await rejected
    expect(() => application.prepareProfileRuntime()).toThrow(/not clean/)
    finish()
    await work
  })

  it('rejects runtime rebuild after a background stop times out, even when the work later finishes', async () => {
    let finish!: () => void
    let stopping = false
    let destroyed = false
    @Injectable('BackgroundBackupService')
    class BackgroundBackupService extends BaseService {
      protected override onStop(): Promise<void> {
        stopping = true
        return new Promise<void>((resolve) => {
          finish = resolve
        })
      }
      protected override onDestroy(): void {
        destroyed = true
      }
    }
    const application = Application.getInstance()
    const container = ServiceContainer.getInstance()
    container.register(BackgroundBackupService)
    await application.getLifecycleManager().startPhase(Phase.WhenReady)
    const service = container.get(BackgroundBackupService)
    const teardown = application.prepareProfileSwitch()
    await vi.advanceTimersByTimeAsync(SERVICE_STOP_TIMEOUT_MS)
    const result = await teardown
    expect(stopping).toBe(true)
    expect(result.clean).toBe(false)
    expect(result.stop.timedOut).toContain('BackgroundBackupService')
    expect(destroyed).toBe(false)
    expect(() => application.prepareProfileRuntime()).toThrow(/not clean/)
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(service.isStopped).toBe(true)
    expect(() => application.prepareProfileRuntime()).toThrow(/not clean/)
  })

  it('keeps rebuild blocked after a stop rejects and its late work subsequently completes', async () => {
    let finished = false
    @Injectable('RejectedDrainService')
    class RejectedDrainService extends BaseService {
      protected override async onStop(): Promise<void> {
        setTimeout(() => {
          finished = true
        }, SERVICE_STOP_TIMEOUT_MS + 1000)
        await new Promise<void>((resolve) => setTimeout(resolve, SERVICE_STOP_TIMEOUT_MS - 500))
        throw new Error('Unsettled background work')
      }
    }
    const application = Application.getInstance()
    ServiceContainer.getInstance().register(RejectedDrainService)
    await application.getLifecycleManager().startPhase(Phase.WhenReady)
    const teardown = application.prepareProfileSwitch()
    await vi.advanceTimersByTimeAsync(SERVICE_STOP_TIMEOUT_MS - 500)
    const result = await teardown
    expect(result.clean).toBe(false)
    expect(result.stop.failed).toContain('RejectedDrainService')
    expect(result.stop.timedOut).toEqual([])
    expect(() => application.prepareProfileRuntime()).toThrow(/not clean/)
    await vi.advanceTimersByTimeAsync(1500)
    expect(finished).toBe(true)
    expect(() => application.prepareProfileRuntime()).toThrow(/not clean/)
  })

  it('returns a clean structured result for profile switch teardown', async () => {
    const application = Application.getInstance()
    const manager = application.getLifecycleManager()
    vi.spyOn(manager, 'stopAll').mockResolvedValue({ timedOut: [], failed: [] })
    vi.spyOn(manager, 'destroyAll').mockResolvedValue({ timedOut: [], failed: [] })

    await expect(application.prepareProfileSwitch()).resolves.toEqual({
      clean: true,
      stop: { timedOut: [], failed: [] },
      destroy: { timedOut: [], failed: [] }
    })
  })

  it('should keep the flush → stop → destroy → finish order and report a clean exit', async () => {
    const order: string[] = []

    vi.mocked(bootConfigService.flush).mockImplementation(() => {
      order.push('flush')
    })
    vi.mocked(mockMainLoggerService.finish).mockImplementation(() => {
      order.push('finish')
    })

    @Injectable('HealthyService')
    class HealthyService extends BaseService {
      protected override onStop() {
        order.push('stop')
      }
      protected override onDestroy() {
        order.push('destroy')
      }
    }

    const application = Application.getInstance()
    ServiceContainer.getInstance().register(HealthyService)

    await runWillQuit(application)

    expect(order).toEqual(['flush', 'stop', 'destroy', 'finish'])
    expect(exitSpy).not.toHaveBeenCalled()
    expect(messages('info')).toContainEqual(expect.stringContaining('Shutdown complete ('))
    expect(messages('warn')).not.toContainEqual(expect.stringContaining('not cleanly'))
  })
})
