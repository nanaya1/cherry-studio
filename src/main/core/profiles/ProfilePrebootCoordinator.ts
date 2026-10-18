import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { ProfileActivePointer } from './ProfileActivePointer'
import { ProfileBootJournal } from './ProfileBootJournal'
import { ProfileClaimService } from './ProfileClaimService'
import { ProfileInstallation } from './ProfileInstallation'
import { ProfileLogoutIntent } from './ProfileLogoutIntent'
import { createProfilePaths, resolveProfileRoot, validateExistingProfilePath } from './ProfilePaths'
import { ProfileRegistry, SIGNED_OUT_DIGEST } from './ProfileRegistry'
import type { ProfileRecordV1 } from './ProfileSchemas'
import { ProfileSwitchJournal } from './ProfileSwitchJournal'

export type ProfileLaunchMode = 'business' | 'signed-out' | 'migration-required' | 'recovery'
export type ProfileRecoveryReason =
  | 'corrupt-control-plane'
  | 'invalid-profile-path'
  | 'consecutive-boot-failures'
  | 'profile-switch-mismatch'

export interface PendingProfileSwitch {
  operationId: string
  action: 'retry-or-cancel'
}

export interface ProfileLaunchContext {
  mode: ProfileLaunchMode
  profileId: string
  identityDigest: string
  kind: ProfileRecordV1['kind']
  dataRoot: string
  profileRoot: string
  recoveryReason?: ProfileRecoveryReason
  pendingSwitch?: PendingProfileSwitch
  legacyRoot?: string
}

export interface ProfilePrebootCoordinatorOptions {
  dataRoot: string
  legacyRoot?: string
  legacyDataExists: () => Promise<boolean>
  cleanupCommittedSource?: (profileRoot: string) => Promise<void>
}

export class ProfilePrebootCoordinator {
  private legacyRoot: string | undefined

  constructor(private readonly options: ProfilePrebootCoordinatorOptions) {}

