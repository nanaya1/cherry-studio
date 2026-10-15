import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  computeIdentityDigest,
  computeProfileId,
  ProfileRegistry,
  type ProfileIdentity,
  type ProfileRegistryV1
} from '..'

const DEVICE_INSTALL_ID = '550e8400-e29b-41d4-a716-446655440000'
const AUTHENTICATED_IDENTITY: ProfileIdentity = {
  kind: 'authenticated',
  accountKind: 'management',
  issuerId: 'issuer-1',
  subjectId: 'subject-1'
}
const temporaryDirectories: string[] = []

async function createRegistryPath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'profile-registry-'))
  temporaryDirectories.push(directory)
  return path.join(directory, 'profiles.json')
}

function recordFor(identity: ProfileIdentity, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    profileId: identity.kind === 'signed-out' ? 'signed-out' : computeProfileId(identity),
    identityDigest: computeIdentityDigest(identity),
    kind: identity.kind,
    state: 'ready',
    createdAt: '2026-10-14T12:34:56.000Z',
    ...overrides
  }
}

async function writeRegistry(filePath: string, profiles: unknown[]): Promise<string> {
  const content = `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`
  await writeFile(filePath, content, 'utf8')
  return content
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('ProfileRegistry', () => {
  it('returns the committed registry with unknown durability when confirmation fails', async () => {
    const filePath = await createRegistryPath()
    const { ProfileControlStore, ProfileRegistryV1Schema } = await import('..')
    const store = new ProfileControlStore<ProfileRegistryV1>(filePath, ProfileRegistryV1Schema, async () => {
      throw new Error('directory sync failed')
    })

    const result = await new ProfileRegistry(store).initialize()

    expect(result.value.profiles).toHaveLength(1)
    expect(result.durability).toEqual({
      kind: 'committed-durability-unknown',
      reason: 'error',
      error: 'directory sync failed'
    })
    await expect(new ProfileRegistry(filePath).read()).resolves.toEqual(result.value)
  })

  it('initializes an empty registry with exactly one signed-out record', async () => {
    const filePath = await createRegistryPath()
    const registry = new ProfileRegistry(filePath)

    const value = (await registry.initialize()).value

    expect(value.profiles).toHaveLength(1)
    expect(value.profiles[0]).toMatchObject({
      profileId: 'signed-out',
      kind: 'signed-out',
      state: 'ready'
    })
    expect(value.profiles[0]).not.toHaveProperty('identity')
    expect(value.profiles[0].identityDigest).toBe(
      computeIdentityDigest({ kind: 'signed-out', bootstrapId: 'signed-out' })
    )
  })

  it('makes ensureLocal idempotent and derives identity metadata', async () => {
    const registry = new ProfileRegistry(await createRegistryPath())
    await registry.initialize()

    const first = (await registry.ensureLocal(DEVICE_INSTALL_ID, 'default')).value
    const second = (await registry.ensureLocal(DEVICE_INSTALL_ID, 'default')).value
    const value = await registry.read()
    const identity: ProfileIdentity = { kind: 'local', deviceInstallId: DEVICE_INSTALL_ID, localUserId: 'default' }

    expect(second).toEqual(first)
    expect(first).toMatchObject({
      profileId: computeProfileId(identity),
      identityDigest: computeIdentityDigest(identity),
      kind: 'local'
    })
    expect(first).not.toHaveProperty('identity')
    expect(value.profiles.filter((profile) => profile.profileId === first.profileId)).toHaveLength(1)
  })

  it('makes ensureAuthenticated idempotent and derives identity metadata', async () => {
    const registry = new ProfileRegistry(await createRegistryPath())
    await registry.initialize()

    const first = (await registry.ensureAuthenticated(AUTHENTICATED_IDENTITY)).value
    const second = (await registry.ensureAuthenticated(AUTHENTICATED_IDENTITY)).value

    expect(second).toEqual(first)
    expect(first).toMatchObject({
      profileId: computeProfileId(AUTHENTICATED_IDENTITY),
      identityDigest: computeIdentityDigest(AUTHENTICATED_IDENTITY),
      kind: 'authenticated'
    })
    expect(first).not.toHaveProperty('identity')
  })

  it.each([
    [
      'duplicate profileId',
      (first: ReturnType<typeof recordFor>, second: ReturnType<typeof recordFor>) => ({
        ...second,
        profileId: first.profileId
      })
    ],
    [
      'duplicate identity digest',
      (first: ReturnType<typeof recordFor>, second: ReturnType<typeof recordFor>) => ({
        ...second,
        identityDigest: first.identityDigest
      })
    ]
  ])('fails closed for %s without changing the registry', async (_case, changeSecond) => {
    const filePath = await createRegistryPath()
    const first = recordFor(AUTHENTICATED_IDENTITY)
    const second = recordFor({ ...AUTHENTICATED_IDENTITY, subjectId: 'subject-2' })
    const signedOut = recordFor({ kind: 'signed-out', bootstrapId: 'signed-out' })
    const content = await writeRegistry(filePath, [signedOut, first, changeSecond(first, second)])

    await expect(new ProfileRegistry(filePath).read()).rejects.toThrow(/corrupt/i)
    await expect(readFile(filePath, 'utf8')).resolves.toBe(content)
  })

  it.each([['profileId', { profileId: '0123456789abcdef0123456789abcdef' }]])(
    'fails closed when %s is inconsistent with digest metadata',
    async (_field, overrides) => {
      const filePath = await createRegistryPath()
      const signedOut = recordFor({ kind: 'signed-out', bootstrapId: 'signed-out' })
      const content = await writeRegistry(filePath, [signedOut, recordFor(AUTHENTICATED_IDENTITY, overrides)])

      await expect(new ProfileRegistry(filePath).read()).rejects.toThrow(/corrupt/i)
      await expect(readFile(filePath, 'utf8')).resolves.toBe(content)
    }
  )

  it('repairs an existing empty registry during initialize', async () => {
    const filePath = await createRegistryPath()
    await writeRegistry(filePath, [])

    const value = (await new ProfileRegistry(filePath).initialize()).value

    expect(value.profiles).toHaveLength(1)
    expect(value.profiles[0]).toMatchObject({ profileId: 'signed-out', kind: 'signed-out' })
  })

  it.each([
    ['missing signed-out', [recordFor(AUTHENTICATED_IDENTITY)]],
    [
      'invalid signed-out digest',
      [recordFor({ kind: 'signed-out', bootstrapId: 'signed-out' }, { identityDigest: '0'.repeat(64) })]
    ],
    ['signed-out kind mismatch', [recordFor({ kind: 'signed-out', bootstrapId: 'signed-out' }, { kind: 'local' })]],
    [
      'disabled signed-out',
      [
        recordFor({ kind: 'signed-out', bootstrapId: 'signed-out' }, { state: 'disabled' }),
        recordFor(AUTHENTICATED_IDENTITY)
      ]
    ]
  ])('fails closed for a non-empty registry with %s', async (_case, profiles) => {
    const filePath = await createRegistryPath()
    const content = await writeRegistry(filePath, profiles)

    await expect(new ProfileRegistry(filePath).initialize()).rejects.toThrow(/corrupt/i)
    await expect(readFile(filePath, 'utf8')).resolves.toBe(content)
  })

  it('rejects a disabled signed-out profile without changing it during initialize', async () => {
    const filePath = await createRegistryPath()
    const content = await writeRegistry(filePath, [
      recordFor({ kind: 'signed-out', bootstrapId: 'signed-out' }, { state: 'disabled' })
    ])
    const registry = new ProfileRegistry(filePath)

    await expect(registry.read()).rejects.toThrow(/corrupt/i)
    await expect(registry.initialize()).rejects.toThrow(/corrupt/i)
    await expect(readFile(filePath, 'utf8')).resolves.toBe(content)
  })

  it.each([
    ['dot segment', (directory: string) => `${directory}/./profiles.json`],
    ['symlink parent', (directory: string) => path.join(`${directory}-link`, 'profiles.json')]
  ])('serializes concurrent ensures across equivalent %s paths', async (_case, equivalentPath) => {
    const filePath = await createRegistryPath()
    const directory = path.dirname(filePath)
    const linkPath = `${directory}-link`
    await new ProfileRegistry(filePath).initialize()
    const identities = [AUTHENTICATED_IDENTITY, { ...AUTHENTICATED_IDENTITY, subjectId: 'subject-2' }] as const

    if (_case === 'symlink parent') {
      await symlink(directory, linkPath, 'dir')
    }
    try {
      await Promise.all([
        new ProfileRegistry(filePath).ensureAuthenticated(identities[0]),
        new ProfileRegistry(equivalentPath(directory)).ensureAuthenticated(identities[1])
      ])
    } finally {
      if (_case === 'symlink parent') {
        await unlink(linkPath)
      }
    }

    const profiles = (await new ProfileRegistry(filePath).read()).profiles
    expect(profiles.map((profile) => profile.profileId)).toEqual(
      expect.arrayContaining(['signed-out', ...identities.map(computeProfileId)])
    )
    expect(profiles).toHaveLength(3)
  })

  it('serializes concurrent ensures across registry instances without losing either profile', async () => {
    const filePath = await createRegistryPath()
    await new ProfileRegistry(filePath).initialize()
    const first = new ProfileRegistry(filePath)
    const second = new ProfileRegistry(filePath)
    const identities = [AUTHENTICATED_IDENTITY, { ...AUTHENTICATED_IDENTITY, subjectId: 'subject-2' }] as const

    await Promise.all([first.ensureAuthenticated(identities[0]), second.ensureAuthenticated(identities[1])])

    const profiles = (await first.read()).profiles
    expect(profiles.map((profile) => profile.profileId)).toEqual(
      expect.arrayContaining(['signed-out', ...identities.map(computeProfileId)])
    )
    expect(profiles).toHaveLength(3)
  })

  it('serializes ensure and authorization updates across registry instances', async () => {
    const filePath = await createRegistryPath()
    const setup = new ProfileRegistry(filePath)
    await setup.initialize()
    const existing = (await setup.ensureAuthenticated(AUTHENTICATED_IDENTITY)).value
    const other = { ...AUTHENTICATED_IDENTITY, subjectId: 'subject-2' } as const

    await Promise.all([
      new ProfileRegistry(filePath).ensureAuthenticated(other),
      new ProfileRegistry(filePath).updateAuthorizationContext(AUTHENTICATED_IDENTITY, { groupId: 'group-2' })
    ])

    const profiles = (await setup.read()).profiles
    expect(profiles.find((profile) => profile.profileId === existing.profileId)?.authorizationContext).toEqual({
      groupId: 'group-2'
    })
    expect(profiles.some((profile) => profile.profileId === computeProfileId(other))).toBe(true)
  })

  it('rejects an existing profileId mapped to a different identity', async () => {
    const filePath = await createRegistryPath()
    const identity = { ...AUTHENTICATED_IDENTITY, subjectId: 'subject-2' } as const
    await writeRegistry(filePath, [recordFor(identity, { profileId: computeProfileId(AUTHENTICATED_IDENTITY) })])

    await expect(new ProfileRegistry(filePath).ensureAuthenticated(AUTHENTICATED_IDENTITY)).rejects.toThrow(/corrupt/i)
  })

  it('rejects an existing identity digest mapped to a different profileId', async () => {
    const filePath = await createRegistryPath()
    await writeRegistry(filePath, [
      recordFor(AUTHENTICATED_IDENTITY, { profileId: '0123456789abcdef0123456789abcdef' })
    ])

    await expect(new ProfileRegistry(filePath).ensureAuthenticated(AUTHENTICATED_IDENTITY)).rejects.toThrow(/corrupt/i)
  })

  it('updates group context without creating another profile', async () => {
    const registry = new ProfileRegistry(await createRegistryPath())
    await registry.initialize()
    const original = await registry.ensureAuthenticated(AUTHENTICATED_IDENTITY)

    const updated = (
      await registry.updateAuthorizationContext(AUTHENTICATED_IDENTITY, {
        groupId: 'group-2',
        role: 'admin',
        status: 'active',
        checkedAt: '2026-10-14T12:34:56.000Z'
      })
    ).value
    const value = await registry.read()

    expect(updated.profileId).toBe(original.value.profileId)
    expect(updated.authorizationContext?.groupId).toBe('group-2')
    expect(value.profiles).toHaveLength(2)
  })

  it('does not create a profile while updating authorization context', async () => {
    const registry = new ProfileRegistry(await createRegistryPath())
    await registry.initialize()

    await expect(registry.updateAuthorizationContext(AUTHENTICATED_IDENTITY, { groupId: 'group-2' })).rejects.toThrow(
      /not found/i
    )
    expect((await registry.read()).profiles).toHaveLength(1)
  })

  it('does not return a disabled profile as activatable', async () => {
    const filePath = await createRegistryPath()
    const disabled = recordFor(AUTHENTICATED_IDENTITY, { state: 'disabled' })
    await writeRegistry(filePath, [recordFor({ kind: 'signed-out', bootstrapId: 'signed-out' }), disabled])

    await expect(
      new ProfileRegistry(filePath).requireActivatable(disabled.profileId, disabled.identityDigest)
    ).rejects.toThrow(/disabled/i)
  })

  it('fails closed for malformed JSON and never overwrites it', async () => {
    const filePath = await createRegistryPath()
    const content = '{not-json'
    await writeFile(filePath, content, 'utf8')

    await expect(new ProfileRegistry(filePath).initialize()).rejects.toThrow(/corrupt/i)
    await expect(readFile(filePath, 'utf8')).resolves.toBe(content)
  })

  it('accepts a ProfileControlStore constructor dependency', async () => {
    const filePath = await createRegistryPath()
    const { ProfileControlStore, ProfileRegistryV1Schema } = await import('..')
    const store = new ProfileControlStore<ProfileRegistryV1>(filePath, ProfileRegistryV1Schema)

    const value = (await new ProfileRegistry(store).initialize()).value

    expect(value.profiles).toHaveLength(1)
  })
})
