import { mkdir, writeFile } from 'node:fs/promises'
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

import { ProfileActivePointer } from './ProfileActivePointer'
import type { ProfileClaimAllow, ProfileClaimPreview } from './ProfileClaimService'
import { ProfileInstallation } from './ProfileInstallation'
import { createProfilePaths, validateExistingProfilePath } from './ProfilePaths'
import type { ProfileLaunchContext } from './ProfilePrebootCoordinator'
import { ProfileRecoveryActions } from './ProfileRecoveryActions'
import { ProfileRegistry } from './ProfileRegistry'
import { ProfileSessionService } from './ProfileSessionService'
import { ProfileSwitchCoordinator } from './ProfileSwitchCoordinator'
import { ProfileSwitchJournal } from './ProfileSwitchJournal'
// import { profileSwitchFence } from './SwitchFence'
import { SwitchFence } from './SwitchFence'

const PASSWORD_LOGIN = 'profile-bootstrap:password-login'
const ENTERPRISE_LOGIN = 'profile-bootstrap:enterprise-login'
const ADOPT_LEGACY = 'profile-bootstrap:adopt-legacy'
const RETRY_RECOVERY = 'profile-bootstrap:retry-recovery'
const CANCEL_SWITCH = 'profile-bootstrap:cancel-switch'
const SELECT_SIGNED_OUT = 'profile-bootstrap:select-signed-out'
const EXPORT_DIAGNOSTICS = 'profile-bootstrap:export-diagnostics'

export async function confirmProfileClaim(
  preview: Extract<ProfileClaimPreview, { status: 'ready' }>
): Promise<{ copy: boolean; allow: ProfileClaimAllow[] } | null> {
  const included = preview.included.map((item) => item.category).join(', ') || 'none'
  const excluded = preview.excluded.map((item) => item.category).join(', ') || 'none'
  const copy = await dialog.showMessageBox({
    type: 'question',
    title: 'Copy local profile data',
    message: 'Copy local business data into this account profile?',
    detail: `${preview.totalBytes} bytes will be copied. Included: ${included}. Always excluded: ${excluded}. The local profile is kept unchanged.`,
    buttons: ['Copy and continue', 'Continue without copying', 'Cancel login'],
    defaultId: 0,
    cancelId: 2
  })
  if (copy.response === 2) return null
  if (copy.response === 1) return { copy: false, allow: [] }

  const allow: ProfileClaimAllow[] = []
  const ordinaryConfig = await dialog.showMessageBox({
    type: 'question',
    title: 'Include ordinary settings',
    message: 'Also copy ordinary local settings?',
    detail: 'Enterprise resources, sessions, cookies and OAuth credentials remain excluded.',
    buttons: ['Include settings', 'Do not include'],
    defaultId: 1,
    cancelId: 1
  })
  if (ordinaryConfig.response === 0) allow.push('ordinary-config')

  const apiKeys = await dialog.showMessageBox({
    type: 'warning',
    title: 'Include API keys',
    message: 'Also copy locally configured provider API keys?',
    detail: 'API keys are credentials. Only include them when this account profile belongs to the same user.',
    buttons: ['Do not include', 'Include API keys'],
    defaultId: 0,
    cancelId: 0
  })
  if (apiKeys.response === 1) allow.push('api-keys')
  return { copy: true, allow }
}

