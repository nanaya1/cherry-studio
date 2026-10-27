import { mockMainLoggerService } from '@test-mocks/MainLoggerService'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ShutdownResult } from '@main/core/application/Application'

import type { ControlMutationResult, ControlWriteResult } from '../ProfileControlStore'
import { shouldActivateInProcess } from '../ProfileRuntimeContext'
import type { ActiveProfilePointerV1, ProfileRecordV1, ProfileSwitchJournalV1 } from '../ProfileSchemas'
import { ProfileSwitchCoordinator } from '../ProfileSwitchCoordinator'
import { SwitchFence } from '../SwitchFence'

const request = {
  operationId: '550e8400-e29b-41d4-a716-446655440000',
  fromProfileId: 'signed-out',
  targetProfileId: '0123456789abcdef0123456789abcdef',
  targetIdentityDigest: '0'.repeat(64)
}

type PreparedJournal = Extract<ProfileSwitchJournalV1, { phase: 'prepared' }>
type CommittedJournal = Extract<ProfileSwitchJournalV1, { phase: 'committed' }>

function dependencies() {
  const order: string[] = []
  const fence = new SwitchFence()
  const confirmed: ControlWriteResult = { kind: 'committed-confirmed' }
  const prepared: PreparedJournal = {
    version: 1,
    phase: 'prepared',
    ...request,
    createdAt: '2026-10-15T00:00:00.000Z'
  }
  const committed: CommittedJournal = {
    ...prepared,
    phase: 'committed',
    committedAt: '2026-10-15T00:00:01.000Z'
  }
  const targetRecord: ProfileRecordV1 = {
    version: 1,
    profileId: request.targetProfileId,
    identityDigest: request.targetIdentityDigest,
    kind: 'authenticated',
    state: 'ready',
    createdAt: '2026-10-15T00:00:00.000Z'
  }
  return {
    order,
    fence,
    journal: {
      prepare: vi.fn(async (): Promise<ControlMutationResult<PreparedJournal>> => {
        order.push('journal:prepared')
        return { value: prepared, durability: confirmed }
      }),
      commit: vi.fn(async (): Promise<ControlMutationResult<CommittedJournal>> => {
        order.push('journal:committed')
        return { value: committed, durability: confirmed }
      }),
      cancel: vi.fn(async (): Promise<ControlMutationResult<PreparedJournal>> => {
        order.push('journal:cancelled')
        return { value: prepared, durability: confirmed }
      })
    },
    activePointer: {
      commitPointer: vi.fn(async (_record, operationId): Promise<ControlMutationResult<ActiveProfilePointerV1>> => {
        order.push('pointer:committed')
        return {
          value: {
            version: 1,
            profileId: request.targetProfileId,
            identityDigest: request.targetIdentityDigest,
            committedAt: '2026-10-15T00:00:01.000Z',
            operationId
          },
          durability: confirmed
        }
      })
    },
    application: {
      prepareProfileSwitch: vi.fn(async (): Promise<ShutdownResult> => {
        order.push('application:teardown')
        return { clean: true, stop: { timedOut: [], failed: [] }, destroy: { timedOut: [], failed: [] } }
      }),
      relaunch: vi.fn(() => order.push('application:relaunch')),
      forceExit: vi.fn(() => order.push('application:exit'))
    },
    targetRecord
  }
}

