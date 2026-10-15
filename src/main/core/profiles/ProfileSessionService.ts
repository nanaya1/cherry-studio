import path from 'node:path'

import type { OrgCredentialWriteResult, OrgSession } from '@main/enterprise/OrgCredentialStore'

import { ProfileBootJournal } from './ProfileBootJournal'
import { computeIdentityDigest, type ProfileIdentity } from './ProfileIdentity'
import type { ProfileInstallation } from './ProfileInstallation'
import { ProfileLogoutIntent } from './ProfileLogoutIntent'
import type { ProfileAuthorizationContext, ProfileRegistry } from './ProfileRegistry'
import type { ProfileSwitchCoordinator, ProfileSwitchResult } from './ProfileSwitchCoordinator'

interface ProfileCredentialStore {
  load?(): Promise<OrgSession | null>
  save(session: OrgSession): Promise<void | OrgCredentialWriteResult>
  clear(): Promise<void>
  quarantine?(): Promise<OrgCredentialWriteResult>
  restoreQuarantined?(): Promise<OrgCredentialWriteResult>
  discardQuarantined?(): Promise<void>
}

export interface CompletedProfileAuthentication {
  identity: Extract<ProfileIdentity, { kind: 'authenticated' }>
  authorizationContext: ProfileAuthorizationContext
  session: OrgSession
  prepareTargetSession?(profileRoot: string): Promise<void | (() => Promise<void>)>
}

export interface ProfileSessionServiceDependencies {
  dataRoot: string
  bootJournal?: Pick<ProfileBootJournal, 'resetAfterAuthentication'>
  currentProfileId: string
  installation: Pick<ProfileInstallation, 'getOrCreate'>
  registry: Pick<
    ProfileRegistry,
    'ensureLocal' | 'ensureAuthenticated' | 'requireActivatable' | 'updateAuthorizationContext'
  >
  prepareProfileRoot(profileRoot: string): Promise<void>
  prepareAuthenticatedUserData?(input: {
    currentProfileId: string
    targetProfileId: string
    targetProfileRoot: string
  }): Promise<(() => Promise<void>) | undefined>
  credentialStoreFor(profileRoot: string): ProfileCredentialStore
  coordinator: Pick<ProfileSwitchCoordinator, 'switchProfile'>
  operationId(): string
  logoutIntent?: Pick<ProfileLogoutIntent, 'begin'>
}

export class ProfileSessionService {
  constructor(private readonly dependencies: ProfileSessionServiceDependencies) {}

  async enterLocal(): Promise<ProfileSwitchResult> {
    // local is staging-only (legacy unowned data) and is no longer a business launch target.
    // The previous business switch path is disabled:
    //   const installation = await this.dependencies.installation.getOrCreate()
    //   const target = await this.dependencies.registry.ensureLocal(installation.value.deviceInstallId, 'default')
    //   await this.prepare(target.value.profileId)
    //   return this.switchTo(target.value)
    throw new Error('Local profile is staging-only and cannot be launched as a business profile')
  }

