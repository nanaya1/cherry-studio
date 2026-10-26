import fs from 'node:fs'
import path from 'node:path'

import { electronApp } from '@electron-toolkit/utils'
import { app, dialog } from 'electron'

import { application } from '@application'
import { loggerService } from '@logger'
import { runBackupRestoreGate } from '@main/core/preboot/backupRestoreGate'
import { BrandDataFileMigrationError, migrateBrandDataFiles } from '@main/core/preboot/brandDataFileMigration'
import {
  applyProfileIsolationPaths,
  type ProfileIsolationElectronApi
} from '@main/core/preboot/profileIsolationPreboot'
import {
  buildSignedOutLaunchContext,
  markProfileBootSuccessful,
  migrateProfileSensitiveData,
  verifyBusinessCandidate
} from '@main/core/preboot/profileIsolationRuntime'
import { runV2MigrationGate } from '@main/core/preboot/v2MigrationGate'
// Static import disabled: serviceRegistry imports the profiles barrel, which can
// observe uninitialized service classes while this module is loaded from it.
// import { getServiceListForProfileMode, serviceList } from '@main/core/application/serviceRegistry'
import { runDataReset } from '@main/services/dataReset'
import { runUserDataRelocation } from '@main/services/userDataRelocation'
import { getApplicationId } from '@main/utils/appEdition'

import { registerIpc } from '../../ipc'
import { versionService } from '../../services/VersionService'
// Avoid the profiles barrel here: it exports ProfileBootstrapWindow, which imports
// this module and would create an initialization cycle through serviceRegistry.
import { ProfileActivePointer } from './ProfileActivePointer'
import { createProfileBootstrapWindow } from './ProfileBootstrapWindow'
import { createProfilePaths, resolveProfileRoot, validateExistingProfilePath } from './ProfilePaths'
import type { ProfileLaunchContext } from './ProfilePrebootCoordinator'
import { ProfileRegistry, SIGNED_OUT_DIGEST } from './ProfileRegistry'
import { setProfileLaunchContext } from './ProfileRuntimeContext'
import { profileBusinessAccessGate } from './ProfileRuntimeContext'
import type { ProfileRecordV1 } from './ProfileSchemas'
import { profileSwitchFence } from './SwitchFence'

const logger = loggerService.withContext('BusinessStartup')

/**
 * Electron surface used by the profile-isolation path setup. `freezePathRegistry`
 * rebuilds the runtime in place (prepareProfileRuntime) so a same-process
 * business start and a cold start share one code path without double-init.
 */
const electronPrebootApi = (): ProfileIsolationElectronApi => ({
  setPath: (name, value) => app.setPath(name, value),
  setAppLogsPath: (value) => app.setAppLogsPath(value),
  mkdirSync: (value, options) => fs.mkdirSync(value, options),
  acquireDataRootLock: () => true,
  requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
  rebindLogger: (logsDir: string) => loggerService.rebind(logsDir),
  freezePathRegistry: () => application.prepareProfileRuntime()
})

/**
 * Build the business launch context for an authenticated record. The control
 * plane (dataRoot) is shared with the login window; the profile root is derived
 * from the record, so a different account resolves to a different disk root.
 */
export function buildBusinessLaunchContext(dataRoot: string, record: ProfileRecordV1): ProfileLaunchContext {
  const paths = createProfilePaths(dataRoot)
  return {
    mode: 'business',
    profileId: record.profileId,
    identityDigest: record.identityDigest,
    kind: record.kind,
    dataRoot: paths.dataRoot,
    profileRoot: resolveProfileRoot(paths, record.profileId)
  }
}

export interface StartBusinessRuntimeOptions {
  /**
   * Re-apply the isolation paths and rebuild the runtime. `true` for a
   * same-process activation (the teardown already ran); `false` for a cold start
   * where `initializeLockedProfileIsolation` already applied them.
   */
  rebuildRuntime?: boolean
  /**
   * On a failed online re-verify: `recovery-window` opens the recovery window and
   * returns (cold start); `throw` aborts so the coordinator can force-exit into
   * business-startup recovery (same-process activation).
   */
  onVerifyFailure?: 'recovery-window' | 'throw'
  onBusinessReady?: () => void
}

/**
 * Shared business startup sequence used by both cold start and the same-process
 * activation. Re-runs the preboot gates and lifecycle bootstrap for the given
 * launch context, opening the main window in the current process.
 */
