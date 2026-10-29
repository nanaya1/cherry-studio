import { beforeEach, describe, expect, it, vi } from 'vitest'

import { application } from '@application'
import { createPasswordProfileLogin } from '@main/enterprise/passwordLoginRuntime'

import { setProfileLaunchContext } from '../ProfileRuntimeContext'

const {
  appOnMock,
  authCallbackMock,
  loadFileMock,
  showMessageBoxMock,
  ipcMainHandleMock,
  ipcMainRemoveHandlerMock,
  passwordLoginMock,
  resolveSystemLanguageMock,
  translateMock
} = vi.hoisted(() => ({
  appOnMock: vi.fn(),
  authCallbackMock: vi.fn(() => Promise.resolve()),
  loadFileMock: vi.fn(() => Promise.resolve()),
  passwordLoginMock: vi.fn(),
  showMessageBoxMock: vi.fn(),
  ipcMainHandleMock: vi.fn(),
  ipcMainRemoveHandlerMock: vi.fn(),
  resolveSystemLanguageMock: vi.fn(() => 'zh-CN'),
  translateMock: vi.fn((key: string, params?: Record<string, string | number>, language?: string) => {
    void language
    return params ? `${key}:${JSON.stringify(params)}` : key
  })
}))

vi.mock('electron', () => ({
  app: { getLocale: () => 'zh-CN', on: appOnMock, removeListener: vi.fn() },
  BrowserWindow: class {
    webContents = { mainFrame: {}, once: vi.fn(), on: vi.fn() }
    webPreferences: unknown = undefined
    constructor(opts: unknown) {
      this.webPreferences = opts
    }
    loadURL = vi.fn(() => Promise.resolve())
    loadFile = loadFileMock
    hide = vi.fn()
    focus = vi.fn()
    isMinimized = vi.fn(() => false)
    restore = vi.fn()
    once = vi.fn()
    on = vi.fn()
    show = vi.fn()
    close = vi.fn()
    isDestroyed = vi.fn(() => false)
  },
  dialog: { showMessageBox: showMessageBoxMock, showErrorBox: showMessageBoxMock },
  ipcMain: { handle: ipcMainHandleMock, removeHandler: ipcMainRemoveHandlerMock }
}))
vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  return mockApplicationFactory()
})
vi.mock('@main/core/preboot/profileIsolationRuntime', () => ({ adoptLegacyProfile: vi.fn() }))
vi.mock('@main/i18n', () => ({ resolveSystemLanguage: resolveSystemLanguageMock, t: translateMock }))
vi.mock('@main/enterprise/OrgAuthManager', () => ({
  OrgAuthManager: class {
    getPhase = () => 'idle'
    handleAuthCallback = authCallbackMock
  }
}))
vi.mock('@main/enterprise/OrgApiClient', () => ({
  ORG_SERVER_BASE_URL: 'https://example.test',
  ORG_AUTH_MODE: 'management-cookie'
}))
vi.mock('@main/enterprise/passwordLoginRuntime', () => ({
  createPasswordProfileLogin: vi.fn(() => ({ login: passwordLoginMock, cancel: vi.fn() }))
}))
vi.mock('@main/enterprise/OrgCredentialStore', () => ({ OrgCredentialStore: class {} }))

import {
  closeProfileBootstrapWindows,
  confirmProfileClaim,
  createProfileBootstrapWindow
} from '../ProfileBootstrapWindow'

const SIGNED_OUT_DIGEST = 'f'.repeat(64)
const preview = {
  status: 'ready' as const,
  previewId: '550e8400-e29b-41d4-a716-446655440000',
  totalBytes: 1024,
  included: [{ category: 'business-data' as const, bytes: 1024, paths: ['Data/app.db'], credential: false }],
  excluded: [{ category: 'credentials' as const, bytes: 12, paths: ['Credentials'], credential: true }]
}

