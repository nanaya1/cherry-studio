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
// Preboot phase — order matters. See core/preboot/README.md.
import { configureChromiumFlags } from '@main/core/preboot/chromiumFlags'
import { initCrashTelemetry } from '@main/core/preboot/crashTelemetry'
import {
  initializeLockedProfileIsolation,
  lockCurrentProfileDataRoot,
  resolveCurrentProfileDataRoot,
  shouldUseProfileIsolation
} from '@main/core/preboot/profileIsolationRuntime'
import { requireSingleInstance } from '@main/core/preboot/singleInstance'
import { resolveUserDataLocation } from '@main/core/preboot/userDataLocation'
import { createProfileBootstrapWindow, setProfileLaunchContext, type ProfileLaunchContext } from '@main/core/profiles'
// eslint-disable-next-line barrel/closed -- 启动模块不能经 profiles barrel 提前加载服务注册表。
import { startBusinessRuntime } from '@main/core/profiles/businessStartup'
import { MINI_APP_SCHEME_DECLARATION } from '@main/features/miniApp/runtime/protocol'
import { runDataRootRelocation } from '@main/services/dataRootRelocation'
import { CHERRY_MEDIA_SCHEME_DECLARATION } from '@main/services/mediaProtocol'
import { runProfileDataResetPreboot } from '@main/services/profileDataReset'
import { initSentry } from '@main/services/sentry'

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

import { app, protocol } from 'electron'

import { loggerService } from '@logger'

const logger = loggerService.withContext('MainEntry')

const startApp = async () => {
  // Register Sentry before asynchronous profile work can let Electron emit ready.
  initSentry()
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
      // initSentry() — initialized before asynchronous profile resolution.
      await app.whenReady()
      createProfileBootstrapWindow(profileLaunchContext)
      return
    }

    // [startup-verify] A non-empty active pointer only yields a *candidate*.
    // Verify it online before any business service registers; else recover.
    configureChromiumFlags()
    initCrashTelemetry()
    // initSentry() — initialized before asynchronous profile resolution.
    await app.whenReady()
    // 在线校验与业务服务启动统一由 startBusinessRuntime 执行。
  }

  // MEA:profile-online-login Profile launches configure Electron before online verification waits for ready.
  if (!profileIsolationEnabled) {
    configureChromiumFlags()
    initCrashTelemetry()
    // initSentry() — initialized before asynchronous profile resolution.
  }

  await startBusinessRuntime(profileLaunchContext)
}

// Top-level safety net: bootstrap() handles known fatal errors internally
// (ServiceInitError → dialog → exit/relaunch), so this catch only fires
// for unexpected errors that escape the normal handling path.
startApp().catch((error) => {
  logger.error('Fatal startup error:', error)
  application.forceExit(1)
})
