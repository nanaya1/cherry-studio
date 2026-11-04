import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { v4 as uuidv4 } from 'uuid'

import { application } from '@application'
import { adoptLegacyProfile } from '@main/core/preboot/profileIsolationRuntime'
import { deferWindowReveal } from '@main/core/preboot/singleInstance'
// import { ORG_SERVER_BASE_URL } from '@main/enterprise/OrgApiClient'
import { ORG_AUTH_MODE, ORG_SERVER_BASE_URL } from '@main/enterprise/OrgApiClient'
import { OrgAuthManager } from '@main/enterprise/OrgAuthManager'
import { OrgCredentialStore } from '@main/enterprise/OrgCredentialStore'
import { createPasswordProfileLogin } from '@main/enterprise/passwordLoginRuntime'
import { resolveSystemLanguage, t } from '@main/i18n'

import { validateSqliteIntegrity } from './LegacyProfileAdoption'
import { ProfileActivePointer } from './ProfileActivePointer'
import {
  ProfileClaimService,
  type ProfileClaimAllow,
  type ProfileClaimCategory,
  type ProfileClaimPreview
} from './ProfileClaimService'
import { ProfileInstallation } from './ProfileInstallation'
import { createProfilePaths, validateExistingProfilePath } from './ProfilePaths'
import type { ProfileLaunchContext } from './ProfilePrebootCoordinator'
import { ProfileRegistry } from './ProfileRegistry'
import {
  getProfileLaunchContext,
  getLastBusinessIdentityDigest,
  shouldActivateInProcess
} from './ProfileRuntimeContext'
import { ProfileSessionService } from './ProfileSessionService'
import { ProfileSwitchCoordinator, showProfileRecoveryChoice } from './ProfileSwitchCoordinator'
import { ProfileSwitchJournal } from './ProfileSwitchJournal'
// import { profileSwitchFence } from './SwitchFence'
import { SwitchFence } from './SwitchFence'

const PASSWORD_LOGIN = 'profile-bootstrap:password-login'
const ENTERPRISE_LOGIN = 'profile-bootstrap:enterprise-login'
const ADOPT_LEGACY = 'profile-bootstrap:adopt-legacy'
const profileBootstrapWindows = new Set<BrowserWindow>()
let activeBootstrap:
  | {
      window: BrowserWindow
      contextKey: string
      ready: boolean
      superseded: boolean
      onReady: Set<() => void>
    }
  | undefined

export interface ProfileBootstrapWindowOptions {
  onReady?: () => void
  /*
  startupRecovery?: {
    failureKind: 'unavailable' | 'invalid'
    retry(isCurrent: () => boolean): Promise<'unavailable' | 'invalid' | void>
    selectSignedOut(isCurrent: () => boolean): Promise<void>
  }
  */
}
const handlerOwners = new Map<string, BrowserWindow>()

function registerBootstrapHandler(
  channel: string,
  window: BrowserWindow,
  handler: Parameters<typeof ipcMain.handle>[1]
): void {
  ipcMain.removeHandler(channel)
  handlerOwners.set(channel, window)
  ipcMain.handle(channel, (event, ...args) => {
    if (
      activeBootstrap?.window !== window ||
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    ) {
      throw new Error('Untrusted authentication sender')
    }
    return handler(event, ...args)
  })
  window.once('closed', () => {
    if (handlerOwners.get(channel) !== window) return
    ipcMain.removeHandler(channel)
    handlerOwners.delete(channel)
  })
}

// const translateForBootstrap = (key: string, params?: Record<string, string | number>) =>
//   t (key, params, resolveSystemLanguage(app.getLocale()))
// MEA:profile-verification-network-tolerance Literal translation keys keep native bootstrap messages statically checked.

