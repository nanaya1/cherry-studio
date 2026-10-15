import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createProfilePaths,
  ProfileActivePointer,
  ProfileInstallation,
  ProfileRegistry,
  ProfileSwitchJournal,
  type ProfileIdentity
} from '..'

const AUTHENTICATED_IDENTITIES = [
  {
    kind: 'authenticated',
    accountKind: 'management',
    issuerId: 'management.example.test',
    subjectId: 'user-100'
  },
  {
    kind: 'authenticated',
    accountKind: 'official',
    issuerId: 'official.example.test',
    subjectId: 'user-200'
  }
] as const satisfies readonly Extract<ProfileIdentity, { kind: 'authenticated' }>[]

const temporaryDirectories: string[] = []

async function createControlPlane() {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'profile-control-plane-'))
  temporaryDirectories.push(dataRoot)
  const paths = createProfilePaths(dataRoot)
  await mkdir(paths.controlRoot)

  const files = {
    installation: path.join(paths.controlRoot, 'installation.json'),
    registry: path.join(paths.controlRoot, 'profiles.json'),
    pointer: path.join(paths.controlRoot, 'active-profile.json'),
    journal: path.join(paths.controlRoot, 'switch-journal.json')
  }

  const installation = new ProfileInstallation(files.installation)
  const registry = new ProfileRegistry(files.registry)
  const pointer = new ProfileActivePointer(files.pointer, registry)
  const journal = new ProfileSwitchJournal(files.journal)

  return { paths, files, installation, registry, pointer, journal }
}