describe('confirmProfileClaim', () => {
  beforeEach(() => {
    showMessageBoxMock.mockReset()
    ipcMainHandleMock.mockReset()
    translateMock.mockClear()
  })

  it('localizes every migration dialog and interpolates the preview summary', async () => {
    showMessageBoxMock
      .mockResolvedValueOnce({ response: 0 })
      .mockResolvedValueOnce({ response: 1 })
      .mockResolvedValueOnce({ response: 0 })

    await confirmProfileClaim(preview)

    expect(showMessageBoxMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        title: 'dialog.profile_claim.migrate.title',
        message: 'dialog.profile_claim.migrate.message',
        detail:
          'dialog.profile_claim.migrate.detail:{"bytes":1024,"included":"dialog.profile_claim.category.business_data","excluded":"dialog.profile_claim.category.credentials"}',
        buttons: ['dialog.profile_claim.migrate.confirm', 'dialog.profile_claim.cancel_login']
      })
    )
    expect(showMessageBoxMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        title: 'dialog.profile_claim.settings.title',
        message: 'dialog.profile_claim.settings.message',
        detail: 'dialog.profile_claim.settings.detail',
        buttons: ['dialog.profile_claim.settings.include', 'dialog.profile_claim.do_not_include']
      })
    )
    expect(showMessageBoxMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        title: 'dialog.profile_claim.api_keys.title',
        message: 'dialog.profile_claim.api_keys.message',
        detail: 'dialog.profile_claim.api_keys.detail',
        buttons: ['dialog.profile_claim.do_not_include', 'dialog.profile_claim.api_keys.include']
      })
    )
    expect(resolveSystemLanguageMock).toHaveBeenCalledWith('zh-CN')
    expect(translateMock).toHaveBeenCalled()
    expect(translateMock.mock.calls.every(([, , language]) => language === 'zh-CN')).toBe(true)
  })

  it('cancels the current authentication when the migration prompt is closed', async () => {
    showMessageBoxMock.mockResolvedValueOnce({ response: 1 })

    await expect(confirmProfileClaim(preview)).resolves.toBeNull()
    expect(showMessageBoxMock).toHaveBeenCalledTimes(1)
  })

  it('requires explicit choices before including ordinary config and API keys', async () => {
    showMessageBoxMock
      .mockResolvedValueOnce({ response: 0 })
      .mockResolvedValueOnce({ response: 0 })
      .mockResolvedValueOnce({ response: 1 })

    await expect(confirmProfileClaim(preview)).resolves.toEqual({
      copy: true,
      allow: ['ordinary-config', 'api-keys']
    })
  })

  it('cancels authentication when the user chooses cancel', async () => {
    showMessageBoxMock.mockResolvedValueOnce({ response: 1 })

    await expect(confirmProfileClaim(preview)).resolves.toBeNull()
  })
})

const loginContext = {
  mode: 'signed-out' as const,
  profileId: 'signed-out',
  identityDigest: SIGNED_OUT_DIGEST,
  kind: 'signed-out' as const,
  dataRoot: '/data',
  profileRoot: '/data/profiles/signed-out'
}

function emitWindow(window: any, event: string, ...args: unknown[]) {
  for (const [, listener] of window.once.mock.calls.filter(([name]: [string]) => name === event)) listener(...args)
}

function failLoad(window: any, isMainFrame: boolean) {
  const calls = [...window.webContents.once.mock.calls, ...(window.webContents.on?.mock.calls ?? [])]
  for (const [, listener] of calls.filter(([name]: [string]) => name === 'did-fail-load')) {
    listener({}, -6, 'ERR_FILE_NOT_FOUND', 'file:///bootstrap.html', isMainFrame)
  }
}