export async function startBusinessRuntime(
  context: ProfileLaunchContext | undefined,
  options: StartBusinessRuntimeOptions = {}
): Promise<void> {
  if (options.rebuildRuntime) {
    // Rebuilds the runtime in place (no separate init) via prepareProfileRuntime.
    applyProfileIsolationPaths(context as ProfileLaunchContext, electronPrebootApi())
    logger.info('Rebuilt profile runtime for same-process business start')
  }

  setProfileLaunchContext(context)

  if (context?.mode === 'business') {
    const verification = await verifyBusinessCandidate(context)
    if (verification.kind !== 'verified') {
      if (options.onVerifyFailure === 'throw') {
        throw new Error(`Business candidate failed startup verification: ${verification.reason}`)
      }
      // 登录校验失败转入独立登录空间，原恢复入口保留供控制状态故障使用。
      // setProfileLaunchContext(verification.failureContext)
      // createProfileBootstrapWindow(verification.failureContext)
      const signedOut = {
        ...buildSignedOutLaunchContext(context.dataRoot),
        ...(context.legacyRoot ? { legacyRoot: context.legacyRoot } : {})
      }
      const paths = createProfilePaths(context.dataRoot)
      try {
        await validateExistingProfilePath(paths, signedOut.profileRoot)
        const registry = new ProfileRegistry(path.join(paths.controlRoot, 'profiles.json'))
        const record = await registry.requireActivatable('signed-out', SIGNED_OUT_DIGEST)
        const pointer = new ProfileActivePointer(path.join(paths.controlRoot, 'active-profile.json'), registry)
        const selected = await pointer.commitPointer(record)
        if (selected.durability.kind !== 'committed-confirmed') throw new Error('Signed-out selection is not durable')
      } catch {
        setProfileLaunchContext(verification.failureContext)
        createProfileBootstrapWindow(verification.failureContext)
        return
      }
      applyProfileIsolationPaths(signedOut, electronPrebootApi())
      setProfileLaunchContext(signedOut)
      logger.info('Startup identity verification failed; returning to login', { reason: verification.reason })
      createProfileBootstrapWindow(signedOut)
      return
    }
    profileBusinessAccessGate.recordVerificationSuccess()
    if (options.rebuildRuntime && profileSwitchFence.state.kind !== 'open') {
      profileSwitchFence.reopenAfterTeardown()
    }
  }

  // Import legacy device-level sensitive data before reset, backup, migration,
  // or services open the selected profile. Authenticated profiles never auto-import.
  if (context?.mode === 'business') await migrateProfileSensitiveData(context)

  // Keep the legacy preboot ordering: reset before backup/migration, relocation
  // before the v2 migration gate reads the DB.
  // Reset before backup, migration, or services open user data.
  runDataReset()

  // Legacy userData relocation is retained for launches outside profile-aware
  // dataRoot relocation and for existing pending requests.
  // userData relocation: a pending/failed relocation makes this a dedicated
  // relocation launch (execute or explain, then relaunch) before any service
  // opens files under the source tree. See services/userDataRelocation/README.md.
  const relocationResult = await runUserDataRelocation()
  if (relocationResult === 'handled') {
    if (options.rebuildRuntime) throw new Error('Business startup was taken over by relocation')
    return
  }

  // The current profile must use branded filenames before restore inspects its DB.
  // The v2 gate repeats this after any legacy custom userData redirect; both calls are idempotent.
  try {
    migrateBrandDataFiles(application.getPath('app.userdata'))
  } catch (error) {
    if (!(error instanceof BrandDataFileMigrationError)) throw error
    await app.whenReady()
    dialog.showErrorBox(
      'Data File Migration Error - Application Cannot Start',
      `Could not migrate existing data files to the MEA Cowork names:\n\n  ${error.message}\n\n` +
        'No existing file was overwritten. Please keep both files and contact support before trying again. The application will now exit.'
    )
    application.quit()
    return
  }

  // Backup-restore gate: swap in a staged restored DB (if any) before the v2
  // migration gate reads the DB. Never throws; on any failure the old DB
  // stays live and the app starts normally.
  await runBackupRestoreGate(context)
  // 'handled' = migration window took over OR fatal error already quit the app.
  const migrationResult = await runV2MigrationGate()
  if (migrationResult === 'handled') {
    if (options.rebuildRuntime) throw new Error('Business startup was taken over by migration')
    return
  }

  // Set the Windows AppUserModelID — the identity Windows uses to attribute this
  // app's notifications, taskbar icon grouping, and Jump Lists (no-op on macOS/Linux).
  // Must run before any window is created or notification fires, hence after the
  // migration gate returns and before lifecycle bootstrap.
  electronApp.setAppUserModelId(getApplicationId())

  const { getServiceListForProfileMode, serviceList } = await import('@main/core/application/serviceRegistry')
  application.registerAll(context ? getServiceListForProfileMode(context.mode) : serviceList)
  // Start lifecycle (BeforeReady runs parallel with app.whenReady)
  const bootstrapPromise = application.bootstrap()

  await app.whenReady()
  // Wait for lifecycle bootstrap (all core services are now ready)
  const bootstrapSuccessful = await bootstrapPromise
  if (!bootstrapSuccessful) {
    if (options.onVerifyFailure === 'throw') throw new Error('Business bootstrap failed')
    return
  }

  // Record current version for upgrade-path tracking
  versionService.recordCurrentVersion()

  // Legacy monolithic IPC registration — causes timing coupling between
  // bootstrap and IPC readiness. TODO(v2): decompose into per-service
  // ipcHandle/ipcOn inside lifecycle services.
  // registerIpc carries a process-level once guard; the second call (e.g. a
  // same-process activation) is a no-op, so handlers keep referencing the live
  // direct-import singletons rather than stale destroyed instances.
  await registerIpc()
  if (context?.mode === 'business') await markProfileBootSuccessful(context)
  options.onBusinessReady?.()
}