async function expectMissing(filePath: string): Promise<void> {
  await expect(access(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
}

async function expectNoBusinessStorage(
  paths: ReturnType<typeof createProfilePaths>,
  profileIds: string[]
): Promise<void> {
  await expectMissing(paths.profilesRoot)
  await Promise.all(
    profileIds.flatMap((profileId) => [
      expectMissing(path.join(paths.profilesRoot, profileId, 'Data')),
      expectMissing(path.join(paths.profilesRoot, profileId, 'Data', 'app.db'))
    ])
  )
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Profile control plane integration', () => {
  it('persists stable signed-out, default local, and distinct authenticated identities without business storage', async () => {
    const first = await createControlPlane()
    const installation = (await first.installation.getOrCreate()).value
    const initialRegistry = (await first.registry.initialize()).value
    const local = (await first.registry.ensureLocal(installation.deviceInstallId, 'default')).value
    const authenticated = [
      (await first.registry.ensureAuthenticated(AUTHENTICATED_IDENTITIES[0])).value,
      (await first.registry.ensureAuthenticated(AUTHENTICATED_IDENTITIES[1])).value
    ]

    expect(initialRegistry.profiles).toHaveLength(1)
    expect(initialRegistry.profiles[0]).toMatchObject({
      profileId: 'signed-out',
      kind: 'signed-out'
    })
    expect(local).not.toHaveProperty('identity')
    expect(new Set(authenticated.map((record) => record.profileId)).size).toBe(2)

    const reloadedInstallation = (await new ProfileInstallation(first.files.installation).getOrCreate()).value
    const reloadedRegistry = new ProfileRegistry(first.files.registry)
    const reloaded = (await reloadedRegistry.initialize()).value

    expect(reloadedInstallation).toEqual(installation)
    expect(reloaded.profiles.map((record) => record.profileId)).toEqual([
      'signed-out',
      local.profileId,
      ...authenticated.map((record) => record.profileId)
    ])
    expect(await readFile(first.files.registry, 'utf8')).not.toMatch(/issuerId|subjectId|deviceInstallId/)

    const updated = (
      await reloadedRegistry.updateAuthorizationContext(AUTHENTICATED_IDENTITIES[0], {
        groupId: 'group-2',
        role: 'admin',
        status: 'active',
        checkedAt: '2026-10-14T12:34:56.000Z'
      })
    ).value
    expect(updated.profileId).toBe(authenticated[0].profileId)
    expect((await reloadedRegistry.read()).profiles).toHaveLength(4)

    expect(await readdir(first.paths.dataRoot)).toEqual(['control'])
    expect(await readdir(first.paths.controlRoot)).toEqual(
      expect.arrayContaining(['installation.json', 'profiles.json'])
    )
    expect((await readdir(first.paths.controlRoot)).filter((name) => name.includes('.tmp-'))).toEqual([])
    await expectNoBusinessStorage(
      first.paths,
      (await reloadedRegistry.read()).profiles.map((record) => record.profileId)
    )
  })

  it.each([
    [
      'installation',
      'installation.json',
      (control: Awaited<ReturnType<typeof createControlPlane>>) => control.installation.getOrCreate()
    ],
    [
      'registry',
      'profiles.json',
      (control: Awaited<ReturnType<typeof createControlPlane>>) => control.registry.initialize()
    ],
    [
      'pointer',
      'active-profile.json',
      (control: Awaited<ReturnType<typeof createControlPlane>>) => control.pointer.read()
    ],
    [
      'journal',
      'switch-journal.json',
      (control: Awaited<ReturnType<typeof createControlPlane>>) =>
        control.journal.prepare({
          operationId: randomUUID(),
          fromProfileId: 'signed-out',
          targetProfileId: '0123456789abcdef0123456789abcdef',
          targetIdentityDigest: '0'.repeat(64)
        })
    ]
  ] as const)('fails closed and preserves a corrupt %s control file', async (_kind, fileName, readControl) => {
    const control = await createControlPlane()
    const filePath = path.join(control.paths.controlRoot, fileName)
    const corruptContent = '{not-json'
    await writeFile(filePath, corruptContent, 'utf8')

    const result = readControl(control)
    if (fileName === 'active-profile.json') {
      await expect(result).resolves.toMatchObject({ kind: 'corrupt', filePath })
    } else {
      await expect(result).rejects.toThrow(/corrupt/i)
    }
    await expect(readFile(filePath, 'utf8')).resolves.toBe(corruptContent)
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
  ])('rejects pointer and journal targets with %s without overwriting either file', async (_case, overrides) => {
    const control = await createControlPlane()
    await control.registry.initialize()
    const record = (await control.registry.ensureAuthenticated(AUTHENTICATED_IDENTITIES[0])).value
    const target = { ...record, ...overrides }
    const pointerContent = `${JSON.stringify({
      version: 1,
      profileId: target.profileId,
      identityDigest: target.identityDigest,
      committedAt: '2026-10-14T12:34:56.000Z'
    })}\n`
    await writeFile(control.files.pointer, pointerContent, 'utf8')

    await expect(control.pointer.read()).resolves.toMatchObject({ kind: 'corrupt', filePath: control.files.pointer })
    await expect(readFile(control.files.pointer, 'utf8')).resolves.toBe(pointerContent)

    const journalContent = `${JSON.stringify({
      version: 1,
      phase: 'prepared',
      operationId: randomUUID(),
      fromProfileId: 'signed-out',
      targetProfileId: target.profileId,
      targetIdentityDigest: target.identityDigest,
      createdAt: '2026-10-14T12:34:56.000Z'
    })}\n`
    await writeFile(control.files.journal, journalContent, 'utf8')
    const journalBeforeValidation = await readFile(control.files.journal, 'utf8')
    const journal = await control.journal.read()
    expect(journal).toMatchObject({ kind: 'ok' })
    if (journal.kind !== 'ok') {
      throw new Error('expected a syntactically valid prepared journal')
    }

    await expect(
      control.registry.requireActivatable(journal.value.targetProfileId, journal.value.targetIdentityDigest)
    ).rejects.toThrow(/not found|digest does not match/i)
    await expect(readFile(control.files.journal, 'utf8')).resolves.toBe(journalBeforeValidation)
    expect((await readdir(control.paths.controlRoot)).filter((name) => name.includes('.tmp-'))).toEqual([])
  })
})
