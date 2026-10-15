import { withProfileControlLock } from './ProfileControlLock'
import { type ControlMutationResult, ProfileControlStore } from './ProfileControlStore'
import { computeIdentityDigest, computeProfileId, type ProfileIdentity } from './ProfileIdentity'
import { type ProfileRecordV1, type ProfileRegistryV1, ProfileRegistryV1Schema } from './ProfileSchemas'

export type ProfileAuthorizationContext = NonNullable<ProfileRecordV1['authorizationContext']>

const SIGNED_OUT_IDENTITY = { kind: 'signed-out', bootstrapId: 'signed-out' } as const
export const SIGNED_OUT_DIGEST = computeIdentityDigest(SIGNED_OUT_IDENTITY)

export class ProfileRegistry {
  private readonly store: ProfileControlStore<ProfileRegistryV1>

  constructor(filePathOrStore: string | ProfileControlStore<ProfileRegistryV1>) {
    this.store =
      typeof filePathOrStore === 'string'
        ? new ProfileControlStore(filePathOrStore, ProfileRegistryV1Schema)
        : filePathOrStore
  }

  get controlPath(): string {
    return this.store.path
  }

  async read(): Promise<ProfileRegistryV1> {
    const registry = await this.readExisting()
    this.validateRegistry(registry)
    return registry
  }

  async initialize(): Promise<ControlMutationResult<ProfileRegistryV1>> {
    return withProfileControlLock(this.store.path, async () => {
      const result = await this.store.read()
      if (result.kind === 'corrupt') {
        throw new Error(`Profile registry is corrupt at ${result.filePath}: ${result.error}`)
      }
      if (result.kind === 'ok' && result.value.profiles.length > 0) {
        this.validateRegistry(result.value)
        return { value: result.value, durability: { kind: 'not-written' } }
      }

      const value: ProfileRegistryV1 = {
        version: 1,
        profiles: [this.createRecord(SIGNED_OUT_IDENTITY)]
      }
      const durability = await this.store.write(value)
      return { value, durability }
    })
  }

  ensureLocal(deviceInstallId: string, localUserId: 'default'): Promise<ControlMutationResult<ProfileRecordV1>> {
    return this.ensureIdentity({ kind: 'local', deviceInstallId, localUserId })
  }

  ensureAuthenticated(
    identity: Extract<ProfileIdentity, { kind: 'authenticated' }>
  ): Promise<ControlMutationResult<ProfileRecordV1>> {
    return this.ensureIdentity(identity)
  }

  async updateAuthorizationContext(
    identity: Extract<ProfileIdentity, { kind: 'authenticated' }>,
    authorizationContext: ProfileAuthorizationContext | undefined
  ): Promise<ControlMutationResult<ProfileRecordV1>> {
    return withProfileControlLock(this.store.path, async () => {
      const registry = await this.read()
      const profileId = computeProfileId(identity)
      const index = registry.profiles.findIndex((profile) => profile.profileId === profileId)
      if (index < 0) {
        throw new Error(`Profile not found: ${profileId}`)
      }

      const existing = registry.profiles[index]
      this.assertRecordMatchesIdentity(existing, identity)
      const withoutAuthorizationContext = { ...existing }
      delete withoutAuthorizationContext.authorizationContext
      const updated = authorizationContext ? { ...withoutAuthorizationContext, authorizationContext } : withoutAuthorizationContext
      const durability = await this.store.write({ ...registry, profiles: registry.profiles.with(index, updated) })
      return { value: updated, durability }
    })
  }

  async requireActivatable(profileId: string, identityDigest: string): Promise<ProfileRecordV1> {
    const registry = await this.read()
    const record = registry.profiles.find((profile) => profile.profileId === profileId)
    if (!record) {
      throw new Error(`Profile not found: ${profileId}`)
    }
    if (record.identityDigest !== identityDigest) {
      throw new Error(`Profile identity digest does not match: ${profileId}`)
    }
    if (record.state !== 'ready') {
      throw new Error(`Profile is disabled: ${profileId}`)
    }
    return record
  }