export async function confirmProfileClaim(
  preview: Extract<ProfileClaimPreview, { status: 'ready' }>
): Promise<{ copy: boolean; allow: ProfileClaimAllow[] } | null> {
  const categoryLabel = (category: ProfileClaimCategory) => {
    switch (category) {
      case 'api-key':
        return t('dialog.profile_claim.category.api_key', undefined, resolveSystemLanguage(app.getLocale()))
      case 'business-data':
        return t('dialog.profile_claim.category.business_data', undefined, resolveSystemLanguage(app.getLocale()))
      case 'copilot':
        return t('dialog.profile_claim.category.copilot', undefined, resolveSystemLanguage(app.getLocale()))
      case 'credentials':
        return t('dialog.profile_claim.category.credentials', undefined, resolveSystemLanguage(app.getLocale()))
      case 'enterprise-resource':
        return t('dialog.profile_claim.category.enterprise_resource', undefined, resolveSystemLanguage(app.getLocale()))
      case 'mcp-oauth':
        return t('dialog.profile_claim.category.mcp_oauth', undefined, resolveSystemLanguage(app.getLocale()))
      case 'ordinary-config':
        return t('dialog.profile_claim.category.ordinary_config', undefined, resolveSystemLanguage(app.getLocale()))
      case 'runtime':
        return t('dialog.profile_claim.category.runtime', undefined, resolveSystemLanguage(app.getLocale()))
      case 'sensitive':
        return t('dialog.profile_claim.category.sensitive', undefined, resolveSystemLanguage(app.getLocale()))
      case 'session-cookies':
        return t('dialog.profile_claim.category.session_cookies', undefined, resolveSystemLanguage(app.getLocale()))
    }
  }
  const included =
    preview.included.map((item) => categoryLabel(item.category)).join(', ') ||
    t('common.none', undefined, resolveSystemLanguage(app.getLocale()))
  const excluded =
    preview.excluded.map((item) => categoryLabel(item.category)).join(', ') ||
    t('common.none', undefined, resolveSystemLanguage(app.getLocale()))
  const copy = await dialog.showMessageBox({
    type: 'question',
    title: t('dialog.profile_claim.migrate.title', undefined, resolveSystemLanguage(app.getLocale())),
    message: t('dialog.profile_claim.migrate.message', undefined, resolveSystemLanguage(app.getLocale())),
    detail: t(
      'dialog.profile_claim.migrate.detail',
      {
        bytes: preview.totalBytes,
        included,
        excluded
      },
      resolveSystemLanguage(app.getLocale())
    ),
    buttons: [
      t('dialog.profile_claim.migrate.confirm', undefined, resolveSystemLanguage(app.getLocale())),
      t('dialog.profile_claim.cancel_login', undefined, resolveSystemLanguage(app.getLocale()))
    ],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })
  if (copy.response === 1) return null

  const allow: ProfileClaimAllow[] = []
  const ordinaryConfig = await dialog.showMessageBox({
    type: 'question',
    title: t('dialog.profile_claim.settings.title', undefined, resolveSystemLanguage(app.getLocale())),
    message: t('dialog.profile_claim.settings.message', undefined, resolveSystemLanguage(app.getLocale())),
    detail: t('dialog.profile_claim.settings.detail', undefined, resolveSystemLanguage(app.getLocale())),
    buttons: [
      t('dialog.profile_claim.settings.include', undefined, resolveSystemLanguage(app.getLocale())),
      t('dialog.profile_claim.do_not_include', undefined, resolveSystemLanguage(app.getLocale()))
    ],
    defaultId: 1,
    cancelId: 1
  })
  if (ordinaryConfig.response === 0) allow.push('ordinary-config')

  const apiKeys = await dialog.showMessageBox({
    type: 'warning',
    title: t('dialog.profile_claim.api_keys.title', undefined, resolveSystemLanguage(app.getLocale())),
    message: t('dialog.profile_claim.api_keys.message', undefined, resolveSystemLanguage(app.getLocale())),
    detail: t('dialog.profile_claim.api_keys.detail', undefined, resolveSystemLanguage(app.getLocale())),
    buttons: [
      t('dialog.profile_claim.do_not_include', undefined, resolveSystemLanguage(app.getLocale())),
      t('dialog.profile_claim.api_keys.include', undefined, resolveSystemLanguage(app.getLocale()))
    ],
    defaultId: 0,
    cancelId: 0
  })
  if (apiKeys.response === 1) allow.push('api-keys')
  return { copy: true, allow }
}

export function closeProfileBootstrapWindows(): void {
  if (activeBootstrap) activeBootstrap.superseded = true
  for (const window of profileBootstrapWindows) {
    if (!window.isDestroyed()) window.close()
  }
  profileBootstrapWindows.clear()
  activeBootstrap = undefined
}

