import fs from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'

// import { app, session } from 'electron'
import { app, dialog } from 'electron'

import { application } from '@application'
import { CHERRY_HOME } from '@main/core/paths/constants'
import {
  createProfilePaths,
  isProfileIsolationEnabled,
  LegacyProfileAdoption,
  ProfileBootJournal,
  ProfilePrebootCoordinator,
  ProfileRegistry,
  ProfileSensitiveDataMigrator,
  // resolveAuthSessionPath,
  resolveProfileRoot,
  SIGNED_OUT_DIGEST,
  verifyCandidateProfile,
  type StartupVerificationResult,
  type ProfileLaunchContext
} from '@main/core/profiles'
import { restoreProfileAuthSession } from '@main/core/profiles'
import { bootConfigService } from '@main/data/bootConfig'
import { OrgCredentialStore } from '@main/enterprise/OrgCredentialStore'
import { createStartupCurrentUserTransport, type ElectronSessionLike } from '@main/enterprise/orgCurrentUserTransport'

import { acquireDataRootLock, releaseDataRootLock } from './dataRootLock'
import { applyProfileIsolationPaths, lockProfileDataRoot, resolveProfileDataRoot } from './profileIsolationPreboot'
import { getLegacyNormalizedExecutablePath, getNormalizedExecutablePath } from './userDataLocation'

function logLockCompromised(error: Error): void {
  void import('@logger').then(({ loggerService }) => {
    loggerService.withContext('ProfileIsolation').warn('Profile data root lock compromised', error)
  })
}

function acquireProfileDataRootLock(instanceRoot: string): boolean {
  return acquireDataRootLock(instanceRoot, logLockCompromised)
}

export function shouldUseProfileIsolation(): boolean {
  return isProfileIsolationEnabled({
    isPackaged: app.isPackaged,
    profileIsolationEnabled: bootConfigService.get('app.profile_isolation_enabled'),
    env: process.env
  })
}

function electronPrebootApi() {
  return {
    setPath: (name: 'userData' | 'sessionData' | 'crashDumps' | 'temp', value: string) => app.setPath(name, value),
    setAppLogsPath: (value: string) => app.setAppLogsPath(value),
    mkdirSync: (value: string, options?: { recursive?: boolean }) => fs.mkdirSync(value, options),
    acquireDataRootLock: acquireProfileDataRootLock,
    requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
    // Freezing the path registry now rebuilds the runtime in place (no separate
    // initPathRegistry) so the same call serves cold start and a same-process
    // business rebuild without double-initializing the registry.
    freezePathRegistry: () => application.prepareProfileRuntime()
  }
}

export function resolveCurrentProfileDataRoot(legacyRoot: string): string {
  return resolveProfileDataRoot(
    legacyRoot,
    getNormalizedExecutablePath(),
    bootConfigService.get('app.data_root_path'),
    getLegacyNormalizedExecutablePath()
  )
}

export function lockCurrentProfileDataRoot(dataRoot: string): boolean {
  const locked = lockProfileDataRoot(dataRoot, electronPrebootApi())
  if (locked) {
    // 登录/恢复窗口不经过 bootstrap()，此处必须自己兜底释放，否则正常退出后
    // 锁会残留到 stale 判定（10s），期间重新启动会拿不到锁。
    // eslint-disable-next-line lifecycle/no-direct-quit -- preboot 阶段 Application 尚未接管 quit 事件
    app.once('will-quit', () => releaseDataRootLock())
  }
  return locked
}

/**
 * 数据根被另一个实例持有时不再静默 return：启动阶段没有窗口也没有日志分流，
 * 用户只会看到“点了没反应”。
 */
export async function reportDataRootBusyAndQuit(): Promise<void> {
  await app.whenReady()
  await dialog.showMessageBox({
    type: 'info',
    title: '应用正在启动',
    message: '检测到已有一个 MEACowork 实例正在运行或正在退出。',
    detail: '如果刚切换过账号，请等待几秒后重试；否则请从 Dock 激活已打开的窗口。',
    buttons: ['好']
  })
  application.quit()
}

