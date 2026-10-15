import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ActiveProfilePointerV1Schema,
  ProfileActivePointer,
  ProfileControlStore,
  ProfileRegistry,
  ProfileRegistryV1Schema,
  type ProfileIdentity,
  type ProfileRegistryV1
} from '..'

const AUTHENTICATED_IDENTITY: ProfileIdentity = {
  kind: 'authenticated',
  accountKind: 'management',
  issuerId: 'issuer-1',
  subjectId: 'subject-1'
}
const temporaryDirectories: string[] = []

async function createPaths(): Promise<{ registryPath: string; pointerPath: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'profile-active-pointer-'))
  temporaryDirectories.push(directory)
  return {
    registryPath: path.join(directory, 'profiles.json'),
    pointerPath: path.join(directory, 'active-profile.json')
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('ProfileActivePointer', () => {
  it('serializes commits from equivalent pointer paths and writes complete pointers', async () => {
    const { registryPath, pointerPath } = await createPaths()
    const registry = new ProfileRegistry(registryPath)
    await registry.initialize()
    const firstRecord = (await registry.ensureAuthenticated(AUTHENTICATED_IDENTITY)).value
    const secondRecord = (await registry.ensureAuthenticated({ ...AUTHENTICATED_IDENTITY, subjectId: 'subject-2' }))
      .value
    let activeWrites = 0
    let maxActiveWrites = 0
    const makeStore = (filePath: string) => {
      const store = new ProfileControlStore(filePath, ActiveProfilePointerV1Schema)
      const write = store.write.bind(store)
      store.write = async (value) => {
        activeWrites += 1
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites)
        await new Promise((resolve) => setTimeout(resolve, 20))
        try {
          return await write(value)
        } finally {
          activeWrites -= 1
        }
      }
      return store
    }

    const results = await Promise.all([
      new ProfileActivePointer(makeStore(pointerPath), registry).commitPointer(firstRecord),
      new ProfileActivePointer(makeStore(`${path.dirname(pointerPath)}/./active-profile.json`), registry).commitPointer(
        secondRecord
      )
    ])

    expect(maxActiveWrites).toBe(1)
    const persisted = JSON.parse(await readFile(pointerPath, 'utf8'))
    expect(results.map((result) => result.value)).toContainEqual(persisted)
    expect(ActiveProfilePointerV1Schema.parse(persisted)).toEqual(persisted)
  })

  it('holds the registry lock until delayed pointer persistence finishes', async () => {
    const { registryPath, pointerPath } = await createPaths()
    const registryStore = new ProfileControlStore<ProfileRegistryV1>(registryPath, ProfileRegistryV1Schema)
    const registry = new ProfileRegistry(registryStore)
    await registry.initialize()
    const record = (await registry.ensureAuthenticated(AUTHENTICATED_IDENTITY)).value
    const pointerStore = new ProfileControlStore(pointerPath, ActiveProfilePointerV1Schema)
    const writePointer = pointerStore.write.bind(pointerStore)
    let releasePointerWrite!: () => void
    const pointerWriteStarted = new Promise<void>((resolve) => {
      pointerStore.write = async (value) => {
        resolve()
        await new Promise<void>((release) => {
          releasePointerWrite = release
        })
        return writePointer(value)
      }
    })
    let registryUpdateWritten = false
    const writeRegistry = registryStore.write.bind(registryStore)
    registryStore.write = async (value) => {
      registryUpdateWritten = true
      return writeRegistry(value)
    }

    const commit = new ProfileActivePointer(pointerStore, registry).commitPointer(record)
    await pointerWriteStarted
    const update = registry.updateAuthorizationContext(AUTHENTICATED_IDENTITY, { groupId: 'group-2' })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(registryUpdateWritten).toBe(false)
    releasePointerWrite()
    await Promise.all([commit, update])
    expect(registryUpdateWritten).toBe(true)
  })

  it('returns the committed pointer with unknown durability when confirmation fails', async () => {
    const { registryPath, pointerPath } = await createPaths()
    const registry = new ProfileRegistry(registryPath)
    await registry.initialize()
    const record = (await registry.ensureAuthenticated(AUTHENTICATED_IDENTITY)).value
    const store = new ProfileControlStore(pointerPath, ActiveProfilePointerV1Schema, async () => {
      throw new Error('directory sync failed')
    })

    const result = await new ProfileActivePointer(store, registry).commitPointer(record)

    expect(result.value).toMatchObject({ profileId: record.profileId, identityDigest: record.identityDigest })
    expect(result.durability).toEqual({
      kind: 'committed-durability-unknown',
      reason: 'error',
      error: 'directory sync failed'
    })
    await expect(new ProfileActivePointer(pointerPath, registry).read()).resolves.toMatchObject({
      kind: 'ok',
      value: result.value
    })
  })

  it('returns none when the pointer does not exist', async () => {
    const { registryPath, pointerPath } = await createPaths()
    const registry = new ProfileRegistry(registryPath)
    await registry.initialize()

    await expect(new ProfileActivePointer(pointerPath, registry).read()).resolves.toEqual({ kind: 'none' })
  })

  it('keeps legacy pointers without operationId readable', async () => {
    const { registryPath, pointerPath } = await createPaths()
    const registry = new ProfileRegistry(registryPath)
    await registry.initialize()
    const record = (await registry.ensureAuthenticated(AUTHENTICATED_IDENTITY)).value
    const legacyPointer = {
      version: 1,
      profileId: record.profileId,
      identityDigest: record.identityDigest,
      committedAt: '2026-10-14T12:34:56.000Z'
    }
    await writeFile(pointerPath, `${JSON.stringify(legacyPointer)}\n`, 'utf8')

    await expect(new ProfileActivePointer(pointerPath, registry).read()).resolves.toMatchObject({
      kind: 'ok',
      value: legacyPointer
    })
  })

  it('records the switch operation on a transactional pointer commit', async () => {
    const { registryPath, pointerPath } = await createPaths()
    const registry = new ProfileRegistry(registryPath)
    await registry.initialize()
    const record = (await registry.ensureAuthenticated(AUTHENTICATED_IDENTITY)).value

    const committed = (
      await new ProfileActivePointer(pointerPath, registry).commitPointer(
        record,
        '550e8400-e29b-41d4-a716-446655440000'
      )
    ).value

    expect(committed.operationId).toBe('550e8400-e29b-41d4-a716-446655440000')
  })

  it('commits and reads a pointer matching a verified ready registry record', async () => {
    const { registryPath, pointerPath } = await createPaths()
    const registry = new ProfileRegistry(registryPath)
    await registry.initialize()
    const record = (await registry.ensureAuthenticated(AUTHENTICATED_IDENTITY)).value
    const verified = await registry.requireActivatable(record.profileId, record.identityDigest)
    const pointer = new ProfileActivePointer(pointerPath, registry)

    const committed = (await pointer.commitPointer(verified)).value

    expect(committed).toMatchObject({
      version: 1,
      profileId: record.profileId,
      identityDigest: record.identityDigest,
      committedAt: expect.any(String)
    })
    await expect(pointer.read()).resolves.toEqual({ kind: 'ok', value: committed, record })
  })

  it.each([
    [
      'unknown profile',
      {
        profileId: '0123456789abcdef0123456789abcdef',
        identityDigest: '0'.repeat(64)
      }
    ],
    ['digest mismatch', { identityDigest: 'f'.repeat(64) }]
  ])('returns corrupt with the real pointer path for %s', async (_case, overrides) => {
    const { registryPath, pointerPath } = await createPaths()
    const registry = new ProfileRegistry(registryPath)
    await registry.initialize()
    const record = (await registry.ensureAuthenticated(AUTHENTICATED_IDENTITY)).value
    await writeFile(
      pointerPath,
      `${JSON.stringify(
        Object.assign(
          {
            version: 1,
            profileId: record.profileId,
            identityDigest: record.identityDigest,
            committedAt: '2026-10-14T12:34:56.000Z'
          },
          overrides
        )
      )}\n`,
      'utf8'
    )

    await expect(new ProfileActivePointer(pointerPath, registry).read()).resolves.toEqual({
      kind: 'corrupt',
      filePath: pointerPath,
      error: expect.any(String)
    })
  })

  it('returns corrupt with the real pointer path when the registry record is disabled', async () => {
    const { registryPath, pointerPath } = await createPaths()
    const registry = new ProfileRegistry(registryPath)
    await registry.initialize()
    const record = (await registry.ensureAuthenticated(AUTHENTICATED_IDENTITY)).value
    const registryDocument = JSON.parse(await readFile(registryPath, 'utf8'))
    registryDocument.profiles.find((profile: { profileId: string }) => profile.profileId === record.profileId).state =
      'disabled'
    await writeFile(registryPath, `${JSON.stringify(registryDocument)}\n`, 'utf8')
    await writeFile(
      pointerPath,
      `${JSON.stringify({
        version: 1,
        profileId: record.profileId,
        identityDigest: record.identityDigest,
        committedAt: '2026-10-14T12:34:56.000Z'
      })}\n`,
      'utf8'
    )

    await expect(new ProfileActivePointer(pointerPath, registry).read()).resolves.toEqual({
      kind: 'corrupt',
      filePath: pointerPath,
      error: expect.any(String)
    })
  })

  it('commits a reloaded registry record obtained from read()', async () => {
    const { registryPath, pointerPath } = await createPaths()
    const registry = new ProfileRegistry(registryPath)
    await registry.initialize()
    await registry.ensureAuthenticated(AUTHENTICATED_IDENTITY)
    const reloaded = (await registry.read()).profiles.find((profile) => profile.kind === 'authenticated')
    const pointer = new ProfileActivePointer(pointerPath, registry)

    const committed = (await pointer.commitPointer(reloaded!)).value

    expect(committed.profileId).toBe(reloaded!.profileId)
    expect(committed.identityDigest).toBe(reloaded!.identityDigest)
  })

  it('re-verifies the registry on commit and rejects an unregistered profile', async () => {
    const { registryPath, pointerPath } = await createPaths()
    const registry = new ProfileRegistry(registryPath)
    await registry.initialize()
    const record = (await registry.ensureAuthenticated(AUTHENTICATED_IDENTITY)).value
    const pointer = new ProfileActivePointer(pointerPath, registry)

    const registryDocument = JSON.parse(await readFile(registryPath, 'utf8'))
    const remaining = registryDocument.profiles.filter(
      (profile: { profileId: string }) => profile.profileId !== record.profileId
    )
    await writeFile(registryPath, `${JSON.stringify({ version: 1, profiles: remaining })}\n`, 'utf8')

    await expect(pointer.commitPointer(record)).rejects.toThrow(/not found/i)
  })

  it('rejects committing a record whose registry entry is disabled', async () => {
    const { registryPath, pointerPath } = await createPaths()
    const registry = new ProfileRegistry(registryPath)
    await registry.initialize()
    const record = (await registry.ensureAuthenticated(AUTHENTICATED_IDENTITY)).value
    const pointer = new ProfileActivePointer(pointerPath, registry)

    const registryDocument = JSON.parse(await readFile(registryPath, 'utf8'))
    registryDocument.profiles.find((profile: { profileId: string }) => profile.profileId === record.profileId).state =
      'disabled'
    await writeFile(registryPath, `${JSON.stringify(registryDocument)}\n`, 'utf8')

    await expect(pointer.commitPointer(record)).rejects.toThrow(/disabled/i)
  })

  it('rejects a tampered record whose identity metadata disagrees with the registry', async () => {
    const { registryPath, pointerPath } = await createPaths()
    const registry = new ProfileRegistry(registryPath)
    await registry.initialize()
    const record = (await registry.ensureAuthenticated(AUTHENTICATED_IDENTITY)).value
    const pointer = new ProfileActivePointer(pointerPath, registry)
    const tampered = { ...record, kind: 'local' as const }

    await expect(pointer.commitPointer(tampered)).rejects.toThrow(/metadata/i)
  })

  it('does not report committed when pointer persistence fails', async () => {
    const { registryPath, pointerPath } = await createPaths()
    const registry = new ProfileRegistry(registryPath)
    await registry.initialize()
    const record = (await registry.ensureAuthenticated(AUTHENTICATED_IDENTITY)).value
    const verified = await registry.requireActivatable(record.profileId, record.identityDigest)
    await writeFile(pointerPath, 'not-a-directory', 'utf8')
    const pointer = new ProfileActivePointer(path.join(pointerPath, 'active-profile.json'), registry)

    await expect(pointer.commitPointer(verified)).rejects.toMatchObject({ code: 'ENOTDIR' })
  })
})
