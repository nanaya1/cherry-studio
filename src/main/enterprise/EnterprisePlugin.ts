import { mkdir } from 'node:fs/promises'
import path from 'node:path'

// import { dialog } from 'electron'
import { v4 as uuidv4 } from 'uuid'

import { application } from '@application'
import { loggerService } from '@logger'
import { BaseService, DependsOn, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import {
  closeProfileBootstrapWindows,
  confirmProfileClaim,
  createProfileBootstrapWindow,
  createProfilePaths,
  getLastBusinessIdentityDigest,
  getProfileLaunchContext,
  setProfileLaunchContext,
  shouldActivateInProcess,
  ProfileActivePointer,
  ProfileClaimService,
  ProfileInstallation,
  ProfileRegistry,
  ProfileSessionService,
  ProfileSwitchCoordinator,
  ProfileSwitchJournal,
  profileSwitchFence,
  profileBusinessAccessGate,
  validateExistingProfilePath
} from '@main/core/profiles'

// eslint-disable-next-line barrel/closed
import { showProfileRecoveryChoice } from '../core/profiles/ProfileSwitchCoordinator'
import { CoworkModelConfigSync } from './CoworkModelConfigSync'
import { OrgAuthManager } from './OrgAuthManager'
import { OrgCredentialStore } from './OrgCredentialStore'
import { OrgKnowledgeService } from './OrgKnowledgeService'
import { OrgMcpCatalog } from './OrgMcpCatalog'
import { OrgSkillCatalog } from './OrgSkillCatalog'
import { ProfileOnlineMonitor } from './ProfileOnlineMonitor'

const logger = loggerService.withContext('EnterprisePlugin')

// Keep this lazy to avoid loading serviceRegistry through the profiles barrel during bootstrap.
// eslint-disable-next-line barrel/closed
const loadBusinessStartup = () => import('../core/profiles/businessStartup')

@Injectable('EnterprisePlugin')
@ServicePhase(Phase.WhenReady)
@DependsOn(['JobManager'])
export class EnterprisePlugin extends BaseService {
  readonly auth: OrgAuthManager
  readonly skills: OrgSkillCatalog
  readonly connectors: OrgMcpCatalog
  readonly knowledge: OrgKnowledgeService
  private readonly modelConfigSync = new CoworkModelConfigSync()
  private modelConfigSyncTask: Promise<void> | null = null

  constructor() {
    super()
    const context = getProfileLaunchContext()
    if (context?.mode === 'business') {
      const paths = createProfilePaths(context.dataRoot)
      const registry = new ProfileRegistry(path.join(paths.controlRoot, 'profiles.json'))
      const activePointer = new ProfileActivePointer(path.join(paths.controlRoot, 'active-profile.json'), registry)
      const switchJournal = new ProfileSwitchJournal(path.join(paths.controlRoot, 'switch-journal.json'))
      const profileSession = new ProfileSessionService({
        dataRoot: context.dataRoot,
        currentProfileId: context.profileId,
        installation: new ProfileInstallation(path.join(paths.controlRoot, 'installation.json')),
        registry,
        prepareProfileRoot: async (profileRoot) => {
          await validateExistingProfilePath(paths, profileRoot)
          await mkdir(profileRoot, { recursive: true })
        },
        prepareAuthenticatedUserData:
          context.kind === 'local'
            ? async ({ targetProfileId, targetProfileRoot }) => {
                const claim = new ProfileClaimService({
                  localUserData: path.join(context.profileRoot, 'userData'),
                  targetUserData: path.join(targetProfileRoot, 'userData'),
                  journalPath: path.join(paths.controlRoot, `claim-${targetProfileId}.journal.json`)
                })
                const preview = await claim.preview()
                if (preview.status === 'already-claimed' || preview.status === 'unsupported') return
                if (preview.status === 'staged') {
                  return { apply: async () => undefined, commit: () => claim.commit() }
                }
                const decision = await confirmProfileClaim(preview)
                if (!decision) throw new Error('Profile claim cancelled')
                if (!decision.copy) return
                return {
                  apply: async () => {
                    const result = await claim.confirm({ previewId: preview.previewId, allow: decision.allow })
                    if (result.status !== 'claimed') throw new Error('Profile claim did not complete')
                  },
                  commit: () => claim.commit()
                }
              }
            : undefined,
        // credentialStoreFor: (profileRoot) => new OrgCredentialStore(profileRoot),
        credentialStoreFor: (profileRoot) => OrgCredentialStore.forJava(profileRoot),
        coordinator: new ProfileSwitchCoordinator({
          journal: switchJournal,
          activePointer,
          fence: profileSwitchFence,
          application,
          // Reuse the current Electron process when the authenticated identity is
          // already the process identity; different identities keep the relaunch fallback.
          activateAuthenticated: async (record) => {
            if (!shouldActivateInProcess(record, getLastBusinessIdentityDigest())) return false
            const { buildBusinessLaunchContext, startBusinessRuntime } = await loadBusinessStartup()
            await startBusinessRuntime(buildBusinessLaunchContext(context.dataRoot, record), {
              rebuildRuntime: true,
              onVerifyFailure: 'throw'
            })
            closeProfileBootstrapWindows()
            return true
          },
          openSignedOut: async (record) => {
            const signedOutContext = {
              mode: 'signed-out' as const,
              kind: 'signed-out' as const,
              profileId: record.profileId,
              identityDigest: record.identityDigest,
              dataRoot: context.dataRoot,
              profileRoot: path.join(paths.profilesRoot, record.profileId)
            }
            // Reflect the login state so the window-close guard knows the business
            // runtime is no longer active. A later same-process activation swaps
            // this back to 'business' and suppresses the force-exit.
            setProfileLaunchContext(signedOutContext)
            // createProfileBootstrapWindow(signedOutContext)
            // application.finishProfileLogout()
            // MEA:profile-online-login Keep the process alive until the current login window is visible.
            createProfileBootstrapWindow(signedOutContext, { onReady: () => application.finishProfileLogout() })
          }
        }),
        operationId: uuidv4
      })
      this.auth = new OrgAuthManager({
        // credentialStore: new OrgCredentialStore(context.profileRoot),
        credentialStore: OrgCredentialStore.forJava(context.profileRoot),
        currentProfile: async () => {
          const state = await registry.read()
          const profile = state.profiles.find((candidate) => candidate.profileId === context.profileId)
          if (!profile) throw new Error(`Active profile not found: ${context.profileId}`)
          return profile
        },
        profileSession,
        onLogoutFailure: (stage) => showProfileRecoveryChoice(application, stage)
      })
    } else {
      const profileRoot = context?.profileRoot ?? path.dirname(application.getPath('app.userdata'))
      // this.auth = new OrgAuthManager({ credentialStore: new OrgCredentialStore(profileRoot) })
      this.auth = new OrgAuthManager({ credentialStore: OrgCredentialStore.forJava(profileRoot) })
    }
    this.skills = new OrgSkillCatalog(this.auth)
    this.connectors = new OrgMcpCatalog(this.auth)
    this.knowledge = new OrgKnowledgeService(this.auth)
  }

  /* private async stopBlockedProfile(reason: string): Promise<void> {
    // Logout owns teardown after revocation; the monitor must not race that transition.
    if (
      profileBusinessAccessGate.state.kind === 'blocked' &&
      profileBusinessAccessGate.state.reason === 'Logout requested'
    )
      return
    if (profileSwitchFence.state.kind !== 'open') return
    profileSwitchFence.beginSwitch(uuidv4())
    const teardown = await application.prepareProfileSwitch()
    if (!teardown.clean) {
      profileSwitchFence.markTeardownFailed(reason)
      application.forceExit(1)
      return
    }
    const result = await dialog.showMessageBox({
      type: 'warning',
      title: '需要重新验证账号',
      message: '在线账号验证已失效，业务服务已停止。',
      // detail: '重新启动后将再次验证当前账号。',
      detail: reason,
      buttons: ['重新启动', '退出'],
      cancelId: 1
    })
    if (result.response === 0) application.relaunch()
    else application.forceExit(0)
  } */

  // MEA:profile-online-login A revoked account locks execution, never the window lifecycle.
  private async cancelBlockedWork(): Promise<void> {
    const reason = 'Account authorization is no longer valid'
    const cancellations = [
      () => application.get('JobManager').cancelMany({ type: 'agent.task' }, reason),
      () => application.get('AiStreamManager').cancelActiveWork(reason),
      () => application.get('AgentSessionRuntimeService').cancelActiveWork(reason),
      () => application.get('McpRuntimeService').abortActiveToolCalls()
    ]
    const outcomes = await Promise.allSettled(cancellations.map(async (cancel) => cancel()))
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected')
        logger.warn('Could not cancel revoked account work', { error: String(outcome.reason) })
    }
  }

  /** 每次登录首次验证成功后仅尝试一次模型同步，失败不阻断账号登录。 */
  private syncCoworkModelConfig(): Promise<void> {
    if (this.modelConfigSyncTask) return this.modelConfigSyncTask
    const task = this.modelConfigSync
      .sync(this.auth)
      .then((result) => {
        if (result) logger.info('Cowork model configuration synchronized', result)
      })
      .catch(() => {
        // 不能记录可能包含明文 Key 的原始异常或响应；仅在下次登录时重新尝试。
        logger.warn('Cowork model configuration synchronization failed; retaining existing configuration')
      })
      .finally(() => {
        if (this.modelConfigSyncTask === task) this.modelConfigSyncTask = null
      })
    this.modelConfigSyncTask = task
    return task
  }

  protected async onInit(): Promise<void> {
    this.registerDisposable(
      this.auth.onVerificationChanged((status) => {
        application.get('IpcApiService').broadcast('enterprise.verification_changed', status)
        if (status.state === 'blocked') void this.cancelBlockedWork()
        // MEA:enterprise-model-binding verified 还用于网络恢复，不作为模型配置同步入口。
        // if (status.state === 'verified') void this.syncCoworkModelConfig()
      })
    )
    // this.registerDisposable(this.auth.onAuthorizationChanged(() => this.knowledge.invalidateAuthorizationContext()))
    // MEA:enterprise-model-binding 授权缓存照常失效，模型配置只在登录时读取。
    this.registerDisposable(
      this.auth.onAuthorizationChanged(() => {
        this.knowledge.invalidateAuthorizationContext()
        // void this.syncCoworkModelConfig()
      })
    )
    this.registerDisposable(() => this.auth.dispose())
    await this.auth.initialize()
    // 登录初始化完成后只尝试一次；后续 verified 通知仅代表在线校验恢复。
    void this.syncCoworkModelConfig()
    this.knowledge.initialize(application.get('JobManager'))
    this.registerDisposable(() => this.knowledge.dispose())
    const context = getProfileLaunchContext()
    if (context?.mode === 'business' && context.kind === 'authenticated') {
      const monitor = new ProfileOnlineMonitor({
        gate: profileBusinessAccessGate,
        verify: async () => {
          await this.auth.verifyOnlineAuthority()
          // MEA:enterprise-model-binding 在线监控只校验账号及资源授权，不周期拉取模型配置。
          // void this.syncCoworkModelConfig()
          try {
            await Promise.allSettled([
              this.skills.refreshResourceAuthority(),
              this.connectors.refreshResourceAuthority()
            ])
          } finally {
            await application.get('McpRuntimeService').stopUnauthorizedOrgConnectors()
          }
        },
        onBlocked: (reason) => logger.warn('Business access blocked; waiting for user action', { reason })
      })
      this.registerDisposable(() => monitor.stop())
      monitor.start()
    }
    // MEA:enterprise-java-resources 启动不改写历史资源来源。
    // const migratedSkills = this.skills.migrateLegacyCopies()
    // const migratedConnectors = this.connectors.migrateLegacyCopies()
    // logger.info('enterprise copy mode ready', { migratedSkills, migratedConnectors })
  }
}