export async function initializeLockedProfileIsolation(
  legacyRoot: string,
  dataRoot: string
): Promise<ProfileLaunchContext | undefined> {
  const coordinator = new ProfilePrebootCoordinator({
    dataRoot,
    legacyRoot,
    legacyDataExists: async () => fs.existsSync(path.join(legacyRoot, 'Data')),
    cleanupCommittedSource: async (profileRoot) => {
      await rm(path.join(profileRoot, 'userData', 'Sensitive', 'Enterprise', 'org-session.json.quarantine'), {
        force: true
      })
    }
  })
  const context = await coordinator.initialize()
  const electron = electronPrebootApi()
  applyProfileIsolationPaths(context, electron)
  // 单实例锁已在 main.ts 于 userData 仍是默认值时取得，与账号无关。
  // 此处若再请求，会按 profile 的 userData 生成第二把锁，反而放开多开。
  // if (!lockProfileInstance(electron)) return undefined
  ;(await import('@logger')).loggerService.rebind(path.join(context.profileRoot, 'logs'))
  return context
}

export async function adoptLegacyProfile(context: ProfileLaunchContext): Promise<void> {
  if (context.mode !== 'migration-required' || !context.legacyRoot) {
    throw new Error('Legacy profile adoption requires a migration-required launch')
  }
  await new LegacyProfileAdoption({ legacyRoot: context.legacyRoot, dataRoot: context.dataRoot }).adopt()
}

export async function migrateProfileSensitiveData(context: ProfileLaunchContext): Promise<void> {
  if (context.mode !== 'business') return
  const registry = new ProfileRegistry(path.join(context.dataRoot, 'control', 'profiles.json'))
  const state = await registry.read()
  const profile = state.profiles.find((candidate) => candidate.profileId === context.profileId)
  if (!profile || profile.kind === 'signed-out') {
    throw new Error(`Cannot migrate sensitive data for unverified profile ${context.profileId}`)
  }
  await new ProfileSensitiveDataMigrator({
    cherryHome: CHERRY_HOME,
    legacyUserData: context.legacyRoot
  }).migrate({
    mode: context.mode,
    profile: {
      kind: profile.kind,
      profileId: profile.profileId,
      identityDigest: profile.identityDigest
    },
    userData: application.getPath('app.userdata')
  })
}

export async function markProfileBootSuccessful(context: ProfileLaunchContext): Promise<void> {
  if (context.mode !== 'business') return
  const journal = new ProfileBootJournal(path.join(context.dataRoot, 'control', 'boot-journal.json'))
  await journal.recordSuccess(context.profileId)
}

/**
 * Builds a signed-out launch context from a dataRoot. Kept for tests and the
 * preboot recovery flows; the verifier no longer routes failures here.
 */
export function buildSignedOutLaunchContext(dataRoot: string): ProfileLaunchContext {
  const paths = createProfilePaths(dataRoot)
  return {
    mode: 'signed-out',
    profileId: 'signed-out',
    identityDigest: SIGNED_OUT_DIGEST,
    kind: 'signed-out',
    dataRoot: paths.dataRoot,
    profileRoot: resolveProfileRoot(paths, 'signed-out')
  }
}

/**
 * Fail-closed route for a candidate that cannot be online-verified. Uses a
 * dedicated recovery context at the control plane (not a signed-out profile
 * bound to the candidate business disk), per design §3 / line 179.
 */
export function buildVerificationFailureContext(dataRoot: string): ProfileLaunchContext {
  const paths = createProfilePaths(dataRoot)
  return {
    mode: 'recovery',
    profileId: 'signed-out',
    identityDigest: SIGNED_OUT_DIGEST,
    kind: 'signed-out',
    dataRoot: paths.dataRoot,
    profileRoot: path.join(paths.controlRoot, 'recovery-profile')
  }
}

// Startup gate: before any business service registers, recover the candidate
// session and verify it online via `/api/currentuser`. On failure the result
// routes to a recovery window that defers all state change to transaction+restart.
export async function verifyBusinessCandidate(context: ProfileLaunchContext): Promise<StartupVerificationResult> {
  if (context.mode !== 'business') {
    throw new Error('verifyBusinessCandidate requires a business launch context')
  }
  const credentialStore = new OrgCredentialStore(context.profileRoot)
  try {
    const stored = await credentialStore.load()
    const electronSession =
      stored?.authMode === 'management-cookie'
        ? // ? (session.fromPath(resolveAuthSessionPath(context.profileRoot)) as unknown as ElectronSessionLike)
          ((await restoreProfileAuthSession(context.profileRoot, stored.authOrigin)) as ElectronSessionLike)
        : undefined
    const transport = createStartupCurrentUserTransport(stored, { electronSession })
    return await verifyCandidateProfile({
      context,
      session: stored,
      transport,
      buildFailureContext: buildVerificationFailureContext
    })
  } catch {
    return {
      kind: 'failed',
      reason: 'Candidate credentials or auth session could not be opened securely',
      failureContext: buildVerificationFailureContext(context.dataRoot)
    }
  }
}