describe('createProfileBootstrapWindow', () => {
  beforeEach(() => {
    closeProfileBootstrapWindows()
    loadFileMock.mockClear()
    appOnMock.mockClear()
    authCallbackMock.mockClear()
    showMessageBoxMock.mockReset().mockResolvedValue({ response: 0 })
    ipcMainHandleMock.mockReset()
    ipcMainRemoveHandlerMock.mockClear()
    vi.mocked(application.forceExit).mockClear()
    Object.assign(application, { isRelaunching: false })
    setProfileLaunchContext(loginContext)
  })

  it('does not attach legacy data import to login even when a legacy root exists', () => {
    createProfileBootstrapWindow({ ...loginContext, legacyRoot: '/legacy' })

    const session = vi.mocked(createPasswordProfileLogin).mock.lastCall?.[0]
    expect(session).toBeDefined()
    const dependencies = (session as unknown as { dependencies: { prepareAuthenticatedUserData?: unknown } })
      .dependencies
    expect(dependencies.prepareAuthenticatedUserData).toBeUndefined()
  })

  it('exits on user cancellation but not when a login window is superseded', () => {
    const first = createProfileBootstrapWindow(loginContext) as any
    const second = createProfileBootstrapWindow({ ...loginContext, legacyRoot: '/legacy' }) as any
    emitWindow(first, 'closed')
    expect(application.forceExit).not.toHaveBeenCalled()
    emitWindow(second, 'closed')
    expect(application.forceExit).toHaveBeenCalledWith(0)
  })

  it.each(['activation', 'relaunch'])('does not exit on successful %s', (reason) => {
    const window = createProfileBootstrapWindow(loginContext) as any
    if (reason === 'activation') setProfileLaunchContext({ ...loginContext, mode: 'business' })
    else Object.assign(application, { isRelaunching: true })
    emitWindow(window, 'closed')
    expect(application.forceExit).not.toHaveBeenCalled()
  })

  it('consumes a rejected load promise once even when did-fail-load also fires', async () => {
    loadFileMock.mockRejectedValueOnce(new Error('ERR_FILE_NOT_FOUND'))
    const window = createProfileBootstrapWindow(loginContext) as any
    await Promise.resolve()
    failLoad(window, true)
    emitWindow(window, 'ready-to-show')
    expect(window.close).toHaveBeenCalledOnce()
    expect(window.show).not.toHaveBeenCalled()
    expect(showMessageBoxMock).toHaveBeenCalledOnce()
  })

  it('reuses the same complete context without registering another login runtime', () => {
    const first = createProfileBootstrapWindow(loginContext)
    const count = ipcMainHandleMock.mock.calls.length
    const second = createProfileBootstrapWindow({ ...loginContext })
    expect(second).toBe(first)
    expect(ipcMainHandleMock.mock.calls).toHaveLength(count)
    expect((first as any).show).not.toHaveBeenCalled()
  })

  it.each([
    { identityDigest: 'a'.repeat(64) },
    { profileId: 'other' },
    { profileRoot: '/other/profile' },
    { dataRoot: '/other' },
    { kind: 'local' as const },
    { legacyRoot: '/legacy' },
    { pendingSwitch: { operationId: 'retry-1', action: 'retry-or-cancel' as const } }
  ])('replaces a different authentication context: %j', (change) => {
    const first = createProfileBootstrapWindow(loginContext) as any
    const second = createProfileBootstrapWindow({ ...loginContext, ...change })
    expect(second).not.toBe(first)
    expect(first.close).toHaveBeenCalledOnce()
  })

  it('rejects IPC from a replaced window even before its closed event arrives', async () => {
    const first = createProfileBootstrapWindow(loginContext) as any
    const oldHandler = ipcMainHandleMock.mock.calls.find(
      ([channel]) => channel === 'profile-bootstrap:password-login'
    )![1]
    createProfileBootstrapWindow({ ...loginContext, legacyRoot: '/legacy' })
    await expect(async () =>
      oldHandler(
        { sender: first.webContents, senderFrame: first.webContents.mainFrame },
        { identifier: 'test-user', password: 'test-password' }
      )
    ).rejects.toThrow('Untrusted authentication sender')
  })

  it('routes OAuth callbacks only to the current window while the replaced window is closing', () => {
    createProfileBootstrapWindow(loginContext)
    createProfileBootstrapWindow({ ...loginContext, legacyRoot: '/legacy' })
    for (const [event, handler] of appOnMock.mock.calls) {
      if (event === 'open-url') handler({ preventDefault: vi.fn() }, 'meacowork://auth?code=test')
    }
    expect(authCallbackMock).toHaveBeenCalledOnce()
    for (const [event, handler] of appOnMock.mock.calls) {
      if (event === 'second-instance') handler({}, ['app', 'meacowork://auth?code=test'])
    }
    expect(authCallbackMock).toHaveBeenCalledTimes(2)
  })

  it('keeps replacement login IPC handlers when the old window closes late', () => {
    const first = createProfileBootstrapWindow(loginContext) as any
    const second = createProfileBootstrapWindow({ ...loginContext, legacyRoot: '/legacy' }) as any
    ipcMainRemoveHandlerMock.mockClear()
    emitWindow(first, 'closed')
    expect(ipcMainRemoveHandlerMock).not.toHaveBeenCalledWith('profile-bootstrap:password-login')
    expect(ipcMainRemoveHandlerMock).not.toHaveBeenCalledWith('profile-bootstrap:enterprise-login')
    emitWindow(second, 'closed')
    expect(ipcMainRemoveHandlerMock).toHaveBeenCalledWith('profile-bootstrap:password-login')
  })

  it('keeps login hidden until ready and never shows it after a main-frame failure', async () => {
    const window = createProfileBootstrapWindow(loginContext) as any
    expect(window.webPreferences.show).toBe(false)
    failLoad(window, false)
    expect(window.close).not.toHaveBeenCalled()
    failLoad(window, true)
    emitWindow(window, 'ready-to-show')
    await Promise.resolve()
    expect(window.show).not.toHaveBeenCalled()
    expect(window.close).toHaveBeenCalledOnce()
    expect(showMessageBoxMock).toHaveBeenCalledOnce()
  })

  it('closes every live bootstrap window after same-process business activation', () => {
    const first = createProfileBootstrapWindow({
      mode: 'signed-out',
      profileId: 'signed-out',
      identityDigest: SIGNED_OUT_DIGEST,
      kind: 'signed-out',
      dataRoot: '/data',
      profileRoot: '/data/profiles/signed-out'
    }) as any
    const second = createProfileBootstrapWindow({
      mode: 'business',
      profileId: 'profile-1',
      identityDigest: 'a'.repeat(64),
      kind: 'authenticated',
      dataRoot: '/data',
      profileRoot: '/data/profiles/profile-1'
    }) as any

    closeProfileBootstrapWindows()

    expect(first.close).toHaveBeenCalledOnce()
    expect(second.close).toHaveBeenCalledOnce()
  })

  it('opens the standalone login renderer without loading business data on the signed-out window', () => {
    const context = {
      mode: 'signed-out' as const,
      profileId: 'signed-out',
      identityDigest: SIGNED_OUT_DIGEST,
      kind: 'signed-out' as const,
      dataRoot: '/data',
      profileRoot: '/data/profiles/signed-out'
    }
    const window = createProfileBootstrapWindow(context) as any

    expect(window.loadFile).toHaveBeenCalledWith(
      expect.stringMatching(/renderer[\\/]windows[\\/]profileBootstrap[\\/]index\.html/)
    )
    expect(window.webPreferences).toMatchObject({
      width: 1100,
      height: 760,
      webPreferences: { partition: 'profile-bootstrap', contextIsolation: true, nodeIntegration: false, sandbox: true }
    })
    expect(ipcMainHandleMock).not.toHaveBeenCalledWith('profile-bootstrap:enter-local', expect.any(Function))
  })

  it('opens the workspace startup page hidden until the renderer is ready', () => {
    const window = createProfileBootstrapWindow({
      mode: 'business',
      profileId: 'profile-1',
      identityDigest: 'a'.repeat(64),
      kind: 'authenticated',
      dataRoot: '/data',
      profileRoot: '/data/profiles/profile-1'
    }) as any

    expect(window.loadFile).toHaveBeenCalledWith(
      expect.stringMatching(/renderer[\\/]windows[\\/]profileBootstrap[\\/]index\.html/),
      { query: { startup: '1' } }
    )
    expect(window.webPreferences).toMatchObject({
      width: 620,
      height: 460,
      show: false
    })
    expect(window.show).not.toHaveBeenCalled()

    const readyToShowHandler = window.once.mock.calls.find(([event]: [string]) => event === 'ready-to-show')?.[1]
    expect(readyToShowHandler).toEqual(expect.any(Function))
    readyToShowHandler()

    expect(window.show).toHaveBeenCalledTimes(1)
  })

  it('closes the workspace startup page when the main frame fails to load', () => {
    const window = createProfileBootstrapWindow({
      mode: 'business',
      profileId: 'profile-1',
      identityDigest: 'a'.repeat(64),
      kind: 'authenticated',
      dataRoot: '/data',
      profileRoot: '/data/profiles/profile-1'
    }) as any

    const didFailLoadHandler = window.webContents.on.mock.calls.find(
      ([event]: [string]) => event === 'did-fail-load'
    )?.[1]
    expect(didFailLoadHandler).toEqual(expect.any(Function))

    didFailLoadHandler({}, -6, 'ERR_FILE_NOT_FOUND', 'file:///startup.html', true)

    expect(window.close).toHaveBeenCalledTimes(1)
  })

  it('ignores subframe load failures for the workspace startup page', () => {
    const window = createProfileBootstrapWindow({
      mode: 'business',
      profileId: 'profile-1',
      identityDigest: 'a'.repeat(64),
      kind: 'authenticated',
      dataRoot: '/data',
      profileRoot: '/data/profiles/profile-1'
    }) as any

    const didFailLoadHandler = window.webContents.on.mock.calls.find(
      ([event]: [string]) => event === 'did-fail-load'
    )?.[1]
    didFailLoadHandler({}, -6, 'ERR_FILE_NOT_FOUND', 'file:///subframe.html', false)

    expect(window.close).not.toHaveBeenCalled()
  })

  it('reports a failed account switch to the login form instead of resolving as success', async () => {
    const window = createProfileBootstrapWindow({
      mode: 'signed-out',
      profileId: 'signed-out',
      identityDigest: SIGNED_OUT_DIGEST,
      kind: 'signed-out',
      dataRoot: '/data',
      profileRoot: '/data/profiles/signed-out'
    }) as any
    passwordLoginMock.mockResolvedValueOnce({ kind: 'teardown-failed', error: 'Auth session process failed' })
    const handler = ipcMainHandleMock.mock.calls.find(([channel]) => channel === 'profile-bootstrap:password-login')![1]
    await expect(
      handler(
        { sender: window.webContents, senderFrame: window.webContents.mainFrame },
        {
          identifier: 'test-user',
          password: 'test-password'
        }
      )
    ).rejects.toThrow('Auth session process failed')
  })

  it('opens login first when legacy data exists instead of showing the pre-login migration page', () => {
    const context = {
      mode: 'signed-out' as const,
      profileId: 'signed-out',
      identityDigest: SIGNED_OUT_DIGEST,
      kind: 'signed-out' as const,
      dataRoot: '/data',
      profileRoot: '/data/profiles/signed-out',
      legacyRoot: '/legacy'
    }
    const window = createProfileBootstrapWindow(context) as any

    expect(window.loadFile).toHaveBeenCalledWith(
      expect.stringMatching(/renderer[\\/]windows[\\/]profileBootstrap[\\/]index\.html/)
    )
    expect(ipcMainHandleMock).not.toHaveBeenCalledWith('profile-bootstrap:adopt-legacy', expect.any(Function))
  })

  it('uses the isolated login renderer for the signed-out fallback', () => {
    const window = createProfileBootstrapWindow({
      mode: 'signed-out',
      profileId: 'signed-out',
      identityDigest: SIGNED_OUT_DIGEST,
      kind: 'signed-out',
      dataRoot: '/data',
      profileRoot: '/data/profiles/signed-out'
    }) as any

    expect(window.loadFile).toHaveBeenCalledWith(
      expect.stringMatching(/renderer[\\/]windows[\\/]profileBootstrap[\\/]index\.html/)
    )
    expect(ipcMainHandleMock).toHaveBeenCalledWith('profile-bootstrap:password-login', expect.any(Function))
  })
})
