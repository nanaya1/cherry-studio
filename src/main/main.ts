/**
 * Electron main-process entry — preboot → bootstrap → running.
 *
 * DO NOT add new code here. If you feel the need to, you almost certainly
 * misunderstand the startup timing or service architecture. New services
 * belong in the lifecycle system (see core/lifecycle/); non-removable
 * preboot steps belong in core/preboot/; removable capabilities that must
 * execute at preboot time belong in their nature-home (e.g. services/)
 * and are invoked from here. This file is glue — it should only shrink.
 */

// BootConfig must load before any other import (configures userData path)

import '@main/data/bootConfig'
import { application } from '@application'
import { getServiceListForProfileMode, serviceList } from '@main/core/application/serviceRegistry'
// Preboot phase — order matters. See core/preboot/README.md.
import { runBackupRestoreGate } from '@main/core/preboot/backupRestoreGate'
import { configureChromiumFlags } from '@main/core/preboot/chromiumFlags'
import { initCrashTelemetry } from '@main/core/preboot/crashTelemetry'
import {
  initializeLockedProfileIsolation,
  lockCurrentProfileDataRoot,
  markProfileBootSuccessful,
  migrateProfileSensitiveData,
  resolveCurrentProfileDataRoot,
  shouldUseProfileIsolation,
  verifyBusinessCandidate
} from '@main/core/preboot/profileIsolationRuntime'
import { requireSingleInstance } from '@main/core/preboot/singleInstance'
import { resolveUserDataLocation } from '@main/core/preboot/userDataLocation'
import { runV2MigrationGate } from '@main/core/preboot/v2MigrationGate'
import {
  createProfileBootstrapWindow,
  setProfileLaunchContext,
  profileBusinessAccessGate,
  type ProfileLaunchContext
} from '@main/core/profiles'
import { MINI_APP_SCHEME_DECLARATION } from '@main/features/miniApp/runtime/protocol'
import { runDataReset } from '@main/services/dataReset'
import { runDataRootRelocation } from '@main/services/dataRootRelocation'
import { CHERRY_MEDIA_SCHEME_DECLARATION } from '@main/services/mediaProtocol'
import { runProfileDataResetPreboot } from '@main/services/profileDataReset'
import { initSentry } from '@main/services/sentry'
import { runUserDataRelocation } from '@main/services/userDataRelocation'
import { getApplicationId } from '@main/utils/appEdition'

const profileIsolationEnabled = shouldUseProfileIsolation()
let profileLaunchContext: ProfileLaunchContext | undefined

// Resolve the configured dataRoot before either legacy or profile-aware locking.
// The legacy startup path is retained while profile isolation is gated by BootConfig.
resolveUserDataLocation()
if (!profileIsolationEnabled) requireSingleInstance()
// Privileged schemes must be declared before the app is ready, and only ONCE per
// process — startApp() itself awaits app.whenReady(), so this cannot move in there.
protocol.registerSchemesAsPrivileged([CHERRY_MEDIA_SCHEME_DECLARATION, MINI_APP_SCHEME_DECLARATION])
// Legacy path-registry freeze retained for launches outside profile isolation.
if (!profileIsolationEnabled) application.initPathRegistry()

import { electronApp } from '@electron-toolkit/utils'
import { app, protocol } from 'electron'

import { loggerService } from '@logger'

import { registerIpc } from './ipc'
import { versionService } from './services/VersionService'

const logger = loggerService.withContext('MainEntry')