  async initialize(): Promise<ProfileLaunchContext> {
    const paths = createProfilePaths(this.options.dataRoot)
    await mkdir(paths.controlRoot, { recursive: true })
    this.legacyRoot = (await this.options.legacyDataExists()) ? this.options.legacyRoot : undefined

    const installation = new ProfileInstallation(path.join(paths.controlRoot, 'installation.json'))
    const registry = new ProfileRegistry(path.join(paths.controlRoot, 'profiles.json'))
    const activePointer = new ProfileActivePointer(path.join(paths.controlRoot, 'active-profile.json'), registry)
    const bootJournal = new ProfileBootJournal(path.join(paths.controlRoot, 'boot-journal.json'))
    const switchJournal = new ProfileSwitchJournal(path.join(paths.controlRoot, 'switch-journal.json'))

    try {
      await installation.getOrCreate()
      const registryState = await registry.initialize()
      const logoutIntent = new ProfileLogoutIntent(path.join(paths.controlRoot, 'logout-intent.json'))
      const logout = await logoutIntent.read()
      if (logout.kind === 'corrupt') return this.recoveryContext('corrupt-control-plane')
      if (logout.kind === 'ok' && logout.value) {
        const signedOut = await registry.requireActivatable('signed-out', SIGNED_OUT_DIGEST)
        await this.validateProfileRoot(paths, signedOut.profileId)
        const journal = await switchJournal.read()
        if (journal.kind === 'corrupt') return this.recoveryContext('corrupt-control-plane')
        if (journal.kind === 'ok' && journal.value.phase === 'prepared') {
          const cancelled = await switchJournal.cancel(journal.value.operationId)
          if (
            cancelled.durability.kind === 'committed-durability-unknown' &&
            cancelled.durability.reason !== 'unsupported'
          ) {
            return this.recoveryContext('corrupt-control-plane')
          }
        }
        const request = {
          operationId: logout.value.operationId,
          fromProfileId: logout.value.sourceProfileId,
          targetProfileId: signedOut.profileId,
          targetIdentityDigest: signedOut.identityDigest
        }
        const prepared = await switchJournal.prepare(request)
        if (
          prepared.durability.kind === 'committed-durability-unknown' &&
          prepared.durability.reason !== 'unsupported'
        ) {
          return this.recoveryContext('corrupt-control-plane')
        }
        const selected = await activePointer.commitPointer(signedOut, request.operationId)
        if (
          selected.durability.kind === 'committed-durability-unknown' &&
          selected.durability.reason !== 'unsupported'
        ) {
          return this.recoveryContext('corrupt-control-plane')
        }
        const committed = await switchJournal.commit(request)
        if (
          committed.durability.kind === 'committed-durability-unknown' &&
          committed.durability.reason !== 'unsupported'
        ) {
          return this.recoveryContext('corrupt-control-plane')
        }
        await this.cleanupCommittedSource(switchJournal, await activePointer.read(), paths)
        await logoutIntent.complete()
        return this.context('signed-out', signedOut)
      }
      const pointer = await activePointer.read()

      if (pointer.kind === 'corrupt') return this.recoveryContext('corrupt-control-plane')
      const switchRecovery = await this.reconcileSwitchJournal(switchJournal, pointer)
      if (switchRecovery.kind === 'mismatch') return this.recoveryContext('profile-switch-mismatch')
      await this.cleanupCommittedSource(switchJournal, pointer, paths)
      if (pointer.kind === 'none') {
        // 旧数据迁移延后到首次认证成功后确认，避免在登录前阻断用户。
        // if (await this.options.legacyDataExists()) return this.bootstrapContext('migration-required')
        const signedOut = registryState.value.profiles.find((profile) => profile.profileId === 'signed-out')
        if (!signedOut) return this.recoveryContext('corrupt-control-plane')
        await this.validateProfileRoot(paths, signedOut.profileId)
        await activePointer.commitPointer(signedOut)
        return this.context('signed-out', signedOut)
      }

      if (pointer.record.kind === 'signed-out') {
        await this.validateProfileRoot(paths, pointer.record.profileId)
        return this.context('signed-out', pointer.record, undefined, switchRecovery.pendingSwitch)
      }

      if (pointer.record.kind === 'local') {
        // MEA:profile-online-login Adoption keeps the legacy source; a staged local record proceeds to login.
        const signedOut = registryState.value.profiles.find((profile) => profile.profileId === 'signed-out')
        if (!signedOut) return this.recoveryContext('corrupt-control-plane')
        await this.validateProfileRoot(paths, signedOut.profileId)
        if (switchRecovery.pendingSwitch) {
          return this.context('signed-out', signedOut, undefined, switchRecovery.pendingSwitch)
        }
        const selected = await activePointer.commitPointer(signedOut)
        if (
          selected.durability.kind === 'committed-durability-unknown' &&
          selected.durability.reason !== 'unsupported'
        ) {
          return this.recoveryContext('corrupt-control-plane')
        }
        return this.context('signed-out', signedOut)
      }

      if (this.legacyRoot) {
        const claim = new ProfileClaimService({
          localUserData: this.legacyRoot,
          targetUserData: path.join(resolveProfileRoot(paths, pointer.record.profileId), 'userData'),
          journalPath: path.join(paths.controlRoot, 'legacy-claim.json')
        })
        const preview = await claim.preview()
        if (preview.status === 'staged') await claim.commit()
      }

      await bootJournal.beginAttempt(pointer.record.profileId)
      const recoveryDecision = await bootJournal.getRecoveryDecision(pointer.record.profileId)
      if (recoveryDecision.recover) return this.recoveryContext('consecutive-boot-failures')

      await this.validateProfileRoot(paths, pointer.record.profileId)
      return this.context('business', pointer.record)
    } catch (error) {
      if (this.isInvalidProfilePathError(error)) return this.recoveryContext('invalid-profile-path')
      return this.recoveryContext('corrupt-control-plane')
    }
  }

  private context(
    mode: ProfileLaunchMode,
    profile: ProfileRecordV1,
    recoveryReason?: ProfileRecoveryReason,
    pendingSwitch?: PendingProfileSwitch
  ): ProfileLaunchContext {
    const paths = createProfilePaths(this.options.dataRoot)
    return {
      mode,
      profileId: profile.profileId,
      identityDigest: profile.identityDigest,
      kind: profile.kind,
      dataRoot: paths.dataRoot,
      profileRoot: resolveProfileRoot(paths, profile.profileId),
      ...(recoveryReason ? { recoveryReason } : {}),
      ...(pendingSwitch ? { pendingSwitch } : {}),
      ...(this.legacyRoot ? { legacyRoot: this.legacyRoot } : {})
    }
  }

