import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { v4 as uuidv4 } from 'uuid'

import { application } from '@application'
import { adoptLegacyProfile } from '@main/core/preboot/profileIsolationRuntime'
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
import { ProfileSwitchCoordinator } from './ProfileSwitchCoordinator'
import { ProfileSwitchJournal } from './ProfileSwitchJournal'
// import { profileSwitchFence } from './SwitchFence'
import { SwitchFence } from './SwitchFence'

const PASSWORD_LOGIN = 'profile-bootstrap:password-login'
const ENTERPRISE_LOGIN = 'profile-bootstrap:enterprise-login'
const ADOPT_LEGACY = 'profile-bootstrap:adopt-legacy'
const profileBootstrapWindows = new Set<BrowserWindow>()

const translateForBootstrap = (key: string, params?: Record<string, string | number>) =>
  t(key, params, resolveSystemLanguage(app.getLocale()))

export async function confirmProfileClaim(
  preview: Extract<ProfileClaimPreview, { status: 'ready' }>
): Promise<{ copy: boolean; allow: ProfileClaimAllow[] } | null> {
  const categoryLabel = (category: ProfileClaimCategory) => {
    switch (category) {
      case 'api-key':
        return translateForBootstrap('dialog.profile_claim.category.api_key')
      case 'business-data':
        return translateForBootstrap('dialog.profile_claim.category.business_data')
      case 'copilot':
        return translateForBootstrap('dialog.profile_claim.category.copilot')
      case 'credentials':
        return translateForBootstrap('dialog.profile_claim.category.credentials')
      case 'enterprise-resource':
        return translateForBootstrap('dialog.profile_claim.category.enterprise_resource')
      case 'mcp-oauth':
        return translateForBootstrap('dialog.profile_claim.category.mcp_oauth')
      case 'ordinary-config':
        return translateForBootstrap('dialog.profile_claim.category.ordinary_config')
      case 'runtime':
        return translateForBootstrap('dialog.profile_claim.category.runtime')
      case 'sensitive':
        return translateForBootstrap('dialog.profile_claim.category.sensitive')
      case 'session-cookies':
        return translateForBootstrap('dialog.profile_claim.category.session_cookies')
    }
  }
  const included =
    preview.included.map((item) => categoryLabel(item.category)).join(', ') || translateForBootstrap('common.none')
  const excluded =
    preview.excluded.map((item) => categoryLabel(item.category)).join(', ') || translateForBootstrap('common.none')
  const copy = await dialog.showMessageBox({
    type: 'question',
    title: translateForBootstrap('dialog.profile_claim.migrate.title'),
    message: translateForBootstrap('dialog.profile_claim.migrate.message'),
    detail: translateForBootstrap('dialog.profile_claim.migrate.detail', {
      bytes: preview.totalBytes,
      included,
      excluded
    }),
    buttons: [
      translateForBootstrap('dialog.profile_claim.migrate.confirm'),
      translateForBootstrap('dialog.profile_claim.cancel_login')
    ],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })
  if (copy.response === 1) return null

  const allow: ProfileClaimAllow[] = []
  const ordinaryConfig = await dialog.showMessageBox({
    type: 'question',
    title: translateForBootstrap('dialog.profile_claim.settings.title'),
    message: translateForBootstrap('dialog.profile_claim.settings.message'),
    detail: translateForBootstrap('dialog.profile_claim.settings.detail'),
    buttons: [
      translateForBootstrap('dialog.profile_claim.settings.include'),
      translateForBootstrap('dialog.profile_claim.do_not_include')
    ],
    defaultId: 1,
    cancelId: 1
  })
  if (ordinaryConfig.response === 0) allow.push('ordinary-config')

  const apiKeys = await dialog.showMessageBox({
    type: 'warning',
    title: translateForBootstrap('dialog.profile_claim.api_keys.title'),
    message: translateForBootstrap('dialog.profile_claim.api_keys.message'),
    detail: translateForBootstrap('dialog.profile_claim.api_keys.detail'),
    buttons: [
      translateForBootstrap('dialog.profile_claim.do_not_include'),
      translateForBootstrap('dialog.profile_claim.api_keys.include')
    ],
    defaultId: 0,
    cancelId: 0
  })
  if (apiKeys.response === 1) allow.push('api-keys')
  return { copy: true, allow }
}

export function closeProfileBootstrapWindows(): void {
  for (const window of profileBootstrapWindows) {
    if (!window.isDestroyed()) window.close()
  }
  profileBootstrapWindows.clear()
}