  private async readExisting(): Promise<ProfileRegistryV1> {
    const result = await this.store.read()
    if (result.kind === 'none') {
      throw new Error('Profile registry not found')
    }
    if (result.kind === 'corrupt') {
      throw new Error(`Profile registry is corrupt at ${result.filePath}: ${result.error}`)
    }
    return result.value
  }

  private async ensureIdentity(identity: ProfileIdentity): Promise<ControlMutationResult<ProfileRecordV1>> {
    return withProfileControlLock(this.store.path, async () => {
      const registry = await this.read()
      const profileId = identity.kind === 'signed-out' ? 'signed-out' : computeProfileId(identity)
      const identityDigest = computeIdentityDigest(identity)
      const byId = registry.profiles.find((profile) => profile.profileId === profileId)
      const byDigest = registry.profiles.find((profile) => profile.identityDigest === identityDigest)

      if (byId || byDigest) {
        if (!byId || !byDigest || byId !== byDigest) {
          throw new Error('Profile registry is corrupt: profileId and identity digest map to different records')
        }
        this.assertRecordMatchesIdentity(byId, identity)
        return { value: byId, durability: { kind: 'not-written' } }
      }

      const created = this.createRecord(identity)
      const durability = await this.store.write({ ...registry, profiles: [...registry.profiles, created] })
      return { value: created, durability }
    })
  }

  private createRecord(identity: ProfileIdentity): ProfileRecordV1 {
    return ProfileRegistryV1Schema.shape.profiles.element.parse({
      version: 1,
      profileId: identity.kind === 'signed-out' ? 'signed-out' : computeProfileId(identity),
      identityDigest: computeIdentityDigest(identity),
      kind: identity.kind,
      state: 'ready',
      createdAt: new Date().toISOString()
    })
  }

  private validateRegistry(registry: ProfileRegistryV1): void {
    if (registry.profiles.length === 0) {
      throw new Error('Profile registry is corrupt: signed-out profile is missing')
    }

    const profileIds = new Set<string>()
    const identityDigests = new Set<string>()
    let signedOutCount = 0

    for (const record of registry.profiles) {
      if (profileIds.has(record.profileId)) {
        throw new Error(`Profile registry is corrupt: duplicate profileId ${record.profileId}`)
      }
      if (identityDigests.has(record.identityDigest)) {
        throw new Error(`Profile registry is corrupt: duplicate identity digest ${record.identityDigest}`)
      }
      profileIds.add(record.profileId)
      identityDigests.add(record.identityDigest)

      if (record.profileId === 'signed-out') {
        signedOutCount += 1
        if (record.identityDigest !== SIGNED_OUT_DIGEST || record.kind !== 'signed-out' || record.state !== 'ready') {
          throw new Error('Profile registry is corrupt: invalid signed-out profile')
        }
      } else if (record.profileId !== record.identityDigest.slice(0, 32) || record.kind === 'signed-out') {
        throw new Error(`Profile registry is corrupt: identity metadata mismatch for ${record.profileId}`)
      }
    }

    if (signedOutCount !== 1) {
      throw new Error('Profile registry is corrupt: expected exactly one signed-out profile')
    }
  }

  private assertRecordMatchesIdentity(record: ProfileRecordV1, identity: ProfileIdentity): void {
    const expectedProfileId = identity.kind === 'signed-out' ? 'signed-out' : computeProfileId(identity)
    const expectedDigest = computeIdentityDigest(identity)
    if (
      record.profileId !== expectedProfileId ||
      record.identityDigest !== expectedDigest ||
      record.kind !== identity.kind
    ) {
      throw new Error(`Profile registry is corrupt: identity metadata mismatch for ${record.profileId}`)
    }
  }
}