export function createProfileBootstrapWindow(
  context: ProfileLaunchContext,
  options: ProfileBootstrapWindowOptions = {}
): BrowserWindow {
  // MEA:profile-verification-network-tolerance 业务候选必须先经 signed-out 事务隔离，不能直接打开无登录 IPC 的窗口。
  if (context.mode === 'business') throw new Error('Business startup must select signed-out before opening login')
  const contextKey = JSON.stringify([
    context.mode,
    context.profileId,
    context.identityDigest,
    context.kind,
    context.dataRoot,
    context.profileRoot,
    context.legacyRoot,
    context.pendingSwitch?.operationId,
    context.pendingSwitch?.action
    // options.startupRecovery?.failureKind
  ])
  if (activeBootstrap && !activeBootstrap.window.isDestroyed()) {
    if (activeBootstrap.contextKey === contextKey) {
      const current = activeBootstrap
      if (current.ready) {
        if (current.window.isMinimized()) current.window.restore()
        current.window.show()
        current.window.focus()
        if (activeBootstrap === current && !current.window.isDestroyed()) options.onReady?.()
      } else if (options.onReady) {
        current.onReady.add(options.onReady)
      }
      return current.window
    }
    const previous = activeBootstrap.window
    activeBootstrap.superseded = true
    activeBootstrap = undefined
    deferWindowReveal(previous)
    previous.hide()
    previous.close()
    profileBootstrapWindows.delete(previous)
  }
  const isLogin = context.mode === 'signed-out'
  // const isBusinessStartup = context.mode === 'business'
  const isBusinessStartup = false
  const window = new BrowserWindow({
    // 原恢复窗口尺寸保留，登录页使用服务端双栏布局。
    width: isLogin ? 1100 : isBusinessStartup ? 620 : 520,
    height: isLogin ? 760 : isBusinessStartup ? 460 : 360,
    minWidth: isLogin ? 480 : isBusinessStartup ? 620 : 520,
    minHeight: isLogin ? 640 : isBusinessStartup ? 460 : 360,
    resizable: isLogin,
    // show: !isBusinessStartup,
    show: false, // MEA:profile-online-login 认证窗口也必须等待首帧。
    // title: 'MEACowork Profile',
    title: 'MEA Cowork 企业版',
    webPreferences: {
      preload: path.join(__dirname, '../preload/profileBootstrap.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // MEA:profile-online-login Recovery UI must not reuse the candidate business session.
      partition: 'profile-bootstrap'
    }
  })
  const state = { window, contextKey, ready: false, superseded: false, onReady: new Set<() => void>() }
  if (options.onReady) state.onReady.add(options.onReady)
  activeBootstrap = state
  profileBootstrapWindows.add(window)
  window.once('closed', () => {
    profileBootstrapWindows.delete(window)
    if (activeBootstrap === state) activeBootstrap = undefined
  })
  const allowWindowReveal = deferWindowReveal(window)
  let loadFailed = false
  window.once('ready-to-show', () => {
    if (activeBootstrap !== state || loadFailed || window.isDestroyed()) return
    state.ready = true
    allowWindowReveal()
    window.show()
    for (const callback of state.onReady) {
      if (activeBootstrap !== state || window.isDestroyed()) break
      callback()
    }
    state.onReady.clear()
  })
  const closeOnLoadFailure = () => {
    if (loadFailed || activeBootstrap !== state || window.isDestroyed()) return
    loadFailed = true
    state.ready = false
    activeBootstrap = undefined
    deferWindowReveal(window)
    window.hide()
    /*
    dialog.showErrorBox(
      t('dialog.profile_bootstrap.load_failed.title', undefined, resolveSystemLanguage(app.getLocale())),
      t('dialog.profile_bootstrap.load_failed.message', undefined, resolveSystemLanguage(app.getLocale()))
    )
    */
    // MEA:profile-verification-network-tolerance Never end a failed window handoff without a user choice.
    state.superseded = true
    showProfileRecoveryChoice(application, 'bootstrap-load', true)
    window.close()
  }
  window.webContents.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => {
    if (isMainFrame) closeOnLoadFailure()
  })
  const load = (promise: Promise<void>) => {
    void promise.catch(closeOnLoadFailure)
  }
  if (isLogin || isBusinessStartup) {
    if (isBusinessStartup) {
      /* 原独立 startup recovery 入口停用；启动失败由主进程切换至 signed-out 后复用登录窗口。
      if (options.startupRecovery) {
        registerStartupRecoveryHandlers(window, options.startupRecovery)
        window.once('closed', () => {
          if (!state.superseded && !application.isRelaunching) application.forceExit(0)
        })
      } else registerBootstrapHandler('profile-bootstrap:startup-state', window, () => ({ phase: 'verifying' }))
      */
      /* 原业务窗口专属处理保留，所有 bootstrap 窗口现在共享就绪与失败处理。
      const closeOnLoadFailure = (
        _event: Electron.Event,
        _errorCode: number,
        _errorDescription: string,
        _validatedURL: string,
        isMainFrame: boolean
      ) => {
        if (isMainFrame && !window.isDestroyed()) window.close()
      }
      window.once('ready-to-show', () => {
        if (!window.isDestroyed()) window.show()
      })
      window.webContents.once('did-fail-load', closeOnLoadFailure)
      */
      /* 原 startup=1 恢复页面入口停用，业务窗口仅保留为兼容性入口并不再创建。
      const startupPath = path.join(__dirname, '../renderer/windows/profileBootstrap/index.html')
      if (process.env['ELECTRON_RENDERER_URL']) {
        // void window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/windows/profileBootstrap/index.html?startup=1`)
        load(window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/windows/profileBootstrap/index.html?startup=1`))
      } else {
        // void window.loadFile(startupPath, { query: { startup: '1' } })
        load(window.loadFile(startupPath, { query: { startup: '1' } }))
      }
      */
      // 独立启动恢复窗口不再运行；所有可见登录窗口均由 signed-out 分支创建。
      return window
    }

    registerSignedOutHandlers(context, window)
    const sso = ORG_AUTH_MODE === 'management-oauth' || ORG_AUTH_MODE === 'official-direct'
    if (process.env['ELECTRON_RENDERER_URL']) {
      /*
      void window.loadURL(
        `${process.env['ELECTRON_RENDERER_URL']}/windows/profileBootstrap/index.html${sso ? '?sso=1' : ''}`
      )
      */
      load(
        window.loadURL(
          `${process.env['ELECTRON_RENDERER_URL']}/windows/profileBootstrap/index.html${sso ? '?sso=1' : ''}`
        )
      )
    } else {
      const loginPath = path.join(__dirname, '../renderer/windows/profileBootstrap/index.html')
      // if (sso) void window.loadFile(loginPath, { query: { sso: '1' } })
      // else void window.loadFile(loginPath)
      load(sso ? window.loadFile(loginPath, { query: { sso: '1' } }) : window.loadFile(loginPath))
    }
    // Cancel login (window closed before any business started) exits the app; a
    // completed same-process activation flips the launch context to 'business'
    // and keeps the process alive.
    window.once('closed', () => {
      // 重启链路会自己拉起新进程，这里再 forceExit 会抢在 app.relaunch 之前结束进程。
      // 注意不能看 isQuitting：登出也会置位，但登出后仍需关闭登录窗即退出。
      // if (application.isRelaunching) return
      if (state.superseded || application.isRelaunching) return
      if (getProfileLaunchContext()?.mode !== 'business') application.forceExit(0)
    })
    return window
  }
  if (context.mode === 'migration-required') registerLegacyAdoptionHandler(context, window)
  const title = t('dialog.profile_claim.legacy.title', undefined, resolveSystemLanguage(app.getLocale()))
  const detail = t('dialog.profile_claim.legacy.detail', undefined, resolveSystemLanguage(app.getLocale()))
  const actions = `<div class="actions"><button id="adopt">${t('dialog.profile_claim.legacy.confirm', undefined, resolveSystemLanguage(app.getLocale()))}</button></div><p id="status"></p><script>const status=document.getElementById('status');document.getElementById('adopt').onclick=async()=>{status.textContent=${JSON.stringify(t('dialog.profile_claim.legacy.copying', undefined, resolveSystemLanguage(app.getLocale())))};try{await window.profileBootstrap.adoptLegacy();status.textContent=${JSON.stringify(t('dialog.profile_claim.legacy.restarting', undefined, resolveSystemLanguage(app.getLocale())))}}catch(e){status.textContent=String(e)}}</script>`
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{margin:0;font:14px system-ui;background:#f5f5f5;color:#202124}main{padding:48px}h1{font-size:22px;margin:0 0 16px}p{line-height:1.6;margin:0;color:#5f6368}.actions{display:flex;gap:12px;margin-top:28px}button{border:1px solid #c7c7c7;background:#fff;padding:10px 16px;border-radius:6px;cursor:pointer}button:last-child{background:#1f1f1f;color:#fff;border-color:#1f1f1f}#status{margin-top:18px}</style><main><h1>${title}</h1><p>${detail}</p>${actions}</main>`
  // void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  load(window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`))
  return window
}

/* 原独立 startup recovery IPC 入口停用，保留以便回滚。
function registerStartupRecoveryHandlers(
  window: BrowserWindow,
  recovery: NonNullable<ProfileBootstrapWindowOptions['startupRecovery']>
): void {
  const isCurrent = () => activeBootstrap?.window === window && !window.isDestroyed()
  let phase: 'failed' | 'verifying' | 'starting' | 'selecting' = 'failed'
  let failureKind = recovery.failureKind
  const snapshot = () => ({ phase, failureKind })
  let inFlight: Promise<ReturnType<typeof snapshot>> | undefined
  registerBootstrapHandler('profile-bootstrap:startup-state', window, () => snapshot())
  registerBootstrapHandler('profile-bootstrap:retry-recovery', window, () => {
    if (inFlight) return inFlight
    if (phase === 'selecting') throw new Error('Profile startup is already in progress')
    if (phase === 'starting') return snapshot()
    phase = 'verifying'
    inFlight = recovery
      .retry(isCurrent)
      .then(
        (failure) => {
          if (failure) failureKind = failure
          phase = failure ? 'failed' : 'starting'
          return snapshot()
        },
        () => {
          phase = 'failed'
          return snapshot()
        }
      )
      .finally(() => {
        inFlight = undefined
      })
    return inFlight
  })
  registerBootstrapHandler('profile-bootstrap:select-signed-out', window, async () => {
    if (phase === 'verifying' || phase === 'starting' || phase === 'selecting') {
      throw new Error('Profile startup is already in progress')
    }
    phase = 'selecting'
    try {
      await recovery.selectSignedOut(isCurrent)
    } catch (error) {
      phase = 'failed'
      throw error
    }
  })
}
*/

function registerLegacyAdoptionHandler(context: ProfileLaunchContext, window: BrowserWindow): void {
  // ipcMain.removeHandler(ADOPT_LEGACY)
  // window.once('closed', () => ipcMain.removeHandler(ADOPT_LEGACY))
  // ipcMain.handle(ADOPT_LEGACY, async () => {
  registerBootstrapHandler(ADOPT_LEGACY, window, async () => {
    await adoptLegacyProfile(context)
    application.relaunch()
  })
}

function registerSignedOutHandlers(context: ProfileLaunchContext, window: BrowserWindow): void {
  // ipcMain.removeHandler(ENTERPRISE_LOGIN)
  const paths = createProfilePaths(context.dataRoot)
  const registry = new ProfileRegistry(path.join(paths.controlRoot, 'profiles.json'))
  const activePointer = new ProfileActivePointer(path.join(paths.controlRoot, 'active-profile.json'), registry)
  const loginFence = new SwitchFence()
  const session = new ProfileSessionService({
    dataRoot: context.dataRoot,
    currentProfileId: context.profileId,
    installation: new ProfileInstallation(path.join(paths.controlRoot, 'installation.json')),
    registry,
    prepareProfileRoot: async (profileRoot) => {
      await validateExistingProfilePath(paths, profileRoot)
      await mkdir(profileRoot, { recursive: true })
    },
    prepareAuthenticatedUserData: context.legacyRoot
      ? async ({ targetProfileRoot }) => {
          const claim = new ProfileClaimService({
            localUserData: context.legacyRoot!,
            targetUserData: path.join(targetProfileRoot, 'userData'),
            journalPath: path.join(paths.controlRoot, 'legacy-claim.json'),
            sqliteValidator: validateSqliteIntegrity
          })
          const preview = await claim.preview()
          if (preview.status === 'already-claimed') return
          if (preview.status === 'unsupported') {
            // 账号 Profile 已有数据时沿用现有数据，登录继续进行；原先的硬失败逻辑保留注释。
            // throw new Error(t('dialog.profile_claim.error.target_not_empty', undefined, resolveSystemLanguage(app.getLocale())))
            return undefined
          }
          if (preview.status === 'staged') {
            return { apply: async () => undefined, commit: () => claim.commit() }
          }
          const decision = await confirmProfileClaim(preview)
          if (!decision)
            throw new Error(
              t('dialog.profile_claim.error.cancelled', undefined, resolveSystemLanguage(app.getLocale()))
            )
          return {
            apply: async () => {
              const result = await claim.confirm({ previewId: preview.previewId, allow: decision.allow })
              if (result.status !== 'claimed')
                throw new Error(
                  t('dialog.profile_claim.error.incomplete', undefined, resolveSystemLanguage(app.getLocale()))
                )
            },
            commit: () => claim.commit()
          }
        }
      : undefined,
    credentialStoreFor: (profileRoot) => new OrgCredentialStore(profileRoot),
    coordinator: new ProfileSwitchCoordinator({
      journal: new ProfileSwitchJournal(path.join(paths.controlRoot, 'switch-journal.json')),
      activePointer,
      // 业务 fence 在登出后保持关闭；登录窗口拥有独立的切换周期。
      fence: loginFence,
      application,
      // Same-process activation is reserved for the last business identity.
      // First login and different accounts fall through to a clean relaunch.
      activateAuthenticated: async (record) => {
        if (!shouldActivateInProcess(record, getLastBusinessIdentityDigest())) return false
        const { buildBusinessLaunchContext, startBusinessRuntime } = await import('./businessStartup')
        const businessContext = buildBusinessLaunchContext(context.dataRoot, record)
        await startBusinessRuntime(businessContext, { rebuildRuntime: true, onVerifyFailure: 'throw' })
        if (!window.isDestroyed()) window.close()
        return true
      }
    }),
    operationId: uuidv4
  })
  const passwordLogin = ORG_SERVER_BASE_URL ? createPasswordProfileLogin(session) : undefined
  // ipcMain.removeHandler(PASSWORD_LOGIN)
  // ipcMain.handle(PASSWORD_LOGIN, async (event, input: unknown) => {
  registerBootstrapHandler(PASSWORD_LOGIN, window, async (event, input: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Untrusted authentication sender')
    }
    if (!passwordLogin) throw new Error('Management server is not configured')
    if (
      !input ||
      typeof input !== 'object' ||
      !('identifier' in input) ||
      !('password' in input) ||
      typeof input.identifier !== 'string' ||
      typeof input.password !== 'string' ||
      input.identifier.length > 320 ||
      input.password.length > 4096
    )
      throw new Error('Invalid login input')
    if (auth.getPhase() === 'authorizing' || auth.getPhase() === 'switching')
      throw new Error('Browser login is in progress')
    // return passwordLogin.login(input.identifier, input.password)
    const result = await passwordLogin.login(input.identifier, input.password)
    if (result.kind === 'teardown-failed') {
      throw new Error('error' in result ? result.error : 'Profile services could not stop cleanly')
    }
    if (result.kind === 'needs-recovery') throw new Error(`Profile switch requires recovery: ${result.stage}`)
    return result
  })
  const auth = new OrgAuthManager({
    credentialStore: new OrgCredentialStore(context.profileRoot),
    profileSession: session,
    fence: loginFence
  })
  const handleAuthError = (error: unknown) => {
    if (!window.isDestroyed()) window.webContents.send('profile-bootstrap:auth-error', String(error))
  }
  const handleAuthUrl = (value: string) => {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return
    }
    // MEA:profile-online-login 旧窗口迟到关闭期间不能消费新登录的回调。
    if (activeBootstrap?.window !== window || window.isDestroyed()) return
    if (url.protocol !== 'meacowork:' || url.hostname.toLowerCase() !== 'auth') return
    void auth.handleAuthCallback(url).catch(handleAuthError)
  }
  const openUrlHandler = (event: Electron.Event, value: string) => {
    event.preventDefault()
    handleAuthUrl(value)
  }
  const secondInstanceHandler = (_event: Electron.Event, argv: string[]) => {
    const value = argv.find((argument) => argument.startsWith('meacowork://auth'))
    if (value) handleAuthUrl(value)
  }
  app.on('open-url', openUrlHandler)
  app.on('second-instance', secondInstanceHandler)
  window.once('closed', () => {
    app.removeListener('open-url', openUrlHandler)
    app.removeListener('second-instance', secondInstanceHandler)
    // ipcMain.removeHandler(ENTERPRISE_LOGIN)
    // ipcMain.removeHandler(PASSWORD_LOGIN)
    passwordLogin?.cancel()
  })
  // ipcMain.handle(ENTERPRISE_LOGIN, async () => {
  registerBootstrapHandler(ENTERPRISE_LOGIN, window, async () => {
    if (passwordLogin?.isBusy) throw new Error('Password login is in progress')
    passwordLogin?.cancel()
    await auth.startLogin()
    return { state: 'authorizing' }
  })
}