export function createProfileBootstrapWindow(context: ProfileLaunchContext): BrowserWindow {
  const isLogin = context.mode === 'signed-out'
  const isBusinessStartup = context.mode === 'business'
  const window = new BrowserWindow({
    // 原恢复窗口尺寸保留，登录页使用服务端双栏布局。
    width: isLogin ? 1100 : isBusinessStartup ? 620 : 520,
    height: isLogin ? 760 : isBusinessStartup ? 460 : 360,
    minWidth: isLogin ? 480 : isBusinessStartup ? 620 : 520,
    minHeight: isLogin ? 640 : isBusinessStartup ? 460 : 360,
    resizable: isLogin,
    show: !isBusinessStartup,
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
  profileBootstrapWindows.add(window)
  window.once('closed', () => profileBootstrapWindows.delete(window))
  if (isLogin || isBusinessStartup) {
    if (isBusinessStartup) {
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
      const startupPath = path.join(__dirname, '../renderer/windows/profileBootstrap/index.html')
      if (process.env['ELECTRON_RENDERER_URL']) {
        void window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/windows/profileBootstrap/index.html?startup=1`)
      } else {
        void window.loadFile(startupPath, { query: { startup: '1' } })
      }
      return window
    }

    registerSignedOutHandlers(context, window)
    const sso = ORG_AUTH_MODE === 'management-oauth' || ORG_AUTH_MODE === 'official-direct'
    if (process.env['ELECTRON_RENDERER_URL']) {
      void window.loadURL(
        `${process.env['ELECTRON_RENDERER_URL']}/windows/profileBootstrap/index.html${sso ? '?sso=1' : ''}`
      )
    } else {
      const loginPath = path.join(__dirname, '../renderer/windows/profileBootstrap/index.html')
      if (sso) void window.loadFile(loginPath, { query: { sso: '1' } })
      else void window.loadFile(loginPath)
    }
    // Cancel login (window closed before any business started) exits the app; a
    // completed same-process activation flips the launch context to 'business'
    // and keeps the process alive.
    window.once('closed', () => {
      // 重启链路会自己拉起新进程，这里再 forceExit 会抢在 app.relaunch 之前结束进程。
      // 注意不能看 isQuitting：登出也会置位，但登出后仍需关闭登录窗即退出。
      if (application.isRelaunching) return
      if (getProfileLaunchContext()?.mode !== 'business') application.forceExit(0)
    })
    return window
  }
  if (context.mode === 'migration-required') registerLegacyAdoptionHandler(context, window)
  const title = translateForBootstrap('dialog.profile_claim.legacy.title')
  const detail = translateForBootstrap('dialog.profile_claim.legacy.detail')
  const actions = `<div class="actions"><button id="adopt">${translateForBootstrap('dialog.profile_claim.legacy.confirm')}</button></div><p id="status"></p><script>const status=document.getElementById('status');document.getElementById('adopt').onclick=async()=>{status.textContent=${JSON.stringify(translateForBootstrap('dialog.profile_claim.legacy.copying'))};try{await window.profileBootstrap.adoptLegacy();status.textContent=${JSON.stringify(translateForBootstrap('dialog.profile_claim.legacy.restarting'))}}catch(e){status.textContent=String(e)}}</script>`
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{margin:0;font:14px system-ui;background:#f5f5f5;color:#202124}main{padding:48px}h1{font-size:22px;margin:0 0 16px}p{line-height:1.6;margin:0;color:#5f6368}.actions{display:flex;gap:12px;margin-top:28px}button{border:1px solid #c7c7c7;background:#fff;padding:10px 16px;border-radius:6px;cursor:pointer}button:last-child{background:#1f1f1f;color:#fff;border-color:#1f1f1f}#status{margin-top:18px}</style><main><h1>${title}</h1><p>${detail}</p>${actions}</main>`
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  return window
}

function registerLegacyAdoptionHandler(context: ProfileLaunchContext, window: BrowserWindow): void {
  ipcMain.removeHandler(ADOPT_LEGACY)
  window.once('closed', () => ipcMain.removeHandler(ADOPT_LEGACY))
  ipcMain.handle(ADOPT_LEGACY, async () => {
    await adoptLegacyProfile(context)
    application.relaunch()
  })
}

function registerSignedOutHandlers(context: ProfileLaunchContext, window: BrowserWindow): void {
  ipcMain.removeHandler(ENTERPRISE_LOGIN)
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
            // throw new Error(translateForBootstrap('dialog.profile_claim.error.target_not_empty'))
            return undefined
          }
          if (preview.status === 'staged') {
            return { apply: async () => undefined, commit: () => claim.commit() }
          }
          const decision = await confirmProfileClaim(preview)
          if (!decision) throw new Error(translateForBootstrap('dialog.profile_claim.error.cancelled'))
          return {
            apply: async () => {
              const result = await claim.confirm({ previewId: preview.previewId, allow: decision.allow })
              if (result.status !== 'claimed')
                throw new Error(translateForBootstrap('dialog.profile_claim.error.incomplete'))
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
  ipcMain.removeHandler(PASSWORD_LOGIN)
  ipcMain.handle(PASSWORD_LOGIN, async (event, input: unknown) => {
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
    ipcMain.removeHandler(ENTERPRISE_LOGIN)
    ipcMain.removeHandler(PASSWORD_LOGIN)
    passwordLogin?.cancel()
  })
  ipcMain.handle(ENTERPRISE_LOGIN, async () => {
    if (passwordLogin?.isBusy) throw new Error('Password login is in progress')
    passwordLogin?.cancel()
    await auth.startLogin()
    return { state: 'authorizing' }
  })
}
