import { describe, expect, it, vi } from 'vitest'

import { computeIdentityDigest } from '../ProfileIdentity'
import { ProfileSessionService } from '../ProfileSessionService'
import type { ProfileSwitchResult } from '../ProfileSwitchCoordinator'

function setup() {
  const signedOut = {
    version: 1 as const,
    profileId: 'signed-out',
    identityDigest: computeIdentityDigest({ kind: 'signed-out' as const, bootstrapId: 'signed-out' as const }),
    kind: 'signed-out' as const,
    state: 'ready' as const,
    createdAt: '2026-10-15T00:00:00.000Z'
  }
  const authenticated = {
    ...signedOut,
    profileId: '2'.repeat(32),
    identityDigest: '2'.repeat(64),
    kind: 'authenticated' as const,
    authorizationContext: { groupId: 'previous-group', role: 'member', status: 'active' }
  }
  const deps = {
    dataRoot: '/data',
    bootJournal: { resetAfterAuthentication: vi.fn().mockResolvedValue({ kind: 'committed-confirmed' }) },
    currentProfileId: 'signed-out',
    installation: { getOrCreate: vi.fn().mockResolvedValue({ value: { deviceInstallId: 'install-1' } }) },
    registry: {
      ensureLocal: vi.fn().mockResolvedValue({ value: signedOut }),
      ensureAuthenticated: vi.fn().mockResolvedValue({ value: authenticated }),
      requireActivatable: vi.fn().mockResolvedValue(signedOut),
      updateAuthorizationContext: vi.fn().mockResolvedValue({ value: authenticated })
    },
    prepareProfileRoot: vi.fn().mockResolvedValue(undefined),
    prepareAuthenticatedUserData: vi.fn().mockResolvedValue(undefined),
    credentialStoreFor: vi.fn<() => any>(() => ({
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn(),
      quarantine: vi.fn().mockResolvedValue({ kind: 'committed-confirmed' }),
      restoreQuarantined: vi.fn().mockResolvedValue({ kind: 'committed-confirmed' }),
      discardQuarantined: vi.fn()
    })),
    coordinator: {
      switchProfile: vi.fn(async (_request, _target, transition): Promise<ProfileSwitchResult> => {
        await transition?.afterTeardown?.()
        await transition?.afterCommit?.()
        return { kind: 'relaunching' }
      })
    },
    logoutIntent: {
      begin: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn().mockResolvedValue(undefined)
    },
    operationId: vi.fn(() => '550e8400-e29b-41d4-a716-446655440000')
  }
  return { deps, authenticated, signedOut }
}

