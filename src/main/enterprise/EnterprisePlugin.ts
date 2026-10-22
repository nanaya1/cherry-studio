import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { dialog } from 'electron'
import { v4 as uuidv4 } from 'uuid'

import { application } from '@application'
import { loggerService } from '@logger'
import { BaseService, DependsOn, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import {
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
        credentialStoreFor: (profileRoot) => new OrgCredentialStore(profileRoot),
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
            createProfileBootstrapWindow(signedOutContext)
            application.finishProfileLogout()
          }
        }),
        operationId: uuidv4
      })
      this.auth = new OrgAuthManager({
        credentialStore: new OrgCredentialStore(context.profileRoot),
        currentProfile: async () => {
          const state = await registry.read()
          const profile = state.profiles.find((candidate) => candidate.profileId === context.profileId)
          if (!profile) throw new Error(`Active profile not found: ${context.profileId}`)
          return profile
        },
        profileSession
      })
    } else {
      const profileRoot = context?.profileRoot ?? path.dirname(application.getPath('app.userdata'))
      this.auth = new OrgAuthManager({ credentialStore: new OrgCredentialStore(profileRoot) })
    }
    this.skills = new OrgSkillCatalog(this.auth)
    this.connectors = new OrgMcpCatalog(this.auth)
    this.knowledge = new OrgKnowledgeService(this.auth)
  }

  private async stopBlockedProfile(reason: string): Promise<void> {
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
      detail: '重新启动后将再次验证当前账号。',
      buttons: ['重新启动', '退出'],
      cancelId: 1
    })
    if (result.response === 0) application.relaunch()
    else application.forceExit(0)
  }

  protected async onInit(): Promise<void> {
    await this.auth.initialize()
    this.knowledge.initialize(application.get('JobManager'))
    this.registerDisposable(() => this.knowledge.dispose())
    const context = getProfileLaunchContext()
    if (context?.mode === 'business' && context.kind === 'authenticated') {
      const monitor = new ProfileOnlineMonitor({
        gate: profileBusinessAccessGate,
        verify: () => this.auth.verifyOnlineAuthority(),
        onBlocked: (reason) => {
          logger.warn('Business access blocked', { reason })
          void this.stopBlockedProfile(reason).catch((error: unknown) => {
            logger.error('Blocked profile teardown failed', error as Error)
            application.forceExit(1)
          })
        }
      })
      this.registerDisposable(() => monitor.stop())
      monitor.start()
    }
    const migratedSkills = this.skills.migrateLegacyCopies()
    const migratedConnectors = this.connectors.migrateLegacyCopies()
    logger.info('enterprise copy mode ready', { migratedSkills, migratedConnectors })
  }
}
