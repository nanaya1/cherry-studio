import { app, dialog } from 'electron'

import { loggerService } from '@logger'
import type { ShutdownResult } from '@main/core/application/Application'
import { resolveSystemLanguage, t } from '@main/i18n'

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

// MEA:profile-verification-network-tolerance Recovery must outlive a partially destroyed service container.
export function showProfileRecoveryChoice(
  application: Pick<SwitchApplication, 'relaunch' | 'forceExit'>,
  stage: string,
  loadFailure = false
): void {
  // const translate = (key: string, params?: Record<string, string>) =>
  //   t (key, params, resolveSystemLanguage(app.getLocale()))
  const language = resolveSystemLanguage(app.getLocale())
  const response = dialog.showMessageBoxSync({
    type: 'error',
    title: loadFailure
      ? t('dialog.profile_bootstrap.load_failed.title', undefined, language)
      : t('dialog.profile_bootstrap.recovery.title', undefined, language),
    message: loadFailure
      ? t('dialog.profile_bootstrap.load_failed.message', undefined, language)
      : t('dialog.profile_bootstrap.recovery.message', undefined, language),
    detail: t('dialog.profile_bootstrap.recovery.detail', { stage }, language),
    buttons: [
      t('dialog.profile_bootstrap.recovery.restart', undefined, language),
      t('dialog.profile_bootstrap.recovery.quit', undefined, language)
    ],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })
  if (response === 0) application.relaunch()
  else application.forceExit(1)
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
    // const prepared = await this.dependencies.journal.prepare(request)
    let prepared: Awaited<ReturnType<ProfileSwitchJournal['prepare']>>
    try {
      prepared = await this.dependencies.journal.prepare(request)
    } catch {
      this.dependencies.fence.beginSwitch(request.operationId)
      return this.needsRecovery('journal-prepared')
    }
    this.dependencies.fence.beginSwitch(request.operationId)
    if (prepared.durability.kind === 'committed-durability-unknown' && prepared.durability.reason !== 'unsupported') {
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
      // showProfileRecoveryChoice(this.dependencies.application, 'teardown')
      if (targetRecord.kind === 'signed-out') return this.relaunchAfterLogoutTeardownFailure(error)
      showProfileRecoveryChoice(this.dependencies.application, 'teardown')
      return { kind: 'teardown-failed', error: message }
    }
    if (!teardown.clean) {
      this.dependencies.fence.markTeardownFailed('One or more services failed to stop or destroy cleanly')
      // showProfileRecoveryChoice(this.dependencies.application, 'teardown')
      if (targetRecord.kind === 'signed-out') return this.relaunchAfterLogoutTeardownFailure(teardown)
      showProfileRecoveryChoice(this.dependencies.application, 'teardown')
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
        if (
          cancelled.durability.kind === 'committed-durability-unknown' &&
          cancelled.durability.reason !== 'unsupported'
        ) {
          return this.needsRecovery('journal-prepared')
        }
      } catch {
        return this.needsRecovery('journal-prepared')
      }
      this.dependencies.fence.markTeardownFailed(message)
      // Keep the failure visible so an unsuccessful login cannot look like a committed switch.
      // this.dependencies.application.relaunch()
      showProfileRecoveryChoice(this.dependencies.application, 'target-preparation')
      return { kind: 'teardown-failed', error: message }
    }

    let pointer: Awaited<ReturnType<ProfileActivePointer['commitPointer']>>
    try {
      pointer = await this.dependencies.activePointer.commitPointer(committedTarget, request.operationId)
    } catch {
      return this.needsRecovery('active-pointer')
    }
    if (pointer.durability.kind === 'committed-durability-unknown' && pointer.durability.reason !== 'unsupported') {
      return this.needsRecovery('active-pointer')
    }

    let committed: Awaited<ReturnType<ProfileSwitchJournal['commit']>>
    try {
      committed = await this.dependencies.journal.commit(request)
    } catch {
      return this.needsRecovery('journal-committed')
    }
    if (committed.durability.kind === 'committed-durability-unknown' && committed.durability.reason !== 'unsupported') {
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
        // this.dependencies.application.forceExit(1)
        return this.needsRecovery('business-startup')
      }
      return { kind: 'signed-out' }
    }

    // Authenticated target: prefer same-process activation when a hook is wired.
    if (this.dependencies.activateAuthenticated) {
      try {
        const activated = await this.dependencies.activateAuthenticated(committedTarget)
        if (activated) return { kind: 'activated', record: committedTarget }
      } catch (error) {
        // Post-commit startup failure. The credentials are already durable, so a
        // rollback would be wrong — force-exit into business-startup recovery.
        // 必须留下原因：这里只 force-exit(1)，日志里没有异常就无法判断为什么没起来。
        logger.error('Same-process business activation failed; entering business-startup recovery', error as Error)
        return this.needsRecovery('business-startup')
      }
    }
    logger.info('Profile switch committed; requesting application relaunch')
    this.dependencies.application.relaunch()
    return { kind: 'relaunching' }
  }

  // MEA:profile-logout-robustness 仅退出清理失败自动重启；保留持久 logout intent 与关闭的 fence。
  private relaunchAfterLogoutTeardownFailure(error: unknown): ProfileSwitchResult {
    logger.error('Logout teardown failed; automatically relaunching', { error })
    try {
      this.dependencies.application.relaunch()
    } catch (relaunchError) {
      logger.error('Logout relaunch failed; exiting safely', relaunchError as Error)
      this.dependencies.application.forceExit(1)
    }
    return { kind: 'relaunching' }
  }

  private needsRecovery(stage: Extract<ProfileSwitchResult, { kind: 'needs-recovery' }>['stage']): ProfileSwitchResult {
    this.dependencies.fence.markNeedsRecovery(`Profile switch durability is unknown at ${stage}`)
    // this.dependencies.application.forceExit(1)
    showProfileRecoveryChoice(this.dependencies.application, stage)
    return { kind: 'needs-recovery', stage }
  }
}
