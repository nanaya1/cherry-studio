import { arch } from 'node:os'

import { app, BrowserWindow } from 'electron'

import { application } from '@application'
import { loggerService } from '@logger'
import { isWin } from '@main/core/platform'
import { getProfileLaunchContext } from '@main/core/profiles'
import { cacheCleanupService } from '@main/services/cacheCleanup'
import { requestDataReset, requestV1Remigration } from '@main/services/dataReset'
import { inspectDataRootRelocationTarget, requestDataRootRelocation } from '@main/services/dataRootRelocation'
import { requestDeviceDataReset } from '@main/services/profileDataReset'
import {
  inspectUserDataRelocationTarget,
  RelocationValidationError,
  requestUserDataRelocation
} from '@main/services/userDataRelocation'
import { handleZoomFactor } from '@main/utils/zoom'
import { IpcError } from '@shared/ipc/errors/IpcError'
import type { appRequestSchemas } from '@shared/ipc/schemas/app'
import type { IpcHandlersFor } from '@shared/ipc/types'

export const appHandlers: IpcHandlersFor<typeof appRequestSchemas> = {
  'app.get_info': async () => ({
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    appPath: application.getPath('app.root'),
    homePath: application.getPath('sys.home'),
    notesPath: application.getPath('feature.notes.data'),
    configPath: application.getPath('cherry.config'),
    appDataPath: application.getPath('app.userdata'),
    resourcesPath: application.getPath('app.root.resources'),
    logsPath: loggerService.getLogsDir(),
    arch: arch(),
    isPortable: isWin && 'PORTABLE_EXECUTABLE_DIR' in process.env,
    installPath: application.getPath('app.install')
  }),
  // The request face of userData relocation IPC: the running app validates a
  // target and persists the request here. The execution face (a relocation-only
  // launch) never starts IpcApiService — its progress window talks over bare
  // UserDataRelocationIpcChannels instead (services/userDataRelocation/window.ts).
  // 'app.user_data_relocation.inspect': async ({ path }) => inspectUserDataRelocationTarget(path),
  // MEA:data-root-relocation-safety 保留 packaged 限制，inspect/request 使用同一可信迁移对象。
  'app.user_data_relocation.inspect': async ({ path }) => {
    if (!app.isPackaged) throw new IpcError('USER_DATA_RELOCATION_UNAVAILABLE')
    const context = getProfileLaunchContext()
    return context ? inspectDataRootRelocationTarget(context, path) : inspectUserDataRelocationTarget(path)
  },
  'app.user_data_relocation.request': async ({ path, copy }) => {
    if (!app.isPackaged) {
      throw new IpcError('USER_DATA_RELOCATION_UNAVAILABLE', 'userData relocation is available only in packaged builds')
    }
    const context = getProfileLaunchContext()
    if (context) {
      if (!copy) {
        throw new IpcError(
          'DATA_ROOT_RELOCATION_COPY_REQUIRED',
          'profile dataRoot relocation requires copying the verified dataRoot'
        )
      }
      try {
        requestDataRootRelocation(context, path)
      } catch (error) {
        if (error instanceof RelocationValidationError) {
          throw new IpcError('USER_DATA_RELOCATION_INVALID', 'Invalid relocation target', { reason: error.reason })
        }
        // MEA:data-root-relocation-safety 不将文件系统路径或原始异常发给界面。
        loggerService
          .withContext('AppRelocation')
          .error('Failed to persist dataRoot relocation request', error as Error)
        throw new IpcError('USER_DATA_RELOCATION_PERSIST_FAILED')
      }
      return
    }
    // Legacy userData relocation remains available when profile isolation has no launch context.
    // requestUserDataRelocation(path, copy)
    try {
      requestUserDataRelocation(path, copy)
    } catch (error) {
      if (error instanceof RelocationValidationError) {
        throw new IpcError('USER_DATA_RELOCATION_INVALID', 'Invalid relocation target', { reason: error.reason })
      }
      loggerService.withContext('AppRelocation').error('Failed to persist userData relocation request', error as Error)
      throw new IpcError('USER_DATA_RELOCATION_PERSIST_FAILED')
    }
  },
  'app.cache_cleanup.inspect': async ({ groups }) => cacheCleanupService.inspect(groups),
  'app.cache_cleanup.run': async ({ groups }) => cacheCleanupService.run(groups),
  'app.quit': async () => application.quit(),
  'app.relaunch': async () => application.relaunch(),
  'app.adjust_zoom': async ({ delta, reset = false }) => {
    handleZoomFactor(BrowserWindow.getAllWindows(), delta, reset)
    return application.get('PreferenceService').get('app.zoom_factor')
  },
  'app.data_reset.request': async () => requestDataReset(),
  'app.data_reset.device.request': async () => {
    const context = getProfileLaunchContext()
    if (!context) throw new IpcError('PROFILE_CONTEXT_REQUIRED', 'device reset requires an active profile')
    await requestDeviceDataReset(context)
  },
  'app.migration_v2.rerun': async () => requestV1Remigration(),
  'app.updater.check_for_update': async () => {
    await application.get('AppUpdaterService').checkForUpdates()
  },
  'app.updater.release_notes.get': async () => application.get('AppUpdaterService').getReleaseHistory(),
  'app.updater.quit_and_install': async () => {
    application.get('AppUpdaterService').quitAndInstall()
  }
}