  private bootstrapContext(
    mode: 'migration-required' | 'recovery',
    recoveryReason?: ProfileRecoveryReason
  ): ProfileLaunchContext {
    const paths = createProfilePaths(this.options.dataRoot)
    return {
      mode,
      profileId: 'signed-out',
      identityDigest: SIGNED_OUT_DIGEST,
      kind: 'signed-out',
      dataRoot: paths.dataRoot,
      profileRoot: path.join(paths.controlRoot, 'recovery-profile'),
      ...(mode === 'migration-required' && this.options.legacyRoot ? { legacyRoot: this.options.legacyRoot } : {}),
      ...(recoveryReason ? { recoveryReason } : {})
    }
  }

  private recoveryContext(recoveryReason: ProfileRecoveryReason): ProfileLaunchContext {
    return this.bootstrapContext('recovery', recoveryReason)
  }

  private async reconcileSwitchJournal(
    journal: ProfileSwitchJournal,
    pointer: Awaited<ReturnType<ProfileActivePointer['read']>>
  ): Promise<{ kind: 'ok'; pendingSwitch?: PendingProfileSwitch } | { kind: 'mismatch' }> {
    const state = await journal.read()
    if (state.kind === 'none') return { kind: 'ok' }
    if (state.kind === 'corrupt')
      throw new Error(`Profile switch journal is corrupt at ${state.filePath}: ${state.error}`)
    if (state.value.phase === 'committed') return { kind: 'ok' }
    if (pointer.kind !== 'ok') return { kind: 'ok', pendingSwitch: this.pendingSwitch(state.value.operationId) }

    const targetMatches =
      pointer.value.profileId === state.value.targetProfileId &&
      pointer.value.identityDigest === state.value.targetIdentityDigest
    if (targetMatches) {
      if (pointer.value.operationId !== state.value.operationId) return { kind: 'mismatch' }
      const committed = await journal.commit(state.value)
      if (
        committed.durability.kind === 'committed-durability-unknown' &&
        committed.durability.reason !== 'unsupported'
      ) {
        return { kind: 'mismatch' }
      }
      return { kind: 'ok' }
    }

    if (pointer.value.profileId !== state.value.fromProfileId) return { kind: 'mismatch' }
    return { kind: 'ok', pendingSwitch: this.pendingSwitch(state.value.operationId) }
  }

  private async cleanupCommittedSource(
    journal: ProfileSwitchJournal,
    pointer: Awaited<ReturnType<ProfileActivePointer['read']>>,
    paths: ReturnType<typeof createProfilePaths>
  ): Promise<void> {
    if (!this.options.cleanupCommittedSource || pointer.kind !== 'ok') return
    const state = await journal.read()
    if (
      state.kind !== 'ok' ||
      state.value.phase !== 'committed' ||
      state.value.operationId !== pointer.value.operationId ||
      state.value.targetProfileId !== pointer.value.profileId ||
      state.value.targetIdentityDigest !== pointer.value.identityDigest ||
      state.value.fromProfileId === pointer.value.profileId
    ) {
      return
    }
    const sourceRoot = resolveProfileRoot(paths, state.value.fromProfileId)
    await validateExistingProfilePath(paths, sourceRoot)
    await this.options.cleanupCommittedSource(sourceRoot)
  }

  private pendingSwitch(operationId: string): PendingProfileSwitch {
    return { operationId, action: 'retry-or-cancel' }
  }

  private async validateProfileRoot(paths: ReturnType<typeof createProfilePaths>, profileId: string): Promise<void> {
    await mkdir(paths.profilesRoot, { recursive: true })
    await validateExistingProfilePath(paths, resolveProfileRoot(paths, profileId))
  }

  private isInvalidProfilePathError(error: unknown): boolean {
    return error instanceof Error && /profile root|symbolic link|canonical|profiles root/i.test(error.message)
  }
}
