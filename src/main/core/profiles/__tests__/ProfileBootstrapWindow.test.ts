import { beforeEach, describe, expect, it, vi } from 'vitest'

const { showMessageBoxMock, ipcMainHandleMock, ipcMainRemoveHandlerMock, passwordLoginMock } = vi.hoisted(() => ({
  passwordLoginMock: vi.fn(),
  showMessageBoxMock: vi.fn(),
  ipcMainHandleMock: vi.fn(),
  ipcMainRemoveHandlerMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: class {
    webContents = { mainFrame: {} }
    webPreferences: unknown = undefined
    constructor(opts: unknown) {
      this.webPreferences = opts
    }
    loadURL = vi.fn()
    loadFile = vi.fn()
    once = vi.fn()
    on = vi.fn()
  },
  dialog: { showMessageBox: showMessageBoxMock },
  ipcMain: { handle: ipcMainHandleMock, removeHandler: ipcMainRemoveHandlerMock }
}))
vi.mock('@application', () => ({ application: {} }))
vi.mock('@main/core/preboot/profileIsolationRuntime', () => ({ adoptLegacyProfile: vi.fn() }))
vi.mock('@main/enterprise/OrgAuthManager', () => ({
  OrgAuthManager: class {
    getPhase = () => 'idle'
  }
}))
vi.mock('@main/enterprise/OrgApiClient', () => ({ ORG_SERVER_BASE_URL: 'https://example.test', ORG_AUTH_MODE: 'management-cookie' }))
vi.mock('@main/enterprise/passwordLoginRuntime', () => ({
  createPasswordProfileLogin: () => ({ login: passwordLoginMock, cancel: vi.fn() })
}))
vi.mock('@main/enterprise/OrgCredentialStore', () => ({ OrgCredentialStore: class {} }))

import { confirmProfileClaim, createProfileBootstrapWindow } from '../ProfileBootstrapWindow'

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
  })

  it('supports continuing without copying local data', async () => {
    showMessageBoxMock.mockResolvedValueOnce({ response: 1 })

    await expect(confirmProfileClaim(preview)).resolves.toEqual({ copy: false, allow: [] })
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

  it('cancels authentication when the user cancels the claim decision', async () => {
    showMessageBoxMock.mockResolvedValueOnce({ response: 2 })

    await expect(confirmProfileClaim(preview)).resolves.toBeNull()
  })
})

describe('createProfileBootstrapWindow', () => {
  beforeEach(() => {
    showMessageBoxMock.mockReset()
    ipcMainHandleMock.mockReset()
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
      expect.stringContaining('/renderer/windows/profileBootstrap/index.html')
    )
    expect(window.webPreferences).toMatchObject({
      width: 1100,
      height: 760,
      webPreferences: { partition: 'profile-bootstrap', contextIsolation: true, nodeIntegration: false, sandbox: true }
    })
    expect(ipcMainHandleMock).not.toHaveBeenCalledWith('profile-bootstrap:enter-local', expect.any(Function))
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

  it('keeps the legacy adoption entry on the migration-required window', () => {
    const context = {
      mode: 'migration-required' as const,
      profileId: 'signed-out',
      identityDigest: SIGNED_OUT_DIGEST,
      kind: 'signed-out' as const,
      dataRoot: '/data',
      profileRoot: '/data/control/recovery-profile'
    }
    const window = createProfileBootstrapWindow(context) as any

    const html = decodeURIComponent(window.loadURL.mock.calls[0][0] as string)
    expect(html).toContain('Copy existing data to local profile')
    expect(ipcMainHandleMock).toHaveBeenCalledWith('profile-bootstrap:adopt-legacy', expect.any(Function))
  })
})
