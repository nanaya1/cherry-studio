import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appGetMock,
  appGetPathMock,
  appRelaunchMock,
  cacheCleanupInspectMock,
  cacheCleanupRunMock,
  inspectTargetMock,
  requestDataResetMock,
  requestV1RemigrationMock,
  requestRelocationMock,
  requestDataRootRelocationMock,
  inspectDataRootMock,
  getProfileLaunchContextMock
} = vi.hoisted(() => ({
  appGetMock: vi.fn(),
  appGetPathMock: vi.fn(),
  appRelaunchMock: vi.fn(),
  cacheCleanupInspectMock: vi.fn(),
  cacheCleanupRunMock: vi.fn(),
  inspectTargetMock: vi.fn(),
  requestDataResetMock: vi.fn(),
  requestV1RemigrationMock: vi.fn(),
  requestRelocationMock: vi.fn(),
  requestDataRootRelocationMock: vi.fn(),
  inspectDataRootMock: vi.fn(),
  getProfileLaunchContextMock: vi.fn()
}))

vi.mock('@application', () => ({
  application: {
    get: appGetMock,
    getPath: appGetPathMock,
    relaunch: appRelaunchMock
  }
}))
vi.mock('@main/core/profiles', () => ({
  getProfileLaunchContext: getProfileLaunchContextMock
}))
vi.mock('@main/services/dataRootRelocation', () => ({
  requestDataRootRelocation: requestDataRootRelocationMock,
  inspectDataRootRelocationTarget: inspectDataRootMock
}))
vi.mock('@main/services/profileDataReset', () => ({
  requestDeviceDataReset: vi.fn()
}))
vi.mock('@main/services/dataReset', () => ({
  requestDataReset: requestDataResetMock,
  requestV1Remigration: requestV1RemigrationMock
}))
vi.mock('@main/services/userDataRelocation', async () => ({
  RelocationValidationError: (await import('@main/services/userDataRelocation/validation')).RelocationValidationError,
  inspectUserDataRelocationTarget: inspectTargetMock,
  requestUserDataRelocation: requestRelocationMock
}))
vi.mock('@main/services/cacheCleanup', () => ({
  cacheCleanupService: { inspect: cacheCleanupInspectMock, run: cacheCleanupRunMock }
}))
vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', isPackaged: true },
  BrowserWindow: { getAllWindows: () => [] },
  webContents: { getAllWebContents: () => [] }
}))

import { app } from 'electron'

import { appHandlers } from '../app'

const appUpdaterService = {
  checkForUpdates: vi.fn(),
  getReleaseHistory: vi.fn(),
  quitAndInstall: vi.fn()
}
const preferenceService = {
  get: vi.fn()
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(app as { isPackaged: boolean }).isPackaged = true
  appGetPathMock.mockReturnValue('/mock/path')
  inspectTargetMock.mockReturnValue({ valid: true, targetEmpty: true })
  getProfileLaunchContextMock.mockReturnValue(undefined)
  appGetMock.mockImplementation((name: string) => {
    if (name === 'AppUpdaterService') return appUpdaterService
    if (name === 'PreferenceService') return preferenceService
    throw new Error(`Unexpected application.get(${name})`)
  })
})

const ctx = { senderId: 'w1' }