const startApp = async () => {
  if (profileIsolationEnabled) {
    const legacyUserData = app.getPath('userData')
    const dataRoot = resolveCurrentProfileDataRoot(legacyUserData)
    if (!lockCurrentProfileDataRoot(dataRoot)) {
      application.quit()
      return
    }
    const dataRootRelocationResult = await runDataRootRelocation()
    if (dataRootRelocationResult === 'handled') {
      application.relaunch()
      return
    }
    const profileResetResult = await runProfileDataResetPreboot(dataRoot)
    if (profileResetResult === 'handled') {
      application.relaunch()
      return
    }
    profileLaunchContext = await initializeLockedProfileIsolation(legacyUserData, dataRoot)
    setProfileLaunchContext(profileLaunchContext)
    if (!profileLaunchContext) {
      application.quit()
      return
    }
    if (profileLaunchContext.mode !== 'business') {
      configureChromiumFlags()
      initCrashTelemetry()
      initSentry()
      await app.whenReady()
      createProfileBootstrapWindow(profileLaunchContext)
      return
    }

    // [startup-verify] A non-empty active pointer only yields a *candidate*.
    // Verify it online before any business service registers; else recover.
    configureChromiumFlags()
    initCrashTelemetry()
    initSentry()
    await app.whenReady()
    const verification = await verifyBusinessCandidate(profileLaunchContext)
    if (verification.kind !== 'verified') {
      logger.warn('business candidate failed startup verification; routing to recovery window', {
        reason: verification.reason
      })
      setProfileLaunchContext(verification.failureContext)
      createProfileBootstrapWindow(verification.failureContext)
      return
    }
    profileBusinessAccessGate.recordVerificationSuccess()
  }

  // MEA:profile-online-login Profile launches configure Electron before online verification waits for ready.
  if (!profileIsolationEnabled) {
    configureChromiumFlags()
    initCrashTelemetry()
    initSentry()
  }

  // Import legacy device-level sensitive data before reset, backup, migration,
  // or services open the selected profile. Authenticated profiles never auto-import.
  if (profileLaunchContext) await migrateProfileSensitiveData(profileLaunchContext)

  // Reset before backup, migration, or services open user data.
  runDataReset()

  // Legacy userData relocation is retained for launches outside profile-aware
  // dataRoot relocation and for existing pending requests.
  // userData relocation: a pending/failed relocation makes this a dedicated
  // relocation launch (execute or explain, then relaunch) before any service
  // opens files under the source tree. See services/userDataRelocation/README.md.
  const relocationResult = await runUserDataRelocation()
  if (relocationResult === 'handled') return

  // Backup-restore gate: swap in a staged restored DB (if any) before the v2
  // migration gate reads the DB. Never throws; on any failure the old DB
  // stays live and the app starts normally.
  await runBackupRestoreGate(profileLaunchContext)

  // 'handled' = migration window took over OR fatal error already quit the app.
  const migrationResult = await runV2MigrationGate()
  if (migrationResult === 'handled') return

  // Set the Windows AppUserModelID — the identity Windows uses to attribute this
  // app's notifications, taskbar icon grouping, and Jump Lists (no-op on macOS/Linux).
  // Must run before any window is created or notification fires, hence after the
  // migration gate returns and before lifecycle bootstrap.
  electronApp.setAppUserModelId(getApplicationId())

  // Start lifecycle (BeforeReady runs parallel with app.whenReady)
  application.registerAll(profileLaunchContext ? getServiceListForProfileMode(profileLaunchContext.mode) : serviceList)
  const bootstrapPromise = application.bootstrap()

  await app.whenReady()
  // Wait for lifecycle bootstrap (all core services are now ready)
  const bootstrapSuccessful = await bootstrapPromise
  if (!bootstrapSuccessful) return

  // Record current version for upgrade-path tracking
  versionService.recordCurrentVersion()

  // Legacy monolithic IPC registration — causes timing coupling between
  // bootstrap and IPC readiness. TODO(v2): decompose into per-service
  // ipcHandle/ipcOn inside lifecycle services.
  await registerIpc()
  if (profileLaunchContext) await markProfileBootSuccessful(profileLaunchContext)
}

// Top-level safety net: bootstrap() handles known fatal errors internally
// (ServiceInitError → dialog → exit/relaunch), so this catch only fires
// for unexpected errors that escape the normal handling path.
startApp().catch((error) => {
  logger.error('Fatal startup error:', error)
  application.forceExit(1)
})
