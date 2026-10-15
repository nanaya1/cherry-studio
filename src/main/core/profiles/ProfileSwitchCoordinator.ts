import { loggerService } from '@logger'
import type { ShutdownResult } from '@main/core/application/Application'

const logger = loggerService.withContext('ProfileSwitchCoordinator')

import type { ProfileActivePointer } from './ProfileActivePointer'
import type { ProfileRecordV1 } from './ProfileSchemas'
import type { PrepareProfileSwitch, ProfileSwitchJournal } from './ProfileSwitchJournal'
import type { SwitchFence } from './SwitchFence'

interface SwitchApplication {
  prepareProfileSwitch(): Promise<ShutdownResult>
  prepareProfileLogout?(): Promise<ShutdownResult>
  relaunch(): void
  forceExit(code: number): void
}

export interface ProfileSwitchCoordinatorDependencies {
  journal: Pick<ProfileSwitchJournal, 'prepare' | 'commit' | 'cancel'>
  activePointer: Pick<ProfileActivePointer, 'commitPointer'>
  fence: SwitchFence
  application: SwitchApplication
  openSignedOut?(record: ProfileRecordV1): Promise<void>
}

export type ProfileSwitchResult =
  | { kind: 'relaunching' }
  | { kind: 'signed-out' }
  | { kind: 'teardown-failed'; teardown: ShutdownResult }
  | { kind: 'teardown-failed'; error: string }
  | {
      kind: 'needs-recovery'
      stage:
        | 'journal-prepared'
        | 'active-pointer'
        | 'journal-committed'
        | 'target-credentials'
        | 'target-authorization'
        | 'logout-quarantine'
        | 'logout-restore'
    }

export interface ProfileSwitchTransition {
  afterTeardown?(): Promise<ProfileRecordV1>
}

export class ProfileSwitchCoordinator {
  constructor(private readonly dependencies: ProfileSwitchCoordinatorDependencies) {}

  async switchProfile(
    request: PrepareProfileSwitch,
    targetRecord: ProfileRecordV1,
    transition: ProfileSwitchTransition = {}
  ): Promise<ProfileSwitchResult> {
    const prepared = await this.dependencies.journal.prepare(request)
    this.dependencies.fence.beginSwitch(request.operationId)
    if (prepared.durability.kind === 'committed-durability-unknown') {
      return this.needsRecovery('journal-prepared')
    }

    let teardown: ShutdownResult
    try {
      teardown =
        targetRecord.kind === 'signed-out' &&
        this.dependencies.openSignedOut &&
        this.dependencies.application.prepareProfileLogout
          ? await this.dependencies.application.prepareProfileLogout()
          : await this.dependencies.application.prepareProfileSwitch()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.dependencies.fence.markTeardownFailed(message)
      return { kind: 'teardown-failed', error: message }
    }
    if (!teardown.clean) {
      this.dependencies.fence.markTeardownFailed('One or more services failed to stop or destroy cleanly')
      return { kind: 'teardown-failed', teardown }
    }

    let committedTarget = targetRecord
    try {
      committedTarget = (await transition.afterTeardown?.()) ?? targetRecord
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Target profile preparation failed; switch was not committed', { error: message })
      try {
        const cancelled = await this.dependencies.journal.cancel(request.operationId)
        if (cancelled.durability.kind === 'committed-durability-unknown') {
          return this.needsRecovery('journal-prepared')
        }
      } catch {
        return this.needsRecovery('journal-prepared')
      }
      this.dependencies.fence.markTeardownFailed(message)
      // Keep the failure visible so an unsuccessful login cannot look like a committed switch.
      // this.dependencies.application.relaunch()
      return { kind: 'teardown-failed', error: message }
    }

    let pointer: Awaited<ReturnType<ProfileActivePointer['commitPointer']>>
    try {
      pointer = await this.dependencies.activePointer.commitPointer(committedTarget, request.operationId)
    } catch {
      return this.needsRecovery('active-pointer')
    }
    if (pointer.durability.kind === 'committed-durability-unknown') {
      return this.needsRecovery('active-pointer')
    }

    let committed: Awaited<ReturnType<ProfileSwitchJournal['commit']>>
    try {
      committed = await this.dependencies.journal.commit(request)
    } catch {
      return this.needsRecovery('journal-committed')
    }
    if (committed.durability.kind === 'committed-durability-unknown') {
      return this.needsRecovery('journal-committed')
    }

    if (committedTarget.kind === 'signed-out' && this.dependencies.openSignedOut) {
      try {
        await this.dependencies.openSignedOut(committedTarget)
      } catch (error) {
        logger.error('Could not open the signed-out window', error as Error)
        this.dependencies.application.forceExit(1)
        throw error
      }
      return { kind: 'signed-out' }
    }
    this.dependencies.application.relaunch()
    return { kind: 'relaunching' }
  }

  private needsRecovery(stage: Extract<ProfileSwitchResult, { kind: 'needs-recovery' }>['stage']): ProfileSwitchResult {
    this.dependencies.fence.markNeedsRecovery(`Profile switch durability is unknown at ${stage}`)
    this.dependencies.application.forceExit(1)
    return { kind: 'needs-recovery', stage }
  }
}