describe('ProfileSwitchCoordinator', () => {
  afterEach(() => {
    mockMainLoggerService.error.mockClear()
  })

  it('relaunches after committing the first login without entering business in the login process', async () => {
    const deps = dependencies()
    const startBusiness = vi.fn(async () => {
      throw new Error('Business startup cannot reuse the login process')
    })
    const result = await new ProfileSwitchCoordinator({
      ...deps,
      activateAuthenticated: async (record) => {
        if (!shouldActivateInProcess(record, null)) return false
        await startBusiness()
        return true
      }
    }).switchProfile(request, deps.targetRecord, {
      afterCommit: async () => {
        deps.order.push('credentials:committed')
      }
    })

    expect(result).toEqual({ kind: 'relaunching' })
    expect(deps.order).toEqual([
      'journal:prepared',
      'application:teardown',
      'pointer:committed',
      'journal:committed',
      'credentials:committed',
      'application:relaunch'
    ])
    expect(startBusiness).not.toHaveBeenCalled()
    expect(deps.application.forceExit).not.toHaveBeenCalled()
  })

  it('returns to the login window after durable logout without relaunching Electron', async () => {
    const deps = dependencies()
    const openSignedOut = vi.fn(async () => {
      deps.order.push('login:opened')
    })
    const result = await new ProfileSwitchCoordinator({ ...deps, openSignedOut }).switchProfile(request, {
      ...deps.targetRecord,
      kind: 'signed-out'
    })
    expect(result).toEqual({ kind: 'signed-out' })
    expect(deps.order).toEqual([
      'journal:prepared',
      'application:teardown',
      'pointer:committed',
      'journal:committed',
      'login:opened'
    ])
    expect(deps.application.relaunch).not.toHaveBeenCalled()
  })

  it('orders prepared journal, fence, clean teardown, pointer, committed journal, and relaunch', async () => {
    const deps = dependencies()
    const beginSwitch = vi.spyOn(deps.fence, 'beginSwitch').mockImplementation((operationId) => {
      deps.order.push('fence:closed')
      return SwitchFence.prototype.beginSwitch.call(deps.fence, operationId)
    })

    const result = await new ProfileSwitchCoordinator(deps).switchProfile(request, deps.targetRecord)

    expect(result).toEqual({ kind: 'relaunching' })
    expect(deps.order).toEqual([
      'journal:prepared',
      'fence:closed',
      'application:teardown',
      'pointer:committed',
      'journal:committed',
      'application:relaunch'
    ])
    expect(beginSwitch).toHaveBeenCalledWith(request.operationId)
  })

  it('logs the activation failure reason before exiting for business-startup recovery', async () => {
    const deps = dependencies()
    mockMainLoggerService.error.mockClear()

    const result = await new ProfileSwitchCoordinator({
      ...deps,
      activateAuthenticated: async () => {
        throw new Error('No active boot attempt for profile abc')
      }
    }).switchProfile(request, deps.targetRecord)

    expect(result).toEqual({ kind: 'needs-recovery', stage: 'business-startup' })
    expect(deps.application.forceExit).toHaveBeenCalledWith(1)
    expect(deps.application.relaunch).not.toHaveBeenCalled()
    // 只能靠日志定位：这里 force-exit 后不会重启，没有原因就无法判断为何起不来。
    expect(mockMainLoggerService.error).toHaveBeenCalledWith(
      'Same-process business activation failed; entering business-startup recovery',
      expect.any(Error)
    )
  })

  it('runs target preparation only after clean teardown and before pointer commit', async () => {
    const deps = dependencies()
    const prepareTarget = vi.fn(async () => {
      deps.order.push('target:prepared')
      return deps.targetRecord
    })

    await new ProfileSwitchCoordinator(deps).switchProfile(request, deps.targetRecord, { afterTeardown: prepareTarget })

    expect(deps.order).toEqual([
      'journal:prepared',
      'application:teardown',
      'target:prepared',
      'pointer:committed',
      'journal:committed',
      'application:relaunch'
    ])
  })

  it('does not commit pointer when target preparation fails after teardown', async () => {
    const deps = dependencies()

    const result = await new ProfileSwitchCoordinator(deps).switchProfile(request, deps.targetRecord, {
      afterTeardown: async () => {
        throw new Error('keychain unavailable')
      }
    })

    expect(result).toEqual({ kind: 'teardown-failed', error: 'keychain unavailable' })
    expect(deps.journal.cancel).toHaveBeenCalledWith(request.operationId)
    expect(deps.activePointer.commitPointer).not.toHaveBeenCalled()
    expect(deps.journal.commit).not.toHaveBeenCalled()
    expect(deps.application.relaunch).not.toHaveBeenCalled()
  })

  it('exits for recovery when target preparation fails and journal cancellation durability is unknown', async () => {
    const deps = dependencies()
    deps.journal.cancel.mockResolvedValue({
      value: {
        version: 1,
        phase: 'prepared',
        ...request,
        createdAt: '2026-10-15T00:00:00.000Z'
      },
      durability: { kind: 'committed-durability-unknown', reason: 'error', error: 'sync failed' }
    })

    const result = await new ProfileSwitchCoordinator(deps).switchProfile(request, deps.targetRecord, {
      afterTeardown: async () => {
        throw new Error('keychain unavailable')
      }
    })

    expect(result).toEqual({ kind: 'needs-recovery', stage: 'journal-prepared' })
    expect(deps.activePointer.commitPointer).not.toHaveBeenCalled()
    expect(deps.application.relaunch).not.toHaveBeenCalled()
    expect(deps.application.forceExit).toHaveBeenCalledWith(1)
    expect(deps.fence.state.kind).toBe('needs-recovery')
  })

  it('does not commit pointer when teardown fails and keeps the fence closed', async () => {
    const deps = dependencies()
    deps.application.prepareProfileSwitch.mockResolvedValue({
      clean: false,
      stop: { timedOut: [], failed: ['McpRuntimeService'] },
      destroy: { timedOut: [], failed: [] }
    })

    const result = await new ProfileSwitchCoordinator(deps).switchProfile(request, deps.targetRecord)

    expect(result).toMatchObject({ kind: 'teardown-failed' })
    expect(deps.activePointer.commitPointer).not.toHaveBeenCalled()
    expect(deps.journal.commit).not.toHaveBeenCalled()
    expect(deps.application.relaunch).not.toHaveBeenCalled()
    expect(deps.fence.state.kind).toBe('teardown-failed')
  })

  it('keeps the pointer unchanged when structured teardown throws', async () => {
    const deps = dependencies()
    deps.application.prepareProfileSwitch.mockRejectedValue(new Error('teardown crashed'))

    const result = await new ProfileSwitchCoordinator(deps).switchProfile(request, deps.targetRecord)

    expect(result).toEqual({ kind: 'teardown-failed', error: 'teardown crashed' })
    expect(deps.activePointer.commitPointer).not.toHaveBeenCalled()
    expect(deps.fence.state.kind).toBe('teardown-failed')
  })

  it('exits for recovery when pointer persistence throws after teardown', async () => {
    const deps = dependencies()
    deps.activePointer.commitPointer.mockRejectedValue(new Error('pointer write failed'))

    const result = await new ProfileSwitchCoordinator(deps).switchProfile(request, deps.targetRecord)

    expect(result).toEqual({ kind: 'needs-recovery', stage: 'active-pointer' })
    expect(deps.journal.commit).not.toHaveBeenCalled()
    expect(deps.application.forceExit).toHaveBeenCalledWith(1)
    expect(deps.fence.state.kind).toBe('needs-recovery')
  })

  it('does not start teardown when prepared journal durability is unknown', async () => {
    const deps = dependencies()
    deps.journal.prepare.mockResolvedValue({
      value: {
        version: 1,
        phase: 'prepared',
        ...request,
        createdAt: '2026-10-15T00:00:00.000Z'
      },
      durability: { kind: 'committed-durability-unknown', reason: 'error', error: 'sync failed' }
    })

    const result = await new ProfileSwitchCoordinator(deps).switchProfile(request, deps.targetRecord)

    expect(result).toEqual({ kind: 'needs-recovery', stage: 'journal-prepared' })
    expect(deps.application.prepareProfileSwitch).not.toHaveBeenCalled()
    expect(deps.application.forceExit).toHaveBeenCalledWith(1)
  })

  it('does not claim rollback when pointer durability is unknown and exits for recovery', async () => {
    const deps = dependencies()
    deps.activePointer.commitPointer.mockResolvedValue({
      value: {
        version: 1,
        profileId: request.targetProfileId,
        identityDigest: request.targetIdentityDigest,
        committedAt: '2026-10-15T00:00:01.000Z',
        operationId: request.operationId
      },
      durability: { kind: 'committed-durability-unknown', reason: 'error', error: 'sync failed' }
    })

    const result = await new ProfileSwitchCoordinator(deps).switchProfile(request, deps.targetRecord)

    expect(result).toEqual({ kind: 'needs-recovery', stage: 'active-pointer' })
    expect(deps.journal.commit).not.toHaveBeenCalled()
    expect(deps.application.relaunch).not.toHaveBeenCalled()
    expect(deps.application.forceExit).toHaveBeenCalledWith(1)
    expect(deps.fence.state.kind).toBe('needs-recovery')
  })

  it('exits for recovery when journal commit throws after pointer commit', async () => {
    const deps = dependencies()
    deps.journal.commit.mockRejectedValue(new Error('journal commit failed'))

    const result = await new ProfileSwitchCoordinator(deps).switchProfile(request, deps.targetRecord)

    expect(result).toEqual({ kind: 'needs-recovery', stage: 'journal-committed' })
    expect(deps.application.forceExit).toHaveBeenCalledWith(1)
    expect(deps.application.relaunch).not.toHaveBeenCalled()
  })

  it('exits for recovery when journal commit durability is unknown after pointer commit', async () => {
    const deps = dependencies()
    deps.journal.commit.mockResolvedValue({
      value: {
        version: 1,
        phase: 'committed',
        ...request,
        createdAt: '2026-10-15T00:00:00.000Z',
        committedAt: '2026-10-15T00:00:01.000Z'
      },
      durability: { kind: 'committed-durability-unknown', reason: 'error', error: 'sync failed' }
    })

    const result = await new ProfileSwitchCoordinator(deps).switchProfile(request, deps.targetRecord)

    expect(result).toEqual({ kind: 'needs-recovery', stage: 'journal-committed' })
    expect(deps.application.forceExit).toHaveBeenCalledWith(1)
    expect(deps.application.relaunch).not.toHaveBeenCalled()
  })

  describe('same-process activation (activateAuthenticated)', () => {
    it('returns activated (no relaunch) when the hook approves the business start', async () => {
      const deps = dependencies()
      const activate = vi.fn(async () => true)

      const result = await new ProfileSwitchCoordinator({ ...deps, activateAuthenticated: activate }).switchProfile(
        request,
        deps.targetRecord
      )

      expect(result).toEqual({ kind: 'activated', record: deps.targetRecord })
      expect(activate).toHaveBeenCalledWith(deps.targetRecord)
      expect(deps.application.relaunch).not.toHaveBeenCalled()
      expect(deps.application.forceExit).not.toHaveBeenCalled()
    })

    it('falls back to relaunch when the hook declines activation', async () => {
      const deps = dependencies()
      const activate = vi.fn(async () => false)

      const result = await new ProfileSwitchCoordinator({ ...deps, activateAuthenticated: activate }).switchProfile(
        request,
        deps.targetRecord
      )

      expect(result).toEqual({ kind: 'relaunching' })
      expect(activate).toHaveBeenCalledWith(deps.targetRecord)
      expect(deps.application.relaunch).toHaveBeenCalled()
      expect(deps.application.forceExit).not.toHaveBeenCalled()
    })

    it('never activates when commit fails, routing to journal-committed recovery', async () => {
      const deps = dependencies()
      deps.journal.commit.mockRejectedValue(new Error('journal commit failed'))
      const activate = vi.fn(async () => true)

      const result = await new ProfileSwitchCoordinator({ ...deps, activateAuthenticated: activate }).switchProfile(
        request,
        deps.targetRecord
      )

      expect(result).toEqual({ kind: 'needs-recovery', stage: 'journal-committed' })
      expect(activate).not.toHaveBeenCalled()
      expect(deps.application.forceExit).toHaveBeenCalledWith(1)
    })

    it('force-exits into business-startup recovery when activation startup throws', async () => {
      const deps = dependencies()
      const activate = vi.fn(async () => {
        throw new Error('business bootstrap failed')
      })

      const result = await new ProfileSwitchCoordinator({ ...deps, activateAuthenticated: activate }).switchProfile(
        request,
        deps.targetRecord
      )

      expect(result).toEqual({ kind: 'needs-recovery', stage: 'business-startup' })
      expect(deps.application.forceExit).toHaveBeenCalledWith(1)
      expect(deps.application.relaunch).not.toHaveBeenCalled()
    })
  })
})