describe('appHandlers', () => {
  it('inspects the same trusted profile dataRoot used by requests', async () => {
    const context = { mode: 'business', dataRoot: '/root' }
    getProfileLaunchContextMock.mockReturnValue(context)
    inspectDataRootMock.mockReturnValue({ valid: false, reason: 'target_not_empty' })
    await expect(appHandlers['app.user_data_relocation.inspect']({ path: '/target' }, ctx)).resolves.toEqual({
      valid: false,
      reason: 'target_not_empty'
    })
    expect(inspectDataRootMock).toHaveBeenCalledWith(context, '/target')
    expect(inspectTargetMock).not.toHaveBeenCalled()
  })

  it('rejects development inspection before checking filesystem paths', async () => {
    ;(app as { isPackaged: boolean }).isPackaged = false
    await expect(appHandlers['app.user_data_relocation.inspect']({ path: '/target' }, ctx)).rejects.toMatchObject({
      code: 'USER_DATA_RELOCATION_UNAVAILABLE'
    })
    expect(inspectTargetMock).not.toHaveBeenCalled()
    expect(inspectDataRootMock).not.toHaveBeenCalled()
  })

  it('preserves structured validation reasons across the request boundary', async () => {
    const { RelocationValidationError } = await import('@main/services/userDataRelocation')
    getProfileLaunchContextMock.mockReturnValue({ mode: 'business' })
    requestDataRootRelocationMock.mockImplementationOnce(() => {
      throw new RelocationValidationError('target_not_empty', 'private/path')
    })
    await expect(
      appHandlers['app.user_data_relocation.request']({ path: '/target', copy: true }, ctx)
    ).rejects.toMatchObject({
      code: 'USER_DATA_RELOCATION_INVALID',
      data: { reason: 'target_not_empty' },
      message: 'Invalid relocation target'
    })
  })

  it('returns a safe persistence error without raw filesystem details', async () => {
    getProfileLaunchContextMock.mockReturnValue({ mode: 'business' })
    requestDataRootRelocationMock.mockImplementationOnce(() => {
      throw new Error('secret/path token=private')
    })
    await expect(
      appHandlers['app.user_data_relocation.request']({ path: '/target', copy: true }, ctx)
    ).rejects.toMatchObject({
      code: 'USER_DATA_RELOCATION_PERSIST_FAILED',
      message: 'USER_DATA_RELOCATION_PERSIST_FAILED'
    })
  })

  it('inspects relocation targets through the domain validation', async () => {
    const result = await appHandlers['app.user_data_relocation.inspect']({ path: '/new/data' }, ctx)

    expect(inspectTargetMock).toHaveBeenCalledWith('/new/data')
    expect(result).toEqual({ valid: true, targetEmpty: true })
  })

  it('delegates relocation requests to the domain in packaged builds', async () => {
    const result = await appHandlers['app.user_data_relocation.request']({ path: '/new/data', copy: true }, ctx)

    expect(requestRelocationMock).toHaveBeenCalledWith('/new/data', true)
    expect(result).toBeUndefined()
  })

  it('routes profile-isolated copy requests to dataRoot relocation using the trusted context', async () => {
    const context = {
      mode: 'business',
      profileId: 'a'.repeat(32),
      identityDigest: 'a'.repeat(64),
      kind: 'authenticated',
      dataRoot: '/profiles-root',
      profileRoot: `/profiles-root/profiles/${'a'.repeat(32)}`
    }
    getProfileLaunchContextMock.mockReturnValue(context)

    await appHandlers['app.user_data_relocation.request']({ path: '/new/root', copy: true }, ctx)

    expect(requestDataRootRelocationMock).toHaveBeenCalledWith(context, '/new/root')
    expect(requestRelocationMock).not.toHaveBeenCalled()
  })

  it('rejects switch-only relocation in profile isolation', async () => {
    getProfileLaunchContextMock.mockReturnValue({ mode: 'business' })

    await expect(
      appHandlers['app.user_data_relocation.request']({ path: '/new/root', copy: false }, ctx)
    ).rejects.toMatchObject({ code: 'DATA_ROOT_RELOCATION_COPY_REQUIRED' })
    expect(requestDataRootRelocationMock).not.toHaveBeenCalled()
  })

  it('rejects relocation requests from unpackaged development runs', async () => {
    ;(app as { isPackaged: boolean }).isPackaged = false

    await expect(
      appHandlers['app.user_data_relocation.request']({ path: '/new/data', copy: true }, ctx)
    ).rejects.toMatchObject({ code: 'USER_DATA_RELOCATION_UNAVAILABLE' })
    expect(requestRelocationMock).not.toHaveBeenCalled()
  })

  it('relaunches through IpcApi', async () => {
    await expect(appHandlers['app.relaunch'](undefined, ctx)).resolves.toBeUndefined()
    expect(appRelaunchMock).toHaveBeenCalledOnce()
  })

  it('delegates cache cleanup inspection to the service', async () => {
    const expected = {
      results: [
        {
          group: 'normal_cache' as const,
          size: { bytes: 128, accuracy: 'estimated' as const, completeness: 'complete' as const }
        }
      ]
    }
    cacheCleanupInspectMock.mockResolvedValue(expected)

    const result = await appHandlers['app.cache_cleanup.inspect']({ groups: ['normal_cache'] }, ctx)

    expect(cacheCleanupInspectMock).toHaveBeenCalledWith(['normal_cache'])
    expect(result).toEqual(expected)
  })

  it('delegates cache cleanup execution to the service', async () => {
    const expected = { results: [{ group: 'site_data' as const, status: 'cleared' as const }] }
    cacheCleanupRunMock.mockResolvedValue(expected)

    const result = await appHandlers['app.cache_cleanup.run']({ groups: ['site_data'] }, ctx)

    expect(cacheCleanupRunMock).toHaveBeenCalledWith(['site_data'])
    expect(result).toEqual(expected)
  })

  it('check_for_update triggers the AppUpdaterService check and resolves void', async () => {
    appUpdaterService.checkForUpdates.mockResolvedValue({ currentVersion: '1.0.0', updateInfo: null })

    const result = await appHandlers['app.updater.check_for_update'](undefined, ctx)

    expect(appUpdaterService.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(result).toBeUndefined()
  })

  it('gets release notes through AppUpdaterService', async () => {
    const releases = [{ releaseNotes: 'New features', version: '1.1.0' }]
    appUpdaterService.getReleaseHistory.mockResolvedValue(releases)

    const result = await appHandlers['app.updater.release_notes.get'](undefined, ctx)

    expect(appUpdaterService.getReleaseHistory).toHaveBeenCalledOnce()
    expect(result).toEqual(releases)
  })

  it('quit_and_install delegates to AppUpdaterService and resolves void', async () => {
    const result = await appHandlers['app.updater.quit_and_install'](undefined, ctx)

    expect(appUpdaterService.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(result).toBeUndefined()
  })

  it('delegates data reset requests to the owning domain module', async () => {
    const result = await appHandlers['app.data_reset.request'](undefined, ctx)

    expect(requestDataResetMock).toHaveBeenCalledTimes(1)
    expect(result).toBeUndefined()
  })

  it('propagates data reset rejections to the caller', async () => {
    requestDataResetMock.mockRejectedValueOnce(new Error('EACCES: permission denied'))

    await expect(appHandlers['app.data_reset.request'](undefined, ctx)).rejects.toThrow('EACCES')
  })

  it('delegates v1 remigration requests to the owning domain module', async () => {
    const result = await appHandlers['app.migration_v2.rerun'](undefined, ctx)

    expect(requestV1RemigrationMock).toHaveBeenCalledTimes(1)
    expect(result).toBeUndefined()
  })
})