  async completeAuthentication(authentication: CompletedProfileAuthentication): Promise<ProfileSwitchResult> {
    const target = await this.dependencies.registry.ensureAuthenticated(authentication.identity)
    const profileRoot = await this.prepare(target.value.profileId)
    const prepareUserData = await this.dependencies.prepareAuthenticatedUserData?.({
      currentProfileId: this.dependencies.currentProfileId,
      targetProfileId: target.value.profileId,
      targetProfileRoot: profileRoot
    })
    const store = this.dependencies.credentialStoreFor(profileRoot)
    const previousSession = await store.load?.()
    const previousAuthorizationContext = target.value.authorizationContext
    const rollback: { session?: () => Promise<void> } = {}
    try {
      const result = await this.switchTo(target.value, async () => {
        await prepareUserData?.()
        rollback.session = (await authentication.prepareTargetSession?.(profileRoot)) || undefined
        const saved = await store.save(authentication.session)
        if (saved?.kind === 'committed-durability-unknown') {
          throw new Error('Target credential durability is unknown')
        }
        const authorized = await this.dependencies.registry.updateAuthorizationContext(
          authentication.identity,
          authentication.authorizationContext
        )
        if (authorized.durability?.kind === 'committed-durability-unknown') {
          throw new Error('Target authorization durability is unknown')
        }
        const bootJournal =
          this.dependencies.bootJournal ??
          new ProfileBootJournal(path.join(this.dependencies.dataRoot, 'control', 'boot-journal.json'))
        const reset = await bootJournal.resetAfterAuthentication()
        if (reset.kind !== 'committed-confirmed') {
          throw new Error('Boot recovery reset durability is unknown')
        }
        return authorized.value
      })
      if (result.kind === 'teardown-failed') {
        await rollback.session?.()
        await this.restoreCredential(store, previousSession)
        await this.dependencies.registry.updateAuthorizationContext(
          authentication.identity,
          previousAuthorizationContext
        )
      }
      return result
    } catch (error) {
      await rollback.session?.()
      await this.restoreCredential(store, previousSession)
      await this.dependencies.registry.updateAuthorizationContext(authentication.identity, previousAuthorizationContext)
      throw error
    }
  }

  async updateAuthorizationContext(
    identity: Extract<ProfileIdentity, { kind: 'authenticated' }>,
    authorizationContext: ProfileAuthorizationContext
  ): Promise<void> {
    await this.dependencies.registry.updateAuthorizationContext(identity, authorizationContext)
  }

  async beginLogout(): Promise<void> {
    const intent =
      this.dependencies.logoutIntent ??
      new ProfileLogoutIntent(path.join(this.dependencies.dataRoot, 'control', 'logout-intent.json'))
    await intent.begin(this.dependencies.currentProfileId, this.dependencies.operationId())
  }

  async logout(): Promise<ProfileSwitchResult> {
    await this.beginLogout()
    const currentRoot = this.profileRoot(this.dependencies.currentProfileId)
    const store = this.dependencies.credentialStoreFor(currentRoot)
    if (!store.quarantine || !store.restoreQuarantined) {
      throw new Error('Credential store does not support transactional logout')
    }
    const quarantined = await store.quarantine()
    if (quarantined.kind === 'committed-durability-unknown') {
      return { kind: 'needs-recovery', stage: 'logout-quarantine' }
    }
    const signedOut = await this.dependencies.registry.requireActivatable(
      'signed-out',
      computeIdentityDigest({ kind: 'signed-out', bootstrapId: 'signed-out' })
    )
    await this.prepare(signedOut.profileId)
    // Logout intent survives teardown failure; do not restore quarantined credentials.
    return this.switchTo(signedOut)
  }

  private async restoreCredential(
    store: ProfileCredentialStore,
    previous: OrgSession | null | undefined
  ): Promise<void> {
    if (previous) await store.save(previous)
    else await store.clear()
  }

  private async prepare(profileId: string): Promise<string> {
    const profileRoot = this.profileRoot(profileId)
    await this.dependencies.prepareProfileRoot(profileRoot)
    return profileRoot
  }

  private profileRoot(profileId: string): string {
    return path.join(this.dependencies.dataRoot, 'profiles', profileId)
  }

  private switchTo(
    target: Awaited<ReturnType<ProfileRegistry['requireActivatable']>>,
    afterTeardown?: () => Promise<Awaited<ReturnType<ProfileRegistry['requireActivatable']>>>
  ): Promise<ProfileSwitchResult> {
    const request = {
      operationId: this.dependencies.operationId(),
      fromProfileId: this.dependencies.currentProfileId,
      targetProfileId: target.profileId,
      targetIdentityDigest: target.identityDigest
    }
    return afterTeardown
      ? this.dependencies.coordinator.switchProfile(request, target, { afterTeardown })
      : this.dependencies.coordinator.switchProfile(request, target)
  }
}
