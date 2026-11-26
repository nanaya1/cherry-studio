import { setupTestDatabase } from '@test-helpers/db'
import { defaultServiceInstances, mockNotificationService } from '@test-mocks/main/application'
import type { UpdateInfo } from 'builder-util-runtime'
import { eq } from 'drizzle-orm'
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { application } from '@application'
import { appStateTable } from '@data/db/schemas/appState'
import { BaseService } from '@main/core/lifecycle/BaseService'
import { SchedulerService } from '@main/core/scheduler/SchedulerService'
import { regionService } from '@main/services/RegionService'

import { AppUpdaterService } from '../AppUpdaterService'

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() })
  }
}))

vi.mock('@main/core/platform', () => ({ isWin: false }))

vi.mock('@main/utils/appEdition', () => ({ getAppEdition: () => 'global' }))

vi.mock('@main/services/RegionService', () => ({
  regionService: { getCountry: vi.fn(async () => 'US') }
}))

vi.mock('@main/utils/systemInfo', () => ({
  generateUserAgent: vi.fn(() => 'test-user-agent'),
  getClientId: vi.fn(() => 'test-client-id')
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: vi.fn(() => '1.0.0'),
    getLocale: vi.fn(() => 'en-US'),
    getPath: vi.fn(() => '/test/path')
  },
  // Real BaseService.ipcHandle calls ipcMain.handle, so the mock must provide it.
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: vi.fn()
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    logger: null,
    forceDevUpdateConfig: false,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    requestHeaders: {},
    on: vi.fn(),
    removeListener: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    channel: '',
    allowDowngrade: false,
    disableDifferentialDownload: false,
    currentVersion: '1.0.0'
  },
  Logger: vi.fn(),
  NsisUpdater: vi.fn(),
  AppUpdater: vi.fn()
}))

vi.mock('@application', async () => {
  const mod = await import('@test-mocks/main/application')
  return mod.mockApplicationFactory()
})

// Must mirror the private constants in AppUpdaterService.ts.
const SCHEDULE_ID = 'app-updater:auto-check'

const setPackaged = (value: boolean) => {
  ;(app as unknown as { isPackaged: boolean }).isPackaged = value
}

describe('AppUpdaterService — auto update-check scheduling', () => {
  const dbh = setupTestDatabase()
  const releaseMarker = (version: string) =>
    dbh.db
      .select()
      .from(appStateTable)
      .where(eq(appStateTable.key, `appUpdater:notification:${version}`))
      .get()
  let scheduler: SchedulerService
  let appUpdater: AppUpdaterService
  let prefValues: Record<string, unknown>

  beforeEach(async () => {
    vi.clearAllMocks()
    BaseService.resetInstances()
    setPackaged(true)

    prefValues = {
      'app.dist.auto_update.enabled': true,
      'app.dist.test_plan.enabled': false,
      'app.dist.test_plan.channel': undefined,
      'app.language': 'en-US'
    }
    const prefStub = {
      get: vi.fn((key: string) => prefValues[key]),
      // onInit subscribes to test_plan changes; return an unsubscribe fn.
      subscribeMultipleChanges: vi.fn(() => vi.fn())
    }
    const powerStub = { registerShutdownHandler: vi.fn() }
    const analyticsStub = { trackAppUpdate: vi.fn() }
    const windowManagerStub = { broadcastToType: vi.fn() }

    scheduler = new SchedulerService()
    appUpdater = new AppUpdaterService()

    ;(application.get as ReturnType<typeof vi.fn<(...args: any[]) => any>>).mockImplementation((name: string) => {
      switch (name) {
        case 'PreferenceService':
          return prefStub
        case 'SchedulerService':
          return scheduler
        case 'PowerService':
          return powerStub
        case 'AnalyticsService':
          return analyticsStub
        case 'WindowManager':
          return windowManagerStub
        case 'DbService':
          return defaultServiceInstances.DbService
        case 'NotificationService':
          return mockNotificationService
        case 'IpcApiService':
          return defaultServiceInstances.IpcApiService
        default:
          throw new Error(`unexpected application.get('${name}')`)
      }
    })

    vi.mocked(regionService.getCountry).mockResolvedValue('US')
    vi.mocked(autoUpdater.checkForUpdates).mockResolvedValue(null)
    autoUpdater.requestHeaders = {}
    autoUpdater.channel = ''
    autoUpdater.allowDowngrade = false
    autoUpdater.disableDifferentialDownload = false

    await scheduler._doInit()
    await appUpdater._doInit()
  })

  afterEach(async () => {
    await appUpdater._doStop()
    await scheduler._doStop()
    vi.useRealTimers()
    vi.restoreAllMocks()
    BaseService.resetInstances()
  })

  it('records each available release once across repeated update checks', async () => {
    const release = {
      version: '2.0.0',
      path: 'test-update.zip',
      sha512: 'test-checksum',
      releaseDate: new Date().toISOString(),
      files: [],
      releaseNotes: 'A useful update.'
    }
    const available = vi.mocked(autoUpdater.on).mock.calls.find(([event]) => event === 'update-available')?.[1] as
      | ((release: UpdateInfo) => void)
      | undefined
    expect(available).toBeDefined()
    available?.(release)
    available?.(release)
    await vi.waitFor(() => expect(releaseMarker(release.version)?.value).toBe(true))
    available?.(release)
    expect(mockNotificationService.publish).toHaveBeenCalledTimes(1)
    expect(mockNotificationService.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKey: 'release:2.0.0',
        category: 'official',
        kind: 'release',
        target: { kind: 'release', version: '2.0.0', releaseNotes: 'A useful update.' }
      }),
      { source: 'update' }
    )
  })

  it('consumes release identity while official notifications are disabled', async () => {
    prefValues['app.notification.center.official.enabled'] = false
    const available = vi.mocked(autoUpdater.on).mock.calls.find(([event]) => event === 'update-available')?.[1] as
      | ((release: UpdateInfo) => void)
      | undefined
    const release = {
      version: '2.0.1',
      path: 'test-update.zip',
      sha512: 'test-checksum',
      releaseDate: new Date().toISOString(),
      files: [],
      releaseNotes: 'Release notes.'
    }
    available?.(release)
    await vi.waitFor(() => expect(releaseMarker(release.version)?.value).toBe(true))
    mockNotificationService.publish.mockClear()
    prefValues['app.notification.center.official.enabled'] = true
    available?.(release)
    expect(mockNotificationService.publish).not.toHaveBeenCalled()
  })

  it('retries an available release when notification storage failed', async () => {
    mockNotificationService.publish.mockResolvedValueOnce(false)
    const available = vi.mocked(autoUpdater.on).mock.calls.find(([event]) => event === 'update-available')?.[1] as
      | ((release: UpdateInfo) => void)
      | undefined
    const release = {
      version: '2.0.2',
      path: 'test-update.zip',
      sha512: 'test-checksum',
      releaseDate: new Date().toISOString(),
      files: [],
      releaseNotes: 'Release notes.'
    }
    available?.(release)
    await Promise.resolve()
    expect(releaseMarker(release.version)).toBeUndefined()
    available?.(release)
    await vi.waitFor(() => expect(releaseMarker(release.version)?.value).toBe(true))
    available?.(release)
    expect(mockNotificationService.publish).toHaveBeenCalledTimes(2)
  })

  it('does not schedule checks in a packaged app even with the old automatic-update preference enabled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await appUpdater._doAllReady()

    expect(scheduler.has(SCHEDULE_ID)).toBe(false)
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })
})
