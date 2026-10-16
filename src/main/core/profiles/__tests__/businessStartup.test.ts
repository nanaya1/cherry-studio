import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ProfilePathsModule from '../ProfilePaths'

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  verify: vi.fn(),
  bootstrap: vi.fn(),
  migrate: vi.fn(),
  mark: vi.fn(),
  register: vi.fn(),
  prepare: vi.fn(),
  rebind: vi.fn(),
  recover: vi.fn(),
  loadServiceRegistry: vi.fn(),
  migration: vi.fn(),
  commitPointer: vi.fn(),
  requireActivatable: vi.fn()
}))
vi.mock('@application', () => ({
  application: {
    prepareProfileRuntime: mocks.prepare,
    registerAll: mocks.register,
    bootstrap: mocks.bootstrap
  }
}))
vi.mock('electron', () => ({
  app: {
    setPath: vi.fn((name) => mocks.order.push(name)),
    setAppLogsPath: vi.fn(),
    requestSingleInstanceLock: vi.fn(),
    whenReady: vi.fn(async () => {})
  }
}))
vi.mock('@logger', () => ({ loggerService: { rebind: mocks.rebind, withContext: () => ({ info: vi.fn() }) } }))
vi.mock('node:fs', () => ({ default: { mkdirSync: vi.fn() } }))
vi.mock('@electron-toolkit/utils', () => ({ electronApp: { setAppUserModelId: vi.fn() } }))
vi.mock('@main/core/profiles', async () => ({
  ...(await import('../ProfileRuntimeContext')),
  createProfileBootstrapWindow: mocks.recover,
  ...(await import('../SwitchFence')),
  ...(await import('../ProfilePaths'))
}))
vi.mock('../ProfilePaths', async (importOriginal) => ({
  ...(await importOriginal<typeof ProfilePathsModule>()),
  validateExistingProfilePath: vi.fn(async () => {})
}))
vi.mock('../ProfileRegistry', () => ({
  SIGNED_OUT_DIGEST: 'signed-out-digest',
  ProfileRegistry: class {
    requireActivatable = mocks.requireActivatable
  }
}))
vi.mock('../ProfileActivePointer', () => ({
  ProfileActivePointer: class {
    commitPointer = mocks.commitPointer
  }
}))
vi.mock('../ProfileBootstrapWindow', () => ({ createProfileBootstrapWindow: mocks.recover }))
vi.mock('@main/core/preboot/profileIsolationRuntime', () => ({
  buildSignedOutLaunchContext: (dataRoot: string) => ({
    mode: 'signed-out',
    kind: 'signed-out',
    profileId: 'signed-out',
    identityDigest: 'signed-out-digest',
    dataRoot,
    profileRoot: `${dataRoot}/profiles/signed-out`
  }),
  verifyBusinessCandidate: mocks.verify,
  migrateProfileSensitiveData: mocks.migrate,
  markProfileBootSuccessful: mocks.mark
}))
vi.mock('@main/core/preboot/backupRestoreGate', () => ({ runBackupRestoreGate: vi.fn() }))
vi.mock('@main/core/preboot/v2MigrationGate', () => ({ runV2MigrationGate: mocks.migration }))
vi.mock('@main/core/application/serviceRegistry', () => {
  mocks.loadServiceRegistry()
  return { getServiceListForProfileMode: () => [], serviceList: [] }
})
vi.mock('@main/services/dataReset', () => ({ runDataReset: vi.fn() }))
vi.mock('@main/services/userDataRelocation', () => ({ runUserDataRelocation: vi.fn() }))
vi.mock('@main/utils/appEdition', () => ({ getApplicationId: () => 'test' }))
vi.mock('../../../ipc', () => ({ registerIpc: vi.fn() }))
vi.mock('../../../services/VersionService', () => ({ versionService: { recordCurrentVersion: vi.fn() } }))

import { startBusinessRuntime } from '../businessStartup'
const serviceRegistryLoadedDuringImport = mocks.loadServiceRegistry.mock.calls.length > 0
import type { ProfileLaunchContext } from '../ProfilePrebootCoordinator'
import {
  profileBusinessAccessGate,
  getLastBusinessIdentityDigest,
  setProfileLaunchContext,
  shouldActivateInProcess
} from '../ProfileRuntimeContext'
import { profileSwitchFence } from '../SwitchFence'

const context: ProfileLaunchContext = {
  mode: 'business',
  kind: 'authenticated',
  profileId: 'a'.repeat(32),
  identityDigest: 'b'.repeat(64),
  dataRoot: '/data',
  profileRoot: '/data/profiles/account'
}

describe('业务账号激活决策', () => {
  it('首次允许任意账号，同账号可复用，不同账号必须重启', () => {
    const record = { kind: 'authenticated', identityDigest: context.identityDigest }
    expect(shouldActivateInProcess(record, null)).toBe(true)
    expect(shouldActivateInProcess(record, context.identityDigest)).toBe(true)
    expect(shouldActivateInProcess(record, 'c'.repeat(64))).toBe(false)
  })

  it('登出上下文保留本进程最后业务账号', () => {
    setProfileLaunchContext(context)
    setProfileLaunchContext(undefined)
    expect(getLastBusinessIdentityDigest()).toBe(context.identityDigest)
  })
})

