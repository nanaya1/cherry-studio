import type { ProfileActivePointer } from './ProfileActivePointer'
import type { ProfileInstallation } from './ProfileInstallation'
import type { ProfileLaunchContext } from './ProfilePrebootCoordinator'
import type { ProfileRegistry } from './ProfileRegistry'
import type { ProfileSwitchJournal } from './ProfileSwitchJournal'

export interface ProfileRecoveryExportResult {
  kind: 'exported' | 'cancelled'
}

export interface ProfileRecoveryActionsDependencies {
  context: ProfileLaunchContext
  journal: Pick<ProfileSwitchJournal, 'read' | 'commit' | 'cancel'>
  registry: Pick<ProfileRegistry, 'read' | 'requireActivatable' | 'ensureLocal'>
  installation: Pick<ProfileInstallation, 'getOrCreate'>
  activePointer: Pick<ProfileActivePointer, 'commitPointer'>
  prepareProfileRoot(profileId: string): Promise<void>
  relaunch(): void
  exportDiagnostics(): Promise<ProfileRecoveryExportResult>
}

export class ProfileRecoveryActions {
  constructor(private readonly dependencies: ProfileRecoveryActionsDependencies) {}

  async retry(): Promise<void> {
    const pending = this.dependencies.context.pendingSwitch
    if (!pending) {
      this.dependencies.relaunch()
      return
    }

    const state = await this.dependencies.journal.read()
    if (state.kind !== 'ok' || state.value.phase !== 'prepared') {
      throw new Error('Prepared profile switch journal not found')
    }
    if (state.value.operationId !== pending.operationId) {
      throw new Error('Profile switch operation does not match recovery context')
    }

    const target = await this.dependencies.registry.requireActivatable(
      state.value.targetProfileId,
      state.value.targetIdentityDigest
    )
    await this.dependencies.prepareProfileRoot(target.profileId)
    const pointer = await this.dependencies.activePointer.commitPointer(target, pending.operationId)
    this.assertDurable(pointer.durability, 'active profile pointer')
    const committed = await this.dependencies.journal.commit({
      operationId: pending.operationId,
      targetProfileId: state.value.targetProfileId,
      targetIdentityDigest: state.value.targetIdentityDigest
    })
    this.assertDurable(committed.durability, 'profile switch journal')
    this.dependencies.relaunch()
  }

  async cancelPendingSwitch(): Promise<void> {
    const pending = this.dependencies.context.pendingSwitch
    if (!pending) throw new Error('No prepared profile switch is pending')
    const cancelled = await this.dependencies.journal.cancel(pending.operationId)
    this.assertDurable(cancelled.durability, 'cancelled profile switch journal')
    this.dependencies.relaunch()
  }

  async selectSignedOut(): Promise<void> {
    const registry = await this.dependencies.registry.read()
    const signedOut = registry.profiles.find((profile) => profile.profileId === 'signed-out')
    if (!signedOut) throw new Error('Signed-out profile is missing')
    await this.activate(signedOut)
  }

  async selectLocal(): Promise<void> {
    // local is staging-only and is no longer a business launch target.
    // The previous entry path is disabled:
    //   const installation = await this.dependencies.installation.getOrCreate()
    //   const local = await this.dependencies.registry.ensureLocal(installation.value.deviceInstallId, 'default')
    //   this.assertDurable(local.durability, 'local profile registry')
    //   await this.activate(local.value)
    throw new Error('Local profile is staging-only and cannot be launched as a business profile')
  }

  exportDiagnostics(): Promise<ProfileRecoveryExportResult> {
    return this.dependencies.exportDiagnostics()
  }

  private async activate(record: Awaited<ReturnType<ProfileRegistry['requireActivatable']>>): Promise<void> {
    await this.dependencies.prepareProfileRoot(record.profileId)
    const pointer = await this.dependencies.activePointer.commitPointer(record)
    this.assertDurable(pointer.durability, 'active profile pointer')
    this.dependencies.relaunch()
  }

  private assertDurable(
    durability: Awaited<ReturnType<ProfileActivePointer['commitPointer']>>['durability'],
    subject: string
  ): void {
    if (durability.kind === 'committed-durability-unknown' && durability.reason !== 'unsupported') {
      throw new Error(`Could not confirm durability for ${subject}: ${durability.error}`)
    }
  }
}
