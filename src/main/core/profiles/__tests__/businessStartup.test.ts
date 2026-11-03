import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ProfilePathsModule from '../ProfilePaths'

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  verify: vi.fn(),
  bootstrap: vi.fn(),
  migrate: vi.fn(),
  begin: vi.fn(),
  mark: vi.fn(),
  register: vi.fn(),
  prepare: vi.fn(),
  rebind: vi.fn(),
  recover: vi.fn(),
  loadServiceRegistry: vi.fn(),
  migration: vi.fn(),
  migrateBrandDataFiles: vi.fn(),
  commitPointer: vi.fn(),
  requireActivatable: vi.fn()
}))
vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  const result = mockApplicationFactory()
  Object.assign(result.application, {
    prepareProfileRuntime: mocks.prepare,
    registerAll: mocks.register,
    bootstrap: mocks.bootstrap,
    getPath: vi.fn(() => '/mock/userData')
  })
  return result
})
vi.mock('electron', () => ({
  app: {
    getLocale: () => 'zh-CN',
    setPath: vi.fn((name) => mocks.order.push(name)),
    setAppLogsPath: vi.fn(),
    requestSingleInstanceLock: vi.fn(),
    whenReady: vi.fn(async () => {})
  },
  dialog: { showErrorBox: vi.fn(), showMessageBoxSync: vi.fn(() => 1) }
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
vi.mock('../ProfileSwitchJournal', () => ({
  ProfileSwitchJournal: class {
    prepare = vi.fn(async () => ({ durability: { kind: 'committed-confirmed' } }))
    commit = vi.fn(async () => ({ durability: { kind: 'committed-confirmed' } }))
    cancel = vi.fn()
  }
}))
vi.mock('../ProfileActivePointer', () => ({
  ProfileActivePointer: class {
    commitPointer = mocks.commitPointer
  }
}))
vi.mock('../ProfileBootstrapWindow', () => ({
  createProfileBootstrapWindow: mocks.recover,
  closeProfileBootstrapWindows: vi.fn()
}))
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
  beginProfileBootAttempt: mocks.begin,
  markProfileBootSuccessful: mocks.mark
}))
vi.mock('@main/core/preboot/backupRestoreGate', () => ({ runBackupRestoreGate: vi.fn() }))
vi.mock('@main/core/preboot/brandDataFileMigration', () => ({
  BrandDataFileMigrationError: class extends Error {},
  migrateBrandDataFiles: mocks.migrateBrandDataFiles
}))
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
  getProfileLaunchContext,
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
  it('首次登录必须重启以在业务窗口创建前应用账号路径，同账号可复用，不同账号必须重启', () => {
    const record = { kind: 'authenticated', identityDigest: context.identityDigest }
    expect(shouldActivateInProcess(record, null)).toBe(false)
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
    expect(mocks.rebind).toHaveBeenCalledWith(expect.stringMatching(/[\\/]data[\\/]profiles[\\/]account[\\/]logs/))
    expect(mocks.migrateBrandDataFiles).toHaveBeenCalledWith('/mock/userData')
    expect(mocks.mark).toHaveBeenCalledWith(context)
  })

  it('同进程重建必须自己开启 boot attempt，否则成功标记找不到可关闭的尝试', async () => {
    mocks.begin.mockImplementation(async () => {
      expect(mocks.verify).not.toHaveBeenCalled()
      expect(mocks.register).not.toHaveBeenCalled()
    })
    await startBusinessRuntime(context, { rebuildRuntime: true, onVerifyFailure: 'throw' })
    expect(mocks.begin).toHaveBeenCalledWith(context)
    expect(mocks.mark).toHaveBeenCalledWith(context)
  })

  it('冷启动的 boot attempt 仍由 preboot 负责，不重复开启', async () => {
    await startBusinessRuntime(context)
    expect(mocks.begin).not.toHaveBeenCalled()
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

  /* 原恢复窗口测试保留，统一登录回归覆盖见下方。
  it('冷启动网络失败保留候选和凭据，不提交 signed-out 或启动业务', async () => {
    mocks.verify.mockResolvedValue({
      kind: 'failed',
      reason: 'network unavailable',
      failureKind: 'unavailable',
      failureContext: { ...context, mode: 'signed-out' }
    })
    const candidate = { ...context, legacyRoot: '/legacy' }
    await startBusinessRuntime(candidate)
    expect(mocks.recover).toHaveBeenCalledWith(
      candidate,
      expect.objectContaining({
        startupRecovery: expect.objectContaining({ failureKind: 'unavailable', retry: expect.any(Function) })
      })
    )
    expect(mocks.commitPointer).not.toHaveBeenCalled()
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.register).not.toHaveBeenCalled()
    expect(mocks.bootstrap).not.toHaveBeenCalled()
    expect(mocks.migrate).not.toHaveBeenCalled()
    expect(mocks.mark).not.toHaveBeenCalled()
    expect(profileBusinessAccessGate.isAllowed()).toBe(false)
  })

  it('重试原候选后走正常业务启动，不重开 boot attempt', async () => {
    mocks.verify
      .mockResolvedValueOnce({ kind: 'failed', reason: 'offline' })
      .mockResolvedValueOnce({ kind: 'verified' })
    await startBusinessRuntime(context)
    const recovery = mocks.recover.mock.calls[0][1].startupRecovery
    await recovery.retry(() => true)
    expect(mocks.verify.mock.calls.map(([value]) => value)).toEqual([context, context])
    expect(mocks.begin).not.toHaveBeenCalled()
    expect(mocks.commitPointer).not.toHaveBeenCalled()
    expect(mocks.mark).toHaveBeenCalledWith(context)
    expect(profileBusinessAccessGate.isAllowed()).toBe(true)
  })

  it('旧窗口的迟到重试成功不能启动业务', async () => {
    mocks.verify
      .mockResolvedValueOnce({ kind: 'failed', reason: 'offline' })
      .mockResolvedValueOnce({ kind: 'verified' })
    await startBusinessRuntime(context)
    const recovery = mocks.recover.mock.calls[0][1].startupRecovery
    await expect(recovery.retry(() => false)).rejects.toThrow('superseded')
    expect(mocks.register).not.toHaveBeenCalled()
    expect(mocks.mark).not.toHaveBeenCalled()
    expect(profileBusinessAccessGate.isAllowed()).toBe(false)
  })

  it('未知重试响应继续阻断业务且不提交退出', async () => {
    mocks.verify.mockResolvedValue({ kind: 'failed', reason: 'unknown response' })
    await startBusinessRuntime(context)
    const recovery = mocks.recover.mock.calls[0][1].startupRecovery
    await expect(recovery.retry(() => true)).resolves.toBe('unavailable')
    expect(mocks.register).not.toHaveBeenCalled()
    expect(mocks.commitPointer).not.toHaveBeenCalled()
    expect(profileBusinessAccessGate.isAllowed()).toBe(false)
  })

  it('只有用户显式选其他账号才提交 signed-out 并创建原密码登录页', async () => {
    mocks.verify.mockResolvedValue({ kind: 'failed', reason: 'offline' })
    await startBusinessRuntime(context)
    const recovery = mocks.recover.mock.calls[0][1].startupRecovery
    expect(mocks.commitPointer).not.toHaveBeenCalled()
    await recovery.selectSignedOut(() => true)
    expect(mocks.commitPointer).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: 'signed-out' }),
      expect.any(String)
    )
    expect(mocks.recover).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'signed-out' }))
    expect(mocks.begin).not.toHaveBeenCalled()
    expect(mocks.register).not.toHaveBeenCalled()
  })

  */

  it.each(['unavailable', 'invalid', undefined])(
    '冷启动验证失败 %s 自动进入隔离登录且不启动业务',
    async (failureKind) => {
      mocks.verify.mockResolvedValue({ kind: 'failed', reason: 'verification failed', failureKind })
      const candidate = { ...context, legacyRoot: '/legacy' }
      await startBusinessRuntime(candidate)
      expect(mocks.commitPointer).toHaveBeenCalledWith(
        expect.objectContaining({ profileId: 'signed-out' }),
        expect.any(String)
      )
      expect(mocks.recover).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          mode: 'signed-out',
          profileId: 'signed-out',
          profileRoot: '/data/profiles/signed-out',
          legacyRoot: '/legacy'
        })
      )
      expect(getProfileLaunchContext()).toEqual(mocks.recover.mock.calls[0][0])
      expect(getLastBusinessIdentityDigest()).toBe(candidate.identityDigest)
      expect(mocks.prepare).toHaveBeenCalledOnce()
      expect(mocks.register).not.toHaveBeenCalled()
      expect(mocks.bootstrap).not.toHaveBeenCalled()
      expect(mocks.migrate).not.toHaveBeenCalled()
      expect(mocks.mark).not.toHaveBeenCalled()
      expect(profileBusinessAccessGate.isAllowed()).toBe(false)
      expect(profileSwitchFence.state.kind).toBe('switching')
    }
  )

  it('活动指针提交失败时不开放登录或业务，保留事务恢复边界', async () => {
    mocks.verify.mockResolvedValue({ kind: 'failed', reason: 'offline' })
    mocks.commitPointer.mockRejectedValue(new Error('disk failure'))
    await expect(startBusinessRuntime(context)).rejects.toThrow('Could not select the signed-out profile')
    expect(mocks.recover).not.toHaveBeenCalled()
    expect(mocks.register).not.toHaveBeenCalled()
    expect(profileBusinessAccessGate.isAllowed()).toBe(false)
    expect(profileSwitchFence.state.kind).toBe('needs-recovery')
  })

  it('冷启动验证成功不切换登录，直接启动业务', async () => {
    await startBusinessRuntime(context)
    expect(mocks.commitPointer).not.toHaveBeenCalled()
    expect(mocks.recover).not.toHaveBeenCalled()
    expect(mocks.mark).toHaveBeenCalledWith(context)
    expect(profileBusinessAccessGate.isAllowed()).toBe(true)
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
