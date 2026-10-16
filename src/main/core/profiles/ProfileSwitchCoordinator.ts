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
  /**
   * Optional same-process activation hook, invoked only after the journal and
   * `afterCommit` both succeed for an authenticated target. Return `true` to open
   * the business runtime in the current process (no relaunch); `false` falls back
   * to a relaunch. Any throw here is a post-commit startup failure: it must NOT
   * reach `ProfileSessionService` (which would roll back the now-durable
   * credentials) — the coordinator force-exits into the `business-startup`
   * recovery stage instead.
   */
  activateAuthenticated?(record: ProfileRecordV1): Promise<boolean>
}

export type ProfileSwitchResult =
  | { kind: 'relaunching' }
  | { kind: 'signed-out' }
  | { kind: 'activated'; record: ProfileRecordV1 }
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
        | 'business-startup'
    }

export interface ProfileSwitchTransition {
  afterTeardown?(): Promise<ProfileRecordV1>
  afterCommit?(): Promise<void>
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

    try {
      await transition.afterCommit?.()
    } catch {
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

    // Authenticated target: prefer same-process activation when a hook is wired.
    if (this.dependencies.activateAuthenticated) {
      try {
        const activated = await this.dependencies.activateAuthenticated(committedTarget)
        if (activated) return { kind: 'activated', record: committedTarget }
      } catch {
        // Post-commit startup failure. The credentials are already durable, so a
        // rollback would be wrong — force-exit into business-startup recovery.
        return this.needsRecovery('business-startup')
      }
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
