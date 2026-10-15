import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Shell contract only (the promotion logic and the crash net's journal/aside
 * behavior are covered by restorePromotion.test.ts): the gate never throws —
 * a preboot exception lands in startApp's fail-fast catch — with exactly one
 * exception: when recovery left no live DB while the aside still holds the
 * user's data, booting on would CREATE a fresh empty database, so the gate
 * must refuse and fail fast instead.
 */

const runRestorePromotionMock = vi.fn<() => Promise<void>>()
const markRestoreFailedAfterCrashMock = vi.fn<() => void>()
const isLiveDbStrandedMock = vi.fn<() => boolean>()
const cleanupTerminalRestoreArtifactsMock = vi.fn<() => void>()
const verifyRestoreProfileIdentityMock = vi.fn<() => boolean>()

vi.mock('@data/db/restore/restorePromotion', () => ({
  runRestorePromotion: () => runRestorePromotionMock(),
  markRestoreFailedAfterCrash: () => markRestoreFailedAfterCrashMock(),
  isLiveDbStranded: () => isLiveDbStrandedMock(),
  cleanupTerminalRestoreArtifacts: () => cleanupTerminalRestoreArtifactsMock(),
  verifyRestoreProfileIdentity: () => verifyRestoreProfileIdentityMock()
}))

import { runBackupRestoreGate } from '../backupRestoreGate'

const context = {
  mode: 'business' as const,
  profileId: '1'.repeat(32),
  identityDigest: 'a'.repeat(64),
  kind: 'authenticated' as const,
  dataRoot: '/data/root',
  profileRoot: `/data/root/profiles/${'1'.repeat(32)}`
}

beforeEach(() => {
  runRestorePromotionMock.mockReset()
  markRestoreFailedAfterCrashMock.mockReset()
  isLiveDbStrandedMock.mockReset()
  cleanupTerminalRestoreArtifactsMock.mockReset()
  verifyRestoreProfileIdentityMock.mockReset()
  verifyRestoreProfileIdentityMock.mockReturnValue(true)
  isLiveDbStrandedMock.mockReturnValue(false)
})

describe('runBackupRestoreGate', () => {
  it('runs the legacy promotion path without requiring a profile launch context', async () => {
    runRestorePromotionMock.mockResolvedValue(undefined)

    await expect(runBackupRestoreGate()).resolves.toBeUndefined()

    expect(verifyRestoreProfileIdentityMock).not.toHaveBeenCalled()
    expect(runRestorePromotionMock).toHaveBeenCalledOnce()
  })

  it('delegates to the promotion logic and skips the crash net on success', async () => {
    runRestorePromotionMock.mockResolvedValue(undefined)

    await expect(runBackupRestoreGate(context)).resolves.toBeUndefined()

    expect(runRestorePromotionMock).toHaveBeenCalledOnce()
    expect(markRestoreFailedAfterCrashMock).not.toHaveBeenCalled()
    expect(isLiveDbStrandedMock).not.toHaveBeenCalled()
    expect(cleanupTerminalRestoreArtifactsMock).toHaveBeenCalledOnce()
  })

  it('refuses promotion when the restore marker belongs to another profile', async () => {
    verifyRestoreProfileIdentityMock.mockReturnValue(false)

    await expect(runBackupRestoreGate(context)).resolves.toBeUndefined()

    expect(runRestorePromotionMock).not.toHaveBeenCalled()
    expect(cleanupTerminalRestoreArtifactsMock).toHaveBeenCalledOnce()
  })

  it('swallows a substance crash and invokes the crash net', async () => {
    runRestorePromotionMock.mockRejectedValue(new Error('boom'))

    await expect(runBackupRestoreGate(context)).resolves.toBeUndefined()

    expect(markRestoreFailedAfterCrashMock).toHaveBeenCalledOnce()
    expect(cleanupTerminalRestoreArtifactsMock).toHaveBeenCalledOnce()
  })

  it('never throws on a crash-net failure while the live DB survived', async () => {
    runRestorePromotionMock.mockRejectedValue(new Error('boom'))
    markRestoreFailedAfterCrashMock.mockImplementation(() => {
      throw new Error('disk full')
    })

    await expect(runBackupRestoreGate(context)).resolves.toBeUndefined()
    expect(cleanupTerminalRestoreArtifactsMock).toHaveBeenCalledOnce()
  })

  it('refuses to boot when recovery left the live DB stranded in the aside', async () => {
    runRestorePromotionMock.mockRejectedValue(new Error('boom'))
    isLiveDbStrandedMock.mockReturnValue(true)

    // Booting on would create a fresh empty database while the user's data
    // sits in the aside — the one case worse than the fail-fast dialog.
    await expect(runBackupRestoreGate(context)).rejects.toThrow(/empty database/)
    expect(cleanupTerminalRestoreArtifactsMock).not.toHaveBeenCalled()
  })

  it('refuses to boot when the crash net itself failed and the live DB is stranded', async () => {
    runRestorePromotionMock.mockRejectedValue(new Error('boom'))
    markRestoreFailedAfterCrashMock.mockImplementation(() => {
      throw new Error('EBUSY: aside rename blocked')
    })
    isLiveDbStrandedMock.mockReturnValue(true)

    await expect(runBackupRestoreGate(context)).rejects.toThrow(/empty database/)
    expect(cleanupTerminalRestoreArtifactsMock).not.toHaveBeenCalled()
  })
})
