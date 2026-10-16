/**
 * Tests for Application.prepareProfileRuntime() — the same-process business
 * runtime rebuild used for first-run / same-account no-restart.
 *
 * Contract under test:
 *   - callable when a CLEAN profile teardown completed, or on a process that
 *     never bootstrapped;
 *   - rejects a non-clean teardown or live (still-running) business;
 *   - in-place clears ServiceContainer + LifecycleManager runtime, rebuilds
 *     pathMap, resets bootstrap/shutdown/quit flags and stale IPC holds;
 *   - bootstrap() registers process/Electron handlers only once, so a repeated
 *     bootstrap after the rebuild does not re-register IPC.
 */

import { app, ipcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as PathRegistryModule from '@main/core/paths/pathRegistry'
import { bootConfigService } from '@main/data/bootConfig'

import { BaseService } from '../../lifecycle/BaseService'
import { Injectable, ServicePhase } from '../../lifecycle/decorators'
import { LifecycleManager } from '../../lifecycle/LifecycleManager'
import { ServiceContainer } from '../../lifecycle/ServiceContainer'
import { Phase } from '../../lifecycle/types'
import { Application } from '../Application'

// The `@application` alias resolves to Application.ts, so the global
// vi.mock('@application') in tests/main.setup.ts would otherwise hand back the
// stub singleton instead of the real class under test.
vi.unmock('@application')

// Mock buildPathRegistry (deep path imported by Application.ts) so
// prepareProfileRuntime() rebuilds a deterministic pathMap we can assert on.
// shouldAutoEnsure is kept from the real module via importActual spread.
vi.mock('@main/core/paths/pathRegistry', async () => {
  const actual = await vi.importActual<typeof PathRegistryModule>('@main/core/paths/pathRegistry')
  return {
    ...actual,
    buildPathRegistry: () =>
      Object.freeze({
        'app.userdata': '/rebuilt/userData',
        'feature.files.data': '/rebuilt/userData/Data/Files'
      })
  }
})

/** Reset the Application singleton between cases (mirrors Application.shutdown.test.ts). */
function resetApplication(): void {
  LifecycleManager.reset()
  ServiceContainer.reset()
  BaseService.resetInstances()
  ;(Application as unknown as { instance: Application | null }).instance = null
}

describe('Application.prepareProfileRuntime', () => {
  beforeEach(() => {
    resetApplication()
    Object.assign(app, { whenReady: vi.fn().mockResolvedValue(undefined) })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetApplication()
  })

  describe('guards', () => {
    it('throws when business is still running (bootstrapped, no teardown)', () => {
      const a = Application.getInstance()
      ;(a as unknown as { isBootstrapped: boolean }).isBootstrapped = true
      expect(() => a.prepareProfileRuntime()).toThrow(/business is still running/)
    })

    it('throws when the last teardown was not clean', () => {
      const a = Application.getInstance()
      ;(a as unknown as { completedProfileTeardown: unknown }).completedProfileTeardown = {
        clean: false,
        stop: { timedOut: ['JobManager'], failed: [] },
        destroy: { timedOut: [], failed: [] }
      }
      expect(() => a.prepareProfileRuntime()).toThrow(/not clean/)
    })

    it('throws while mid-shutdown with no completed teardown', () => {
      const a = Application.getInstance()
      ;(a as unknown as { isShuttingDown: boolean }).isShuttingDown = true
      ;(a as unknown as { isBootstrapped: boolean }).isBootstrapped = true
      expect(() => a.prepareProfileRuntime()).toThrow()
    })
  })

  describe('in-place rebuild on a fresh process', () => {
    it('clears container + lifecycle runtime, rebuilds pathMap, resets flags and IPC holds', async () => {
      const a = Application.getInstance()
      const container = ServiceContainer.getInstance()
      const manager = a.getLifecycleManager()

      @Injectable('FreshService')
      @ServicePhase(Phase.Background)
      class FreshService extends BaseService {}

      container.register(FreshService)
      container.get('FreshService') // instantiate — populates container.instance
      await manager.startPhase(Phase.Background) // populate runtime state

      expect(container.getServiceNames()).toContain('FreshService')
      expect(manager.getInitializationOrder()).toContain('FreshService')
      expect(a.isReady()).toBe(false)

      // Pre-seed a stale IPC quit hold to verify it gets cleared.
      a['ipcQuitHolds'].set('stale', { id: 'stale', dispose: vi.fn() })
      expect(a['ipcQuitHolds'].size).toBe(1)
      a['quitPreventionHolds'].set('p', 'reason')
      expect(a['quitPreventionHolds'].size).toBe(1)

      a.prepareProfileRuntime()

      // Container + lifecycle runtime cleared in place.
      expect(container.getServiceNames()).toHaveLength(0)
      expect(a.getLifecycleManager().getInitializationOrder()).toHaveLength(0)
      // Stale IPC holds cleared.
      expect(a['ipcQuitHolds'].size).toBe(0)
      expect(a['quitPreventionHolds'].size).toBe(0)
      // pathMap rebuilt from the mocked buildPathRegistry.
      expect(a.getPath('app.userdata')).toBe('/rebuilt/userData')
      // Flags reset.
      expect(a.isReady()).toBe(false)
      expect(a.isQuitting).toBe(false)
    })
  })

  describe('rebuild after a real clean teardown', () => {
    it('clears the runtime and allows re-registration + re-instantiation (guard released on destroy)', async () => {
      const a = Application.getInstance()
      const container = ServiceContainer.getInstance()
      const manager = a.getLifecycleManager()

      @Injectable('RebuildService')
      @ServicePhase(Phase.Background)
      class RebuildService extends BaseService {}

      container.register(RebuildService)
      container.get('RebuildService')
      await manager.startPhase(Phase.Background)
      expect(container.getServiceNames()).toContain('RebuildService')

      // Real teardown (stopAll + destroyAll) — destroys RebuildService and
      // releases its BaseService singleton guard.
      const result = await a.prepareProfileLogout()
      expect(result.clean).toBe(true)
      expect(manager.getInitializationOrder()).toHaveLength(0)

      a.prepareProfileRuntime()
      expect(container.getServiceNames()).toHaveLength(0)

      // Re-register and re-instantiate — must NOT throw "already instantiated".
      container.register(RebuildService)
      expect(() => container.get('RebuildService')).not.toThrow()
      expect(container.getServiceNames()).toContain('RebuildService')
    })
  })

  describe('bootstrap handler registration is once-per-process', () => {
    it('does not re-register process/electron handlers on repeated bootstrap', async () => {
      const a = Application.getInstance()
      const manager = a.getLifecycleManager()
      vi.spyOn(manager, 'startPhase').mockResolvedValue(undefined)
      vi.spyOn(manager, 'allReady').mockImplementation(() => {})
      vi.spyOn(bootConfigService, 'hasLoadError').mockReturnValue(false)
      a.__setPathMapForTesting({} as never)
      const setupSignal = vi.spyOn(a as unknown as { setupSignalHandlers: () => void }, 'setupSignalHandlers')
      const setupQuit = vi.spyOn(a as unknown as { setupQuitHandlers: () => void }, 'setupQuitHandlers')
      const setupElectron = vi.spyOn(a as unknown as { setupElectronHandlers: () => void }, 'setupElectronHandlers')
      const ipcHandle = vi.spyOn(ipcMain, 'handle')

      await a.bootstrap()
      expect(setupSignal).toHaveBeenCalledTimes(1)
      expect(setupQuit).toHaveBeenCalledTimes(1)
      expect(setupElectron).toHaveBeenCalledTimes(1)
      const handleCountAfterFirst = ipcHandle.mock.calls.length

      // Emulate prepareProfileRuntime having reset the bootstrapped flag, then
      // bootstrap again — the handlers must NOT be re-registered.
      ;(a as unknown as { isBootstrapped: boolean }).isBootstrapped = false
      await a.bootstrap()
      expect(setupSignal).toHaveBeenCalledTimes(1)
      expect(setupQuit).toHaveBeenCalledTimes(1)
      expect(setupElectron).toHaveBeenCalledTimes(1)
      expect(ipcHandle.mock.calls.length).toBe(handleCountAfterFirst)
    })
  })
})