describe('同进程业务启动', () => {
  it('导入启动模块时不提前加载服务注册表', () => {
    expect(serviceRegistryLoadedDuringImport).toBe(false)
  })

  beforeEach(() => {
    vi.resetAllMocks()
    mocks.order.length = 0
    profileSwitchFence.resetForTesting()
    mocks.verify.mockResolvedValue({ kind: 'verified' })
    mocks.bootstrap.mockResolvedValue(true)
    mocks.prepare.mockImplementation(() => mocks.order.push('prepare'))
    mocks.requireActivatable.mockResolvedValue({ profileId: 'signed-out', kind: 'signed-out' })
    mocks.commitPointer.mockResolvedValue({ durability: { kind: 'committed-confirmed' } })
  })

  it('路径先更新，验证通过后才重开业务 fence 并启动服务', async () => {
    profileSwitchFence.beginSwitch('logout')
    mocks.verify.mockImplementation(async () => {
      expect(profileSwitchFence.state.kind).toBe('switching')
      return { kind: 'verified' }
    })
    mocks.register.mockImplementation(() => {
      expect(profileSwitchFence.state.kind).toBe('open')
      expect(profileBusinessAccessGate.state.kind).toBe('verified-online')
    })
    await startBusinessRuntime(context, { rebuildRuntime: true, onVerifyFailure: 'throw' })
    expect(mocks.order.indexOf('sessionData')).toBeLessThan(mocks.order.indexOf('prepare'))
    expect(mocks.rebind).toHaveBeenCalledWith('/data/profiles/account/logs')
    expect(mocks.mark).toHaveBeenCalledWith(context)
  })

  it('验证失败保持 fence 关闭且不注册服务', async () => {
    profileSwitchFence.beginSwitch('logout')
    mocks.verify.mockResolvedValue({ kind: 'failed', reason: 'denied' })
    await expect(startBusinessRuntime(context, { rebuildRuntime: true, onVerifyFailure: 'throw' })).rejects.toThrow(
      'denied'
    )
    expect(profileSwitchFence.state.kind).toBe('switching')
    expect(mocks.register).not.toHaveBeenCalled()
  })

  it('冷启动身份验证失败直接进入隔离的登录页，不启动业务服务', async () => {
    mocks.verify.mockResolvedValue({
      kind: 'failed',
      reason: 'login expired',
      failureContext: { ...context, mode: 'recovery' }
    })
    await startBusinessRuntime({ ...context, legacyRoot: '/legacy' })
    expect(mocks.commitPointer).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'signed-out' }))
    expect(mocks.recover).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'signed-out', profileRoot: '/data/profiles/signed-out', legacyRoot: '/legacy' })
    )
    expect(mocks.rebind).toHaveBeenCalledWith('/data/profiles/signed-out/logs')
    expect(mocks.prepare).toHaveBeenCalledOnce()
    expect(mocks.register).not.toHaveBeenCalled()
    expect(mocks.bootstrap).not.toHaveBeenCalled()
    expect(mocks.migrate).not.toHaveBeenCalled()
    expect(mocks.mark).not.toHaveBeenCalled()
  })

  it('未登录状态无法可靠保存时保留恢复页，不打开登录空间', async () => {
    const failureContext = { ...context, mode: 'recovery' }
    mocks.verify.mockResolvedValue({ kind: 'failed', reason: 'expired', failureContext })
    mocks.commitPointer.mockResolvedValue({ durability: { kind: 'committed-durability-unknown' } })
    await startBusinessRuntime(context)
    expect(mocks.recover).toHaveBeenCalledWith(failureContext)
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.register).not.toHaveBeenCalled()
  })

  it('bootstrap 返回失败不能报告激活成功', async () => {
    mocks.bootstrap.mockResolvedValue(false)
    await expect(startBusinessRuntime(context, { rebuildRuntime: true, onVerifyFailure: 'throw' })).rejects.toThrow()
    expect(mocks.mark).not.toHaveBeenCalled()
  })

  it('迁移接管启动时不能关闭登录窗口并报告激活成功', async () => {
    mocks.migration.mockResolvedValue('handled')
    await expect(startBusinessRuntime(context, { rebuildRuntime: true, onVerifyFailure: 'throw' })).rejects.toThrow()
    expect(mocks.bootstrap).not.toHaveBeenCalled()
    expect(mocks.mark).not.toHaveBeenCalled()
  })

  it('失败态 fence 不可重开，也不可启动服务', async () => {
    profileSwitchFence.beginSwitch('logout')
    profileSwitchFence.markTeardownFailed('timeout')
    await expect(startBusinessRuntime(context, { rebuildRuntime: true, onVerifyFailure: 'throw' })).rejects.toThrow()
    expect(mocks.register).not.toHaveBeenCalled()
  })
})