describe('ProfileSessionService', () => {
  it('restores the target Cookie session if credential persistence fails before pointer commit', async () => {
    const { deps } = setup()
    const rollback = vi.fn(async () => undefined)
    const store = {
      load: vi.fn(async () => null),
      save: vi.fn(async () => {
        throw new Error('disk full')
      }),
      clear: vi.fn()
    }
    deps.credentialStoreFor.mockReturnValue(store)
    const service = new ProfileSessionService(deps)
    await expect(
      service.completeAuthentication({
        identity: { kind: 'authenticated', accountKind: 'management', issuerId: 'server', subjectId: 'user' },
        authorizationContext: { groupId: 'group', role: 'member', status: 'active' },
        session: { userId: 'user' } as never,
        prepareTargetSession: async () => rollback
      })
    ).rejects.toThrow('disk full')
    expect(rollback).toHaveBeenCalledOnce()
    expect(store.clear).toHaveBeenCalledOnce()
  })

  it('refuses to enter the local profile because it is staging-only', async () => {
    const { deps } = setup()
    const service = new ProfileSessionService(deps)

    await expect(service.enterLocal()).rejects.toThrow(/staging-only/)
    expect(deps.coordinator.switchProfile).not.toHaveBeenCalled()
    expect(deps.registry.ensureLocal).not.toHaveBeenCalled()
  })

  it('writes credentials to the target profile before switching and never to the current profile', async () => {
    const { deps, authenticated } = setup()
    const targetStore = { save: vi.fn().mockResolvedValue(undefined), clear: vi.fn() }
    deps.credentialStoreFor.mockReturnValue(targetStore)
    const service = new ProfileSessionService(deps)
    const auth = {
      identity: {
        kind: 'authenticated' as const,
        accountKind: 'management' as const,
        issuerId: 'server-1',
        subjectId: 'u1'
      },
      authorizationContext: { groupId: 'g1', role: 'member', status: 'active', checkedAt: new Date().toISOString() },
      session: { userId: 'u1' }
    }

    await service.completeAuthentication(auth as never)

    expect(deps.credentialStoreFor).toHaveBeenCalledWith('/data/profiles/' + authenticated.profileId)
    expect(targetStore.save).toHaveBeenCalledWith(auth.session)
    expect(deps.coordinator.switchProfile).toHaveBeenCalled()
  })

  it('completes a pending logout intent only after the authenticated switch commits', async () => {
    const { deps } = setup()
    const order: string[] = []
    deps.coordinator.switchProfile.mockImplementation(async (_request, _target, transition) => {
      order.push('pointer-and-journal-committed')
      await transition?.afterCommit?.()
      return { kind: 'relaunching' }
    })
    deps.logoutIntent.complete.mockImplementation(async () => {
      order.push('logout-intent-completed')
    })

    await new ProfileSessionService(deps).completeAuthentication({
      identity: { kind: 'authenticated', accountKind: 'management', issuerId: 'server-1', subjectId: 'u1' },
      authorizationContext: { groupId: 'g1', role: 'member', status: 'active' },
      session: { userId: 'u1' }
    } as never)

    expect(order).toEqual(['pointer-and-journal-committed', 'logout-intent-completed'])
  })

  it('keeps a pending logout intent when the authenticated switch does not commit', async () => {
    const { deps } = setup()
    deps.coordinator.switchProfile.mockResolvedValue({ kind: 'teardown-failed', error: 'busy' })

    await expect(
      new ProfileSessionService(deps).completeAuthentication({
        identity: { kind: 'authenticated', accountKind: 'management', issuerId: 'server-1', subjectId: 'u1' },
        authorizationContext: { groupId: 'g1', role: 'member', status: 'active' },
        session: { userId: 'u1' }
      } as never)
    ).resolves.toEqual({ kind: 'teardown-failed', error: 'busy' })

    expect(deps.logoutIntent.complete).not.toHaveBeenCalled()
  })

  it('prepares target user data before writing credentials and aborts cleanly when preparation fails', async () => {
    const { deps } = setup()
    const order: string[] = []
    const targetStore = {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn(async () => order.push('credentials')),
      clear: vi.fn()
    }
    deps.prepareAuthenticatedUserData.mockResolvedValue({
      apply: async () => {
        order.push('claim')
      },
      commit: async () => {
        order.push('claim-committed')
      }
    })
    deps.logoutIntent.complete.mockImplementation(async () => {
      order.push('logout-intent-completed')
    })
    deps.credentialStoreFor.mockReturnValue(targetStore)
    deps.registry.updateAuthorizationContext.mockImplementation(async () => {
      order.push('authorization')
      return { value: setup().authenticated }
    })
    deps.coordinator.switchProfile.mockImplementation(async (_request, _target, transition) => {
      order.push('teardown')
      await transition.afterTeardown()
      order.push('switch')
      await transition.afterCommit?.()
      return { kind: 'relaunching' }
    })
    const authentication = {
      identity: {
        kind: 'authenticated' as const,
        accountKind: 'management' as const,
        issuerId: 'server-1',
        subjectId: 'u1'
      },
      authorizationContext: { groupId: 'g1', role: 'member', status: 'active' },
      session: { userId: 'u1' }
    }

    await new ProfileSessionService(deps).completeAuthentication(authentication as never)

    expect(order).toEqual([
      'teardown',
      'claim',
      'credentials',
      'authorization',
      'switch',
      'logout-intent-completed',
      'claim-committed'
    ])

    deps.prepareAuthenticatedUserData.mockRejectedValueOnce(new Error('profile claim cancelled'))
    targetStore.save.mockClear()
    deps.registry.updateAuthorizationContext.mockClear()
    deps.coordinator.switchProfile.mockClear()

    await expect(new ProfileSessionService(deps).completeAuthentication(authentication as never)).rejects.toThrow(
      'profile claim cancelled'
    )
    expect(targetStore.save).not.toHaveBeenCalled()
    expect(deps.registry.updateAuthorizationContext).not.toHaveBeenCalled()
    expect(deps.coordinator.switchProfile).not.toHaveBeenCalled()
  })

  it('does not switch the pointer when target credential persistence fails', async () => {
    const { deps } = setup()
    deps.credentialStoreFor.mockReturnValue({
      save: vi.fn().mockRejectedValue(new Error('keychain unavailable')),
      clear: vi.fn()
    })
    const service = new ProfileSessionService(deps)

    await expect(
      service.completeAuthentication({
        identity: { kind: 'authenticated', accountKind: 'management', issuerId: 'server-1', subjectId: 'u1' },
        authorizationContext: { groupId: 'g1', role: 'member', status: 'active' },
        session: { userId: 'u1' }
      } as never)
    ).rejects.toThrow('keychain unavailable')
    expect(deps.coordinator.switchProfile).toHaveBeenCalledOnce()
    expect(deps.registry.updateAuthorizationContext).toHaveBeenCalledOnce()
    expect(deps.registry.updateAuthorizationContext).toHaveBeenCalledWith(
      expect.objectContaining({ subjectId: 'u1' }),
      expect.objectContaining({ groupId: 'previous-group' })
    )
  })

  it('updates authorization context for the current identity without switching profiles', async () => {
    const { deps, authenticated } = setup()
    const service = new ProfileSessionService(deps)
    const identity = {
      kind: 'authenticated' as const,
      accountKind: 'management' as const,
      issuerId: 'server-1',
      subjectId: 'u1'
    }
    const authorizationContext = {
      groupId: 'group-b',
      role: 'admin',
      status: 'active',
      checkedAt: new Date().toISOString()
    }

    await service.updateAuthorizationContext(identity, authorizationContext)

    expect(deps.registry.updateAuthorizationContext).toHaveBeenCalledWith(identity, authorizationContext)
    expect(deps.coordinator.switchProfile).not.toHaveBeenCalled()
    expect(authenticated.kind).toBe('authenticated')
  })

  it('supports signed-out, authenticated, and logout switches without a local business step', async () => {
    const { deps, authenticated, signedOut } = setup()
    const service = new ProfileSessionService(deps)

    await service.completeAuthentication({
      identity: { kind: 'authenticated', accountKind: 'management', issuerId: 'server-1', subjectId: 'u1' },
      authorizationContext: { groupId: 'g1', role: 'member', status: 'active' },
      session: { userId: 'u1' }
    } as never)
    deps.currentProfileId = authenticated.profileId
    await service.logout()

    expect(
      deps.coordinator.switchProfile.mock.calls.map(([operation, target]) => [
        operation.fromProfileId,
        target.profileId
      ])
    ).toEqual([
      ['signed-out', authenticated.profileId],
      [authenticated.profileId, signedOut.profileId]
    ])
  })

  it('does not touch credentials or switch profiles when logout intent cannot be persisted', async () => {
    const { deps } = setup()
    deps.logoutIntent.begin.mockRejectedValue(new Error('disk full'))
    await expect(new ProfileSessionService(deps).logout()).rejects.toThrow('disk full')
    expect(deps.credentialStoreFor).not.toHaveBeenCalled()
    expect(deps.coordinator.switchProfile).not.toHaveBeenCalled()
  })

  it('keeps credentials quarantined when logout teardown fails', async () => {
    const { deps } = setup()
    deps.currentProfileId = '2'.repeat(32)
    const currentStore = {
      save: vi.fn(),
      clear: vi.fn(),
      quarantine: vi.fn().mockResolvedValue({ kind: 'committed-confirmed' }),
      restoreQuarantined: vi.fn().mockResolvedValue({ kind: 'committed-confirmed' }),
      discardQuarantined: vi.fn()
    }
    deps.credentialStoreFor.mockReturnValue(currentStore)
    deps.coordinator.switchProfile.mockResolvedValue({ kind: 'teardown-failed', error: 'busy' })

    await expect(new ProfileSessionService(deps).logout()).resolves.toEqual({ kind: 'teardown-failed', error: 'busy' })

    expect(currentStore.quarantine).toHaveBeenCalledOnce()
    expect(currentStore.restoreQuarantined).not.toHaveBeenCalled()
    expect(currentStore.discardQuarantined).not.toHaveBeenCalled()
    expect(currentStore.clear).not.toHaveBeenCalled()
  })

  it('keeps quarantined credentials for next-process cleanup after logout commits', async () => {
    const { deps, signedOut } = setup()
    deps.currentProfileId = '2'.repeat(32)
    const currentStore = {
      save: vi.fn(),
      clear: vi.fn(),
      quarantine: vi.fn().mockResolvedValue({ kind: 'committed-confirmed' }),
      restoreQuarantined: vi.fn(),
      discardQuarantined: vi.fn()
    }
    deps.credentialStoreFor.mockReturnValue(currentStore)
    const service = new ProfileSessionService(deps)

    await expect(service.logout()).resolves.toEqual({ kind: 'relaunching' })

    expect(currentStore.quarantine).toHaveBeenCalledOnce()
    expect(currentStore.restoreQuarantined).not.toHaveBeenCalled()
    expect(currentStore.discardQuarantined).not.toHaveBeenCalled()
    expect(deps.coordinator.switchProfile).toHaveBeenCalledWith(
      expect.objectContaining({ fromProfileId: deps.currentProfileId, targetProfileId: 'signed-out' }),
      signedOut
    )
  })

  it('restores target credentials and authorization context when login switch fails', async () => {
    const { deps, authenticated } = setup()
    const previousSession = { userId: 'previous' }
    const targetStore = {
      load: vi.fn().mockResolvedValue(previousSession),
      save: vi.fn().mockResolvedValue({ kind: 'committed-confirmed' }),
      clear: vi.fn().mockResolvedValue(undefined)
    }
    deps.credentialStoreFor.mockReturnValue(targetStore)
    deps.registry.updateAuthorizationContext
      .mockResolvedValueOnce({ value: authenticated, durability: { kind: 'committed-confirmed' } })
      .mockResolvedValueOnce({ value: authenticated, durability: { kind: 'committed-confirmed' } })
    deps.coordinator.switchProfile.mockResolvedValue({ kind: 'teardown-failed', error: 'busy' })
    const auth = {
      identity: {
        kind: 'authenticated' as const,
        accountKind: 'management' as const,
        issuerId: 'server-1',
        subjectId: 'u1'
      },
      authorizationContext: { groupId: 'g1', role: 'member', status: 'active' },
      session: { userId: 'u1' }
    }

    await expect(new ProfileSessionService(deps).completeAuthentication(auth as never)).resolves.toEqual({
      kind: 'teardown-failed',
      error: 'busy'
    })

    expect(targetStore.save).toHaveBeenLastCalledWith(previousSession)
    expect(deps.registry.updateAuthorizationContext).toHaveBeenLastCalledWith(
      auth.identity,
      authenticated.authorizationContext
    )
  })
})