export function createProfileBootstrapWindow(context: ProfileLaunchContext): BrowserWindow {
  const isLogin = context.mode === 'signed-out' && !context.pendingSwitch
  const window = new BrowserWindow({
    // 原恢复窗口尺寸保留，登录页使用服务端双栏布局。
    width: isLogin ? 1100 : 520,
    height: isLogin ? 760 : 360,
    minWidth: isLogin ? 480 : 520,
    minHeight: isLogin ? 640 : 360,
    resizable: isLogin,
    title: 'MEACowork Profile',
    webPreferences: {
      preload: path.join(__dirname, '../preload/profileBootstrap.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // MEA:profile-online-login Recovery UI must not reuse the candidate business session.
      partition: 'profile-bootstrap'
    }
  })
  if (isLogin) {
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
    return window
  }
  // if (context.mode === 'signed-out' && !context.pendingSwitch) registerSignedOutHandlers(context, window)
  if (context.mode === 'migration-required') registerLegacyAdoptionHandler(context, window)
  if (context.mode === 'recovery' || context.pendingSwitch) registerRecoveryHandlers(context, window)
  const title =
    context.mode === 'signed-out' && !context.pendingSwitch ? 'Choose how to continue' : 'Profile recovery required'
  const detail =
    context.mode === 'migration-required'
      ? 'Existing application data was detected. Migration is required before it can be opened.'
      : context.mode === 'recovery'
        ? 'The profile control state could not be opened safely. No business data was loaded.'
        : context.pendingSwitch
          ? 'A prepared profile switch was interrupted. Retry or cancel it before continuing.'
          : 'No business profile is active. No business data was loaded.'
  const actions =
    context.mode === 'signed-out' && !context.pendingSwitch
      ? `<form id="password-login"><input id="identifier" autocomplete="username" placeholder="Account" required><input id="password" type="password" autocomplete="current-password" placeholder="Password" required><button type="submit">Sign in</button></form><div class="actions"><button id="enterprise">Enterprise login</button></div><p id="status"></p><script>document.getElementById('password-login').onsubmit=async(e)=>{e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;const password=document.getElementById('password');try{await window.profileBootstrap.passwordLogin({identifier:document.getElementById('identifier').value,password:password.value})}catch(error){document.getElementById('status').textContent=String(error)}finally{password.value='';button.disabled=false}};const api=window.profileBootstrap;const status=document.getElementById('status');document.getElementById('enterprise').onclick=async()=>{status.textContent='Opening enterprise login...';try{await api.enterpriseLogin()}catch(e){status.textContent=String(e)}}</script>`
      : context.mode === 'migration-required'
        ? `<div class="actions"><button id="adopt">Copy existing data to local profile</button></div><p id="status"></p><script>const status=document.getElementById('status');document.getElementById('adopt').onclick=async()=>{status.textContent='Verifying and copying data...';try{await window.profileBootstrap.adoptLegacy();status.textContent='Restarting...'}catch(e){status.textContent=String(e)}}</script>`
        : `<div class="actions recovery"><button id="retry">Retry</button><button id="signed-out">Use signed-out</button><button id="diagnostics">Export diagnostics</button>${context.pendingSwitch ? '<button id="cancel-switch">Cancel pending switch</button>' : ''}</div><p id="status"></p><script>const api=window.profileBootstrap;const status=document.getElementById('status');const run=async(label,action)=>{status.textContent=label;try{const result=await action();status.textContent=result?.kind==='cancelled'?'Export cancelled':'Restarting...'}catch(e){status.textContent=String(e)}};document.getElementById('retry').onclick=()=>run('Retrying...',api.retryRecovery);document.getElementById('signed-out').onclick=()=>run('Selecting signed-out profile...',api.selectSignedOut);document.getElementById('diagnostics').onclick=()=>run('Exporting diagnostics...',api.exportDiagnostics);const cancel=document.getElementById('cancel-switch');if(cancel)cancel.onclick=()=>run('Cancelling pending switch...',api.cancelSwitch)</script>`
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

function registerRecoveryHandlers(context: ProfileLaunchContext, window: BrowserWindow): void {
  const channels = [RETRY_RECOVERY, CANCEL_SWITCH, SELECT_SIGNED_OUT, EXPORT_DIAGNOSTICS]
  for (const channel of channels) ipcMain.removeHandler(channel)

  const paths = createProfilePaths(context.dataRoot)
  const registry = new ProfileRegistry(path.join(paths.controlRoot, 'profiles.json'))
  const journal = new ProfileSwitchJournal(path.join(paths.controlRoot, 'switch-journal.json'))
  const actions = new ProfileRecoveryActions({
    context,
    journal,
    registry,
    installation: new ProfileInstallation(path.join(paths.controlRoot, 'installation.json')),
    activePointer: new ProfileActivePointer(path.join(paths.controlRoot, 'active-profile.json'), registry),
    prepareProfileRoot: async (profileId) => {
      const profileRoot = path.join(paths.profilesRoot, profileId)
      await validateExistingProfilePath(paths, profileRoot)
      await mkdir(profileRoot, { recursive: true })
    },
    relaunch: () => application.relaunch(),
    exportDiagnostics: async () => {
      const result = await dialog.showSaveDialog(window, {
        title: 'Export profile recovery diagnostics',
        defaultPath: 'profile-recovery-diagnostics.json',
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
      if (result.canceled || !result.filePath) return { kind: 'cancelled' }
      const [registryState, journalState] = await Promise.all([
        registry.read().then(
          (value) => ({ kind: 'ok' as const, profileKinds: value.profiles.map((profile) => profile.kind) }),
          (error) => ({ kind: 'error' as const, error: error instanceof Error ? error.message : String(error) })
        ),
        journal.read()
      ])
      await writeFile(
        result.filePath,
        `${JSON.stringify(
          {
            version: 1,
            generatedAt: new Date().toISOString(),
            mode: context.mode,
            recoveryReason: context.recoveryReason,
            pendingSwitchOperationId: context.pendingSwitch?.operationId,
            registry: registryState,
            switchJournal: journalState.kind === 'ok' ? { kind: 'ok', phase: journalState.value.phase } : journalState
          },
          null,
          2
        )}\n`,
        { encoding: 'utf8', mode: 0o600 }
      )
      return { kind: 'exported' }
    }
  })

  window.once('closed', () => {
    for (const channel of channels) ipcMain.removeHandler(channel)
  })
  ipcMain.handle(RETRY_RECOVERY, () => actions.retry())
  ipcMain.handle(CANCEL_SWITCH, () => actions.cancelPendingSwitch())
  ipcMain.handle(SELECT_SIGNED_OUT, () => actions.selectSignedOut())
  ipcMain.handle(EXPORT_DIAGNOSTICS, () => actions.exportDiagnostics())
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
    credentialStoreFor: (profileRoot) => new OrgCredentialStore(profileRoot),
    coordinator: new ProfileSwitchCoordinator({
      journal: new ProfileSwitchJournal(path.join(paths.controlRoot, 'switch-journal.json')),
      activePointer,
      // 业务 fence 在登出后保持关闭；登录窗口拥有独立的切换周期。
      fence: loginFence,
      application
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
  const handleAuthUrl = (value: string) => {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return
    }
    if (url.protocol !== 'meacowork:' || url.hostname.toLowerCase() !== 'auth') return
    void auth.handleAuthCallback(url)
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
