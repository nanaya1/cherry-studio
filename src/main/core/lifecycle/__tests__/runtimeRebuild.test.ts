/**
 * Unit tests for the runtime-rebuild primitives backing
 * Application.prepareProfileRuntime():
 *   - ServiceContainer.clear() — in-place clear of registrations + instances
 *   - LifecycleManager.resetRuntimeState() — in-place clear of runtime state
 *   - BaseService singleton guard — released per-constructor only after a
 *     successful destroy (NOT a global wipe).
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { BaseService } from '../BaseService'
import { Injectable, ServicePhase } from '../decorators'
import { LifecycleManager } from '../LifecycleManager'
import { ServiceContainer } from '../ServiceContainer'
import { Phase } from '../types'

describe('runtime rebuild primitives', () => {
  beforeEach(() => {
    ServiceContainer.reset()
    LifecycleManager.reset()
    BaseService.resetInstances()
  })

  describe('ServiceContainer.clear()', () => {
    it('clears registrations and instances in place, preserving the singleton', () => {
      const c = ServiceContainer.getInstance()
      @Injectable('ClearMe')
      class ClearMe extends BaseService {}
      c.register(ClearMe)
      c.get('ClearMe')
      expect(c.getServiceNames()).toContain('ClearMe')

      c.clear()

      expect(c.getServiceNames()).toHaveLength(0)
      // Singleton reference preserved — not a brand-new instance.
      expect(ServiceContainer.getInstance()).toBe(c)
    })
  })

  describe('LifecycleManager.resetRuntimeState()', () => {
    it('clears runtime state in place, preserving the singleton', async () => {
      const m = LifecycleManager.getInstance()
      @Injectable('RunMe')
      @ServicePhase(Phase.Background)
      class RunMe extends BaseService {}
      ServiceContainer.getInstance().register(RunMe)
      await m.startPhase(Phase.Background)
      expect(m.getInitializationOrder().length).toBeGreaterThan(0)

      m.resetRuntimeState()

      expect(m.getInitializationOrder()).toHaveLength(0)
      expect(m.isInitialized()).toBe(false)
      // Singleton reference preserved.
      expect(LifecycleManager.getInstance()).toBe(m)
    })
  })

  describe('BaseService singleton guard', () => {
    it('releases only the destroyed constructor, not a global reset', async () => {
      @Injectable('GuardA')
      class GuardA extends BaseService {}
      @Injectable('GuardB')
      class GuardB extends BaseService {}

      const container = ServiceContainer.getInstance()
      container.register(GuardA)
      container.register(GuardB)
      const a = container.get('GuardA') as GuardA
      const b = container.get('GuardB') as GuardB

      // Both instantiated → re-instantiation blocked.
      expect(() => new GuardA()).toThrow()
      expect(() => new GuardB()).toThrow()

      await a._doDestroy()
      expect(a.isDestroyed).toBe(true)

      // Only GuardA released; GuardB still guarded.
      expect(() => new GuardA()).not.toThrow()
      expect(() => new GuardB()).toThrow()

      await b._doDestroy()
      expect(() => new GuardB()).not.toThrow()
    })
  })
})
