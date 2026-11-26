import type { ProgressInfo, UpdateInfo } from 'builder-util-runtime'
import { CancellationError, CancellationToken, HttpError } from 'builder-util-runtime'
import { eq } from 'drizzle-orm'
import { app } from 'electron'
import type { Logger, NsisUpdater, UpdateCheckResult } from 'electron-updater'
import { AppUpdater, autoUpdater } from 'electron-updater'
import semver from 'semver'

import { application } from '@application'
import { appStateTable } from '@data/db/schemas/appState'
import { loggerService } from '@logger'
import { BaseService, DependsOn, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import { logFailure } from '@main/core/logger/logFailure'
import { isWin } from '@main/core/platform'
import { WindowType } from '@main/core/window/types'
import { getAppLanguage, t } from '@main/i18n'
import { regionService } from '@main/services/RegionService'
import { getAppEdition } from '@main/utils/appEdition'
import { generateUserAgent, getClientId } from '@main/utils/systemInfo'
import { UpgradeChannel } from '@shared/data/preference/preferenceTypes'
import { IpcError, IpcErrorCode } from '@shared/ipc/errors/IpcError'
import type { AppUpdaterNotAvailablePayload } from '@shared/ipc/schemas/app'
import type { OutputFor } from '@shared/ipc/types'
import type { AppEdition } from '@shared/types/appEdition'
import type { FailureFacts } from '@shared/types/errorReporting'
import { APP_NAME } from '@shared/utils/constants'
import { isCancellation } from '@shared/utils/errorReporting'
import {
  hasMultiLanguageReleaseNotes,
  isStableReleaseVersion,
  localizeReleaseNotes,
  type ReleaseNotesEntry
} from '@shared/utils/releaseNotes'

const logger = loggerService.withContext('AppUpdaterService')

export function classifyUpdateFailure(error: unknown): FailureFacts {
  if (error instanceof CancellationError || isCancellation(error)) {
    return { source: 'environment', kind: 'expected', reason: 'cancelled', outcome: 'cancelled' }
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  if (error instanceof HttpError && ![401, 403, 408, 429].includes(error.statusCode) && !error.isServerError()) {
    return { source: 'application', kind: 'reliability', reason: 'update_feed_invalid', outcome: 'failed' }
  }
  if (
    error instanceof HttpError ||
    (typeof code === 'string' &&
      [
        'ENOTFOUND',
        'EAI_AGAIN',
        'ECONNREFUSED',
        'ECONNRESET',
        'ETIMEDOUT',
        'ENETUNREACH',
        'EHOSTUNREACH',
        'EACCES',
        'EPERM',
        'ENOSPC'
      ].includes(code))
  ) {
    return { source: 'environment', kind: 'expected', reason: 'update_unavailable', outcome: 'failed' }
  }
  if (typeof code === 'string' && (code.startsWith('ERR_UPDATER_') || code === 'ERR_CHECKSUM_MISMATCH')) {
    return { source: 'application', kind: 'reliability', reason: 'update_package_invalid', outcome: 'failed' }
  }
  return {
    source: 'application',
    kind:
      error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError
        ? 'defect'
        : 'unknown',
    reason: 'update_failed',
    outcome: 'failed'
  }
}

type ReleaseRegion = 'cn' | 'global'

// Cherry 官方 release-history 源已停用，保留常量注释便于恢复历史实现。
// export const RELEASE_HISTORY_URL = 'https://releases.cherry-ai.com/release-history.json'
// const RELEASE_HISTORY_TIMEOUT_MS = 10_000
// const RELEASE_HISTORY_MAX_BYTES = 1024 * 1024

function getEditionUpdateChannel(channel: UpgradeChannel, edition: AppEdition): string {
  return edition === 'cn' ? `${channel}-cn` : channel
}

function getUpdateHeaders({ region, edition }: { region: ReleaseRegion; edition: AppEdition }) {
  return {
    'User-Agent': generateUserAgent(),
    'Cache-Control': 'no-cache',
    'Client-Id': getClientId(),
    'App-Name': APP_NAME,
    'App-Version': `v${app.getVersion()}`,
    OS: process.platform,
    'X-Edition': edition,
    'X-Region': region
  }
}

class ReleaseNotesUpdater extends AppUpdater {
  constructor() {
    super(undefined)
  }

  protected doDownloadUpdate(): Promise<string[]> {
    return Promise.reject(new Error('Release-notes updater cannot download updates'))
  }

  quitAndInstall(): never {
    throw new Error('Release-notes updater cannot install updates')
  }
}

@Injectable('AppUpdaterService')
@ServicePhase(Phase.WhenReady)
@DependsOn(['WindowManager', 'NotificationService'])
export class AppUpdaterService extends BaseService {
  private readonly pendingReleaseNotifications = new Set<string>()
  private cancellationToken: CancellationToken = new CancellationToken()
  private updateCheckResult: UpdateCheckResult | null = null

  protected async onInit(): Promise<void> {
    autoUpdater.logger = logger as Logger
    // Packaged builds use app-update.yml generated from electron-builder.yml;
    // development uses the repository's dev-app-update.yml.
    autoUpdater.forceDevUpdateConfig = !app.isPackaged
    autoUpdater.autoDownload = application.get('PreferenceService').get('app.dist.auto_update.enabled')
    // Never auto-install on quit - user must explicitly click "Install Now"
    // Auto-install on quit can cause issues: unexpected updates on restart,
    // corruption if system shuts down during install, or app uninstall on force shutdown
    autoUpdater.autoInstallOnAppQuit = false

    this.registerAutoUpdaterListeners()

    if (isWin) {
      ;(autoUpdater as NsisUpdater).installDirectory = application.getPath('app.install')
    }

    // Cancel an in-flight download when the test plan or channel changes — the
    // download targets the previously selected channel. The v2 settings UI
    // writes these preferences directly (no IPC), so react to the change here
    // rather than in a now-removed `App_SetTestPlan`/`App_SetTestChannel` handler.
    this.registerDisposable(
      application
        .get('PreferenceService')
        .subscribeMultipleChanges(['app.dist.test_plan.enabled', 'app.dist.test_plan.channel'], () =>
          this.cancelDownload()
        )
    )
  }

  protected async onAllReady(): Promise<void> {
    application.get('PowerService').registerShutdownHandler(() => {
      autoUpdater.autoDownload = false
    })
  }

  private async publishReleaseNotification(releaseInfo: UpdateInfo): Promise<void> {
    if (this.pendingReleaseNotifications.has(releaseInfo.version)) return
    this.pendingReleaseNotifications.add(releaseInfo.version)
    try {
      const db = application.get('DbService').getDb()
      const key = `appUpdater:notification:${releaseInfo.version}`
      if (db.select().from(appStateTable).where(eq(appStateTable.key, key)).get()) return

      const releaseNotes =
        typeof releaseInfo.releaseNotes === 'string'
          ? releaseInfo.releaseNotes
          : (releaseInfo.releaseNotes
              ?.map(({ note }) => note)
              .filter(Boolean)
              .join('\n\n') ?? '')
      const title = t('notification.center.version_available', { version: releaseInfo.version })
      const summary = releaseNotes
        .split('\n')
        .find((line) => line.trim() && !/^\s*#/.test(line))
        ?.replace(/^\s*[-*>]\s*/, '')
        .trim()
        .slice(0, 240)
      const recorded = await application.get('NotificationService').publish(
        {
          eventKey: `release:${releaseInfo.version}`,
          category: 'official',
          kind: 'release',
          title,
          message: summary || title,
          createdAt: Date.now(),
          target: { kind: 'release', version: releaseInfo.version, releaseNotes }
        },
        { source: 'update' }
      )
      if (recorded) db.insert(appStateTable).values({ key, value: true }).onConflictDoNothing().run()
    } catch (error) {
      logger.warn('Failed to publish release notification', error as Error)
    } finally {
      this.pendingReleaseNotifications.delete(releaseInfo.version)
    }
  }

  private registerAutoUpdaterListeners(): void {
    const onError = (error: Error) => {
      logFailure(logger, 'update error', error, 'update.run', classifyUpdateFailure(error))
      application.get('IpcApiService').broadcastToType(WindowType.Main, 'app.updater.error', error)
    }
    autoUpdater.on('error', onError)
    this.registerDisposable(() => autoUpdater.removeListener('error', onError))

    const onUpdateAvailable = (releaseInfo: UpdateInfo) => {
      logger.info('update available', releaseInfo)
      const processedReleaseInfo = this.processReleaseInfo(releaseInfo)
      void this.publishReleaseNotification(processedReleaseInfo)
      application.get('IpcApiService').broadcastToType(WindowType.Main, 'app.updater.available', processedReleaseInfo)
    }
    autoUpdater.on('update-available', onUpdateAvailable)
    this.registerDisposable(() => autoUpdater.removeListener('update-available', onUpdateAvailable))

    const onUpdateNotAvailable = (updateInfo: UpdateInfo) => {
      const result = this.resolveNotAvailableResult(updateInfo)
      if (!result.isCurrent) {
        logger.warn(
          `managed feed target ${result.feedVersion} differs from installed ${result.currentVersion} (channel: ${autoUpdater.channel}) — treating as withheld, not current`
        )
      }
      const payload: AppUpdaterNotAvailablePayload = { isCurrent: result.isCurrent }
      application.get('IpcApiService').broadcastToType(WindowType.Main, 'app.updater.not_available', payload)
    }
    autoUpdater.on('update-not-available', onUpdateNotAvailable)
    this.registerDisposable(() => autoUpdater.removeListener('update-not-available', onUpdateNotAvailable))

    const onDownloadProgress = (progress: ProgressInfo) => {
      application.get('IpcApiService').broadcastToType(WindowType.Main, 'app.updater.download_progress', progress)
    }
    autoUpdater.on('download-progress', onDownloadProgress)
    this.registerDisposable(() => autoUpdater.removeListener('download-progress', onDownloadProgress))

    const onUpdateDownloaded = (releaseInfo: UpdateInfo) => {
      const processedReleaseInfo = this.processReleaseInfo(releaseInfo)
      application.get('IpcApiService').broadcastToType(WindowType.Main, 'app.updater.downloaded', processedReleaseInfo)
      logger.info('update downloaded', processedReleaseInfo)
    }
    autoUpdater.on('update-downloaded', onUpdateDownloaded)
    this.registerDisposable(() => autoUpdater.removeListener('update-downloaded', onUpdateDownloaded))
  }

  private async getUpdateRequest() {
    const currentVersion = app.getVersion()
    const testPlan = application.get('PreferenceService').get('app.dist.test_plan.enabled')
    const requestedChannel = testPlan
      ? application.get('PreferenceService').get('app.dist.test_plan.channel') || UpgradeChannel.RC
      : UpgradeChannel.LATEST

    const ipCountry = await regionService.getCountry()
    const region: ReleaseRegion = ipCountry.toLowerCase() === 'cn' ? 'cn' : 'global'
    const edition = getAppEdition()
    const updateChannel = getEditionUpdateChannel(requestedChannel, edition)

    const updateHeaders = getUpdateHeaders({ region, edition })

    return { currentVersion, edition, ipCountry, region, testPlan, updateChannel, updateHeaders }
  }

  private async configureUpdaterForCheck() {
    const { currentVersion, edition, ipCountry, region, testPlan, updateChannel, updateHeaders } =
      await this.getUpdateRequest()

    autoUpdater.requestHeaders = {
      ...autoUpdater.requestHeaders,
      ...updateHeaders
    }

    logger.info(
      `Using managed update feed for version ${currentVersion}, edition: ${edition}, testPlan: ${testPlan}, channel: ${updateChannel}, region: ${region} (IP country: ${ipCountry})`
    )
    autoUpdater.channel = updateChannel

    // disable downgrade after change the channel
    autoUpdater.allowDowngrade = false
    // The updater falls back to a full download when blockmaps or the cached base are unavailable.
    // autoUpdater.disableDifferentialDownload = false
    autoUpdater.disableDifferentialDownload = true
  }

  // Cherry 官方 release-history 不再参与更新流程；自动更新仍使用 MEA 的 update feed。
  // private async fetchReleaseHistory(): Promise<ReleaseNotesEntry[] | null> {
  //   return null
  // }

  public async queryUpdateAvailability(): Promise<
    | { status: 'unsupported' }
    | { status: 'current'; currentVersion: string }
    | { status: 'available'; currentVersion: string; version: string }
  > {
    if (this.isPortable()) return { status: 'unsupported' }
    const { currentVersion, updateChannel, updateHeaders } = await this.getUpdateRequest()
    const updater = new ReleaseNotesUpdater()
    updater.logger = logger as Logger
    updater.forceDevUpdateConfig = !app.isPackaged
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.requestHeaders = updateHeaders
    updater.channel = updateChannel
    updater.allowDowngrade = false
    const result = await updater.checkForUpdates()
    if (!result) throw new Error('Update query did not produce a result')
    return result.isUpdateAvailable
      ? { status: 'available', currentVersion, version: result.updateInfo.version }
      : { status: 'current', currentVersion }
  }

  public async getLatestReleaseNotes(): Promise<ReleaseNotesEntry | null> {
    return null
  }

  public async getReleaseHistory(): Promise<ReleaseNotesEntry[] | null> {
    return null
  }

  public async getUpgradeReleaseNotes(targetVersion: string): Promise<OutputFor<'app.updater.upgrade_notes.get'>> {
    const fromVersion = app.getVersion()
    if (
      !isStableReleaseVersion(fromVersion) ||
      !isStableReleaseVersion(targetVersion) ||
      !semver.gt(targetVersion, fromVersion)
    ) {
      throw new IpcError(IpcErrorCode.VALIDATION_FAILED, 'Expected a stable upgrade range')
    }
    return { fromVersion, toVersion: targetVersion, historyStatus: 'unavailable', releases: [] }
  }

  public cancelDownload() {
    this.cancellationToken.cancel()
    this.cancellationToken = new CancellationToken()
    if (autoUpdater.autoDownload) {
      this.updateCheckResult?.cancellationToken?.cancel()
    }
  }

  private isPortable(): boolean {
    return isWin && 'PORTABLE_EXECUTABLE_DIR' in process.env
  }

  /**
   * Throwing core of the update check: updater setup → check → (manual) download
   * trigger. The public IPC entry `checkForUpdates()` catches failures to preserve its
   * event-driven contract: errors reach the renderer via the `UpdateError`
   * broadcast (see `registerAutoUpdaterListeners`), not the return value.
   */
  private async performUpdateCheck() {
    void application.get('AnalyticsService').trackAppUpdate()

    if (this.isPortable()) {
      return {
        currentVersion: app.getVersion(),
        updateInfo: null
      }
    }

    await this.configureUpdaterForCheck()

    this.updateCheckResult = await autoUpdater.checkForUpdates()
    logger.info(
      `update check result: ${this.updateCheckResult?.isUpdateAvailable}, channel: ${autoUpdater.channel}, currentVersion: ${autoUpdater.currentVersion}`
    )

    if (this.updateCheckResult?.isUpdateAvailable && !autoUpdater.autoDownload) {
      // 如果 autoDownload 为 false，则需要再调用下面的函数触发下
      // do not use await, because it will block the return of this function
      logger.info('downloadUpdate manual by check for updates', this.cancellationToken)
      void autoUpdater.downloadUpdate(this.cancellationToken)
    }

    return {
      currentVersion: autoUpdater.currentVersion,
      updateInfo: this.updateCheckResult?.isUpdateAvailable ? this.updateCheckResult?.updateInfo : null
    }
  }

  public async checkForUpdates() {
    try {
      return await this.performUpdateCheck()
    } catch (error) {
      logFailure(logger, 'Failed to check for update:', error, 'update.check', classifyUpdateFailure(error))
      return {
        currentVersion: app.getVersion(),
        updateInfo: null
      }
    }
  }

  public quitAndInstall() {
    application.markQuitting()
    setImmediate(() => autoUpdater.quitAndInstall(true, true))
  }

  /**
   * Feed/install mismatch means withheld (withdrawn/stale/staged). A prerelease install stays
   * current against an older (e.g. stable) feed, but not when the feed advertises a newer version.
   * Unparseable versions stay current.
   */
  private resolveNotAvailableResult(updateInfo: UpdateInfo | null | undefined): {
    currentVersion: string
    feedVersion: string | null
    isCurrent: boolean
  } {
    const currentVersion = app.getVersion()
    const feedVersion = updateInfo?.version || null
    let isCurrent = true
    if (feedVersion) {
      try {
        isCurrent =
          semver.eq(feedVersion, currentVersion) ||
          (semver.prerelease(currentVersion) !== null && !semver.gt(feedVersion, currentVersion))
      } catch {
        // Unparseable versions fail closed to current.
      }
    }
    return { currentVersion, feedVersion, isCurrent }
  }

  /**
   * Process release info to handle multi-language release notes
   * @param releaseInfo - Original release info from updater
   * @returns Processed release info with localized release notes
   */
  private processReleaseInfo(releaseInfo: UpdateInfo): UpdateInfo {
    const processedInfo = { ...releaseInfo }

    // Handle multi-language release notes in string format
    if (releaseInfo.releaseNotes && typeof releaseInfo.releaseNotes === 'string') {
      if (hasMultiLanguageReleaseNotes(releaseInfo.releaseNotes)) {
        try {
          const language = getAppLanguage()
          processedInfo.releaseNotes = localizeReleaseNotes(releaseInfo.releaseNotes, language)
        } catch (error) {
          logger.error('Failed to localize release notes', error as Error)
        }
      }
    }

    return processedInfo
  }
}
