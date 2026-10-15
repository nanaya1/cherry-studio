import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ProfileRecoveryActions } from '../ProfileRecoveryActions'

const OPERATION_ID = '550e8400-e29b-41d4-a716-446655440000'
const TARGET_PROFILE_ID = '0123456789abcdef0123456789abcdef'
const TARGET_DIGEST = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const SIGNED_OUT_DIGEST = 'f'.repeat(64)

function createDependencies() {
  const signedOut = {
    version: 1 as const,
    profileId: 'signed-out' as const,
    identityDigest: SIGNED_OUT_DIGEST,
    kind: 'signed-out' as const,
    state: 'ready' as const,
    createdAt: new Date().toISOString()
  }
  const target = {
    ...signedOut,
    profileId: TARGET_PROFILE_ID,
    identityDigest: TARGET_DIGEST,
    kind: 'authenticated' as const
  }
  const local = {
    ...signedOut,
    profileId: 'abcdef0123456789abcdef0123456789',
    identityDigest: 'a'.repeat(64),
    kind: 'local' as const
  }
  return {
    context: {
      mode: 'signed-out' as const,
      profileId: 'signed-out',
      identityDigest: SIGNED_OUT_DIGEST,
      kind: 'signed-out' as const,
      dataRoot: '/data',
      profileRoot: '/data/profiles/signed-out',
      pendingSwitch: { operationId: OPERATION_ID, action: 'retry-or-cancel' as const }
    },
    journal: {
      read: vi.fn().mockResolvedValue({
        kind: 'ok',
        value: {
          version: 1,
          phase: 'prepared',
          operationId: OPERATION_ID,
          fromProfileId: 'signed-out',
          targetProfileId: TARGET_PROFILE_ID,
          targetIdentityDigest: TARGET_DIGEST,
          createdAt: new Date().toISOString()
        }
      }),
      commit: vi.fn().mockResolvedValue({ value: {}, durability: { kind: 'committed-confirmed' } }),
      cancel: vi.fn().mockResolvedValue({ value: {}, durability: { kind: 'committed-confirmed' } })
    },
    registry: {
      read: vi.fn().mockResolvedValue({ version: 1, profiles: [signedOut, target] }),
      requireActivatable: vi.fn().mockResolvedValue(target),
      ensureLocal: vi.fn().mockResolvedValue({ value: local, durability: { kind: 'committed-confirmed' } })
    },
    installation: {
      getOrCreate: vi.fn().mockResolvedValue({
        value: { version: 1, deviceInstallId: OPERATION_ID, createdAt: new Date().toISOString() },
        durability: { kind: 'not-written' }
      })
    },
    activePointer: {
      commitPointer: vi.fn().mockResolvedValue({ value: {}, durability: { kind: 'committed-confirmed' } })
    },
    prepareProfileRoot: vi.fn().mockResolvedValue(undefined),
    relaunch: vi.fn(),
    exportDiagnostics: vi.fn().mockResolvedValue({ kind: 'exported' })
  }
}

describe('ProfileRecoveryActions', () => {
  beforeEach(() => vi.clearAllMocks())

  it('retries only the prepared operation bound to the launch context', async () => {
    const dependencies = createDependencies()
    const actions = new ProfileRecoveryActions(dependencies)

    await actions.retry()

    expect(dependencies.registry.requireActivatable).toHaveBeenCalledWith(TARGET_PROFILE_ID, TARGET_DIGEST)
    expect(dependencies.activePointer.commitPointer).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: TARGET_PROFILE_ID }),
      OPERATION_ID
    )
    expect(dependencies.journal.commit).toHaveBeenCalledWith({
      operationId: OPERATION_ID,
      targetProfileId: TARGET_PROFILE_ID,
      targetIdentityDigest: TARGET_DIGEST
    })
    expect(dependencies.relaunch).toHaveBeenCalledOnce()
  })

  it('cancels only the pending operation bound to the launch context', async () => {
    const dependencies = createDependencies()
    const actions = new ProfileRecoveryActions(dependencies)

    await actions.cancelPendingSwitch()

    expect(dependencies.journal.cancel).toHaveBeenCalledWith(OPERATION_ID)
    expect(dependencies.relaunch).toHaveBeenCalledOnce()
  })

  it('selects signed-out but refuses to launch the staging-only local profile', async () => {
    const dependencies = createDependencies()
    const actions = new ProfileRecoveryActions(dependencies)

    await actions.selectSignedOut()
    await expect(actions.selectLocal()).rejects.toThrow(/staging-only/)

    expect(dependencies.activePointer.commitPointer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ profileId: 'signed-out' })
    )
    expect(dependencies.registry.ensureLocal).not.toHaveBeenCalled()
    expect(dependencies.prepareProfileRoot).toHaveBeenCalledWith('signed-out')
    expect(dependencies.prepareProfileRoot).not.toHaveBeenCalledWith('abcdef0123456789abcdef0123456789')
  })

  it('exports diagnostics through a fixed no-argument action', async () => {
    const dependencies = createDependencies()
    const actions = new ProfileRecoveryActions(dependencies)

    await expect(actions.exportDiagnostics()).resolves.toEqual({ kind: 'exported' })
    expect(dependencies.exportDiagnostics).toHaveBeenCalledWith()
  })
})
