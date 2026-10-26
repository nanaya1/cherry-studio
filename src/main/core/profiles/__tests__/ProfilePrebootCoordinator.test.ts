import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  computeIdentityDigest,
  ProfileActivePointer,
  ProfileClaimService,
  ProfileInstallation,
  ProfilePrebootCoordinator,
  ProfileRegistry,
  ProfileSwitchJournal,
  type ProfileIdentity
} from '..'

const temporaryDirectories: string[] = []
const AUTHENTICATED_IDENTITY: ProfileIdentity = {
  kind: 'authenticated',
  accountKind: 'management',
  issuerId: 'issuer-1',
  subjectId: 'subject-1'
}
const OPERATION_ID = '550e8400-e29b-41d4-a716-446655440000'

async function createDataRoot(): Promise<string> {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'profile-preboot-'))
  temporaryDirectories.push(dataRoot)
  return dataRoot
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('ProfilePrebootCoordinator', () => {
  it('prioritizes a durable logout intent over an authenticated pointer after a crash', async () => {
    const dataRoot = await createDataRoot()
    const coordinator = new ProfilePrebootCoordinator({ dataRoot, legacyDataExists: async () => false })
    await coordinator.initialize()
    const control = path.join(dataRoot, 'control')
    const registry = new ProfileRegistry(path.join(control, 'profiles.json'))
    const source = (await registry.ensureAuthenticated(AUTHENTICATED_IDENTITY)).value
    const pointer = new ProfileActivePointer(path.join(control, 'active-profile.json'), registry)
    await pointer.commitPointer(source)
    await writeFile(
      path.join(control, 'logout-intent.json'),
      JSON.stringify({
        version: 1,
        operationId: OPERATION_ID,
        sourceProfileId: source.profileId
      })
    )

    expect(await coordinator.initialize()).toMatchObject({ mode: 'signed-out', profileId: 'signed-out' })
    expect(await pointer.read()).toMatchObject({ kind: 'ok', record: { kind: 'signed-out' } })
    expect(await coordinator.initialize()).toMatchObject({ mode: 'signed-out' })
  })

  it('retains logout intent when cleanup fails and finishes it on the next launch', async () => {
    const dataRoot = await createDataRoot()
    await new ProfilePrebootCoordinator({ dataRoot, legacyDataExists: async () => false }).initialize()
    const control = path.join(dataRoot, 'control')
    const registry = new ProfileRegistry(path.join(control, 'profiles.json'))
    const source = (await registry.ensureAuthenticated(AUTHENTICATED_IDENTITY)).value
    await new ProfileActivePointer(path.join(control, 'active-profile.json'), registry).commitPointer(source)
    const intentPath = path.join(control, 'logout-intent.json')
    await writeFile(
      intentPath,
      JSON.stringify({ version: 1, operationId: OPERATION_ID, sourceProfileId: source.profileId })
    )
    const cleanupCommittedSource = vi.fn().mockRejectedValueOnce(new Error('locked')).mockResolvedValue(undefined)
    const coordinator = new ProfilePrebootCoordinator({
      dataRoot,
      legacyDataExists: async () => false,
      cleanupCommittedSource
    })
    expect(await coordinator.initialize()).toMatchObject({ mode: 'signed-out', profileId: 'signed-out' })
    expect(JSON.parse(await readFile(intentPath, 'utf8'))).toMatchObject({ sourceProfileId: source.profileId })
    expect(await coordinator.initialize()).toMatchObject({ mode: 'signed-out' })
    expect(JSON.parse(await readFile(intentPath, 'utf8'))).toBeNull()
  })

  it('fails closed for a corrupt logout intent', async () => {
    const dataRoot = await createDataRoot()
    const coordinator = new ProfilePrebootCoordinator({ dataRoot, legacyDataExists: async () => false })
    await coordinator.initialize()
    await writeFile(path.join(dataRoot, 'control', 'logout-intent.json'), '{broken')
    expect(await coordinator.initialize()).toMatchObject({ mode: 'signed-out', profileId: 'signed-out' })
  })

  it('initializes installation and registry, then selects and persists signed-out on a clean first launch', async () => {
    const dataRoot = await createDataRoot()
    const context = await new ProfilePrebootCoordinator({ dataRoot, legacyDataExists: async () => false }).initialize()

    expect(context).toMatchObject({
      mode: 'signed-out',
      profileId: 'signed-out',
      identityDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      kind: 'signed-out',
      dataRoot
    })
    expect(context.profileRoot).toBe(path.join(dataRoot, 'profiles', 'signed-out'))
    await expect(readFile(path.join(dataRoot, 'control', 'installation.json'), 'utf8')).resolves.toContain(
      'deviceInstallId'
    )
    await expect(readFile(path.join(dataRoot, 'control', 'profiles.json'), 'utf8')).resolves.toContain('signed-out')
    await expect(readFile(path.join(dataRoot, 'control', 'active-profile.json'), 'utf8')).resolves.toContain(
      'signed-out'
    )
  })

  it('selects signed-out and defers legacy migration until after the first authentication', async () => {
    const dataRoot = await createDataRoot()
    const legacyRoot = path.join(path.dirname(dataRoot), 'legacy')
    const context = await new ProfilePrebootCoordinator({
      dataRoot,
      legacyRoot,
      legacyDataExists: async () => true
    }).initialize()

    expect(context).toMatchObject({ mode: 'signed-out', profileId: 'signed-out', legacyRoot })
    await expect(readFile(path.join(dataRoot, 'control', 'active-profile.json'), 'utf8')).resolves.toContain(
      'signed-out'
    )
  })

  it('commits a staged legacy claim for the active authenticated profile before business startup', async () => {
    const dataRoot = await createDataRoot()
    const legacyRoot = path.join(path.dirname(dataRoot), 'legacy-staged')
    const controlRoot = path.join(dataRoot, 'control')
    await mkdir(path.join(legacyRoot, 'Data'), { recursive: true })
    await writeFile(path.join(legacyRoot, 'Data', 'app.txt'), 'legacy')
    await new ProfilePrebootCoordinator({ dataRoot, legacyDataExists: async () => false }).initialize()
    const registry = new ProfileRegistry(path.join(controlRoot, 'profiles.json'))
    const authenticated = (await registry.ensureAuthenticated(AUTHENTICATED_IDENTITY)).value
    expect(authenticated.profileId).toHaveLength(32)
    const actualTargetUserData = path.join(dataRoot, 'profiles', authenticated.profileId, 'userData')
    const claim = new ProfileClaimService({
      localUserData: legacyRoot,
      targetUserData: actualTargetUserData,
      journalPath: path.join(controlRoot, 'legacy-claim.json')
    })
    const preview = await claim.preview()
    if (preview.status !== 'ready') throw new Error('expected ready preview')
    await claim.confirm({ previewId: preview.previewId, allow: [] })
    await new ProfileActivePointer(path.join(controlRoot, 'active-profile.json'), registry).commitPointer(authenticated)

    const context = await new ProfilePrebootCoordinator({
      dataRoot,
      legacyRoot,
      legacyDataExists: async () => true
    }).initialize()

    expect(context).toMatchObject({ mode: 'business', profileId: authenticated.profileId })
    await expect(claim.preview()).resolves.toEqual({ status: 'already-claimed' })
  })

  it('routes an active local pointer without legacy data to signed-out guidance, never to business', async () => {
    const dataRoot = await createDataRoot()
    await new ProfilePrebootCoordinator({ dataRoot, legacyDataExists: async () => false }).initialize()
    const controlRoot = path.join(dataRoot, 'control')
    const installation = new ProfileInstallation(path.join(controlRoot, 'installation.json'))
    const registry = new ProfileRegistry(path.join(controlRoot, 'profiles.json'))
    const deviceInstallId = (await installation.getOrCreate()).value.deviceInstallId
    const localRecord = (await registry.ensureLocal(deviceInstallId, 'default')).value
    await new ProfileActivePointer(path.join(controlRoot, 'active-profile.json'), registry).commitPointer(localRecord)

    const context = await new ProfilePrebootCoordinator({
      dataRoot,
      legacyDataExists: async () => false
    }).initialize()

    expect(context).toMatchObject({ mode: 'signed-out', profileId: 'signed-out', kind: 'signed-out' })
    expect(context.mode).not.toBe('business')
    const pointer = await new ProfileActivePointer(path.join(controlRoot, 'active-profile.json'), registry).read()
    expect(pointer.kind === 'ok' && pointer.record.kind).toBe('signed-out')
  })

  it('routes adopted local data to login even while the original legacy data remains', async () => {
    const dataRoot = await createDataRoot()
    await new ProfilePrebootCoordinator({ dataRoot, legacyDataExists: async () => false }).initialize()
    const controlRoot = path.join(dataRoot, 'control')
    const installation = new ProfileInstallation(path.join(controlRoot, 'installation.json'))
    const registry = new ProfileRegistry(path.join(controlRoot, 'profiles.json'))
    const deviceInstallId = (await installation.getOrCreate()).value.deviceInstallId
    const localRecord = (await registry.ensureLocal(deviceInstallId, 'default')).value
    await new ProfileActivePointer(path.join(controlRoot, 'active-profile.json'), registry).commitPointer(localRecord)

    const context = await new ProfilePrebootCoordinator({
      dataRoot,
      legacyDataExists: async () => true
    }).initialize()

    expect(context).toMatchObject({ mode: 'signed-out', profileId: 'signed-out' })
    expect(context.mode).not.toBe('business')
    const pointer = await new ProfileActivePointer(path.join(controlRoot, 'active-profile.json'), registry).read()
    expect(pointer.kind === 'ok' && pointer.record.kind).toBe('signed-out')
  })

  it.each(['installation.json', 'profiles.json', 'active-profile.json'])(
    'returns to signed-out login for corrupt %s',
    async (fileName) => {
      const dataRoot = await createDataRoot()
      const first = new ProfilePrebootCoordinator({ dataRoot, legacyDataExists: async () => false })
      await first.initialize()
      await writeFile(path.join(dataRoot, 'control', fileName), '{not-json', 'utf8')

      const context = await new ProfilePrebootCoordinator({
        dataRoot,
        legacyDataExists: async () => false
      }).initialize()

      expect(context).toMatchObject({ mode: 'signed-out', profileId: 'signed-out', kind: 'signed-out' })
      expect(context.mode).not.toBe('recovery')
      await expect(readFile(path.join(dataRoot, 'control', fileName), 'utf8')).resolves.toBe('{not-json')
    }
  )

  it('keeps the old pointer and exposes retry/cancel for a prepared switch that did not commit', async () => {
    const dataRoot = await createDataRoot()
    await new ProfilePrebootCoordinator({ dataRoot, legacyDataExists: async () => false }).initialize()
    const registry = new ProfileRegistry(path.join(dataRoot, 'control', 'profiles.json'))
    const target = (await registry.ensureAuthenticated(AUTHENTICATED_IDENTITY)).value
    await new ProfileSwitchJournal(path.join(dataRoot, 'control', 'switch-journal.json')).prepare({
      operationId: OPERATION_ID,
      fromProfileId: 'signed-out',
      targetProfileId: target.profileId,
      targetIdentityDigest: target.identityDigest
    })

    const context = await new ProfilePrebootCoordinator({ dataRoot, legacyDataExists: async () => false }).initialize()

    expect(context).toMatchObject({
      mode: 'signed-out',
      profileId: 'signed-out',
      pendingSwitch: { operationId: OPERATION_ID, action: 'retry-or-cancel' }
    })
  })

  it('reconciles a pointer committed before the journal commit and never mixes operations', async () => {
    const dataRoot = await createDataRoot()
    await new ProfilePrebootCoordinator({ dataRoot, legacyDataExists: async () => false }).initialize()
    const registry = new ProfileRegistry(path.join(dataRoot, 'control', 'profiles.json'))
    const target = (await registry.ensureAuthenticated(AUTHENTICATED_IDENTITY)).value
    const journal = new ProfileSwitchJournal(path.join(dataRoot, 'control', 'switch-journal.json'))
    await journal.prepare({
      operationId: OPERATION_ID,
      fromProfileId: 'signed-out',
      targetProfileId: target.profileId,
      targetIdentityDigest: target.identityDigest
    })
    await new ProfileActivePointer(path.join(dataRoot, 'control', 'active-profile.json'), registry).commitPointer(
      target,
      OPERATION_ID
    )

    const context = await new ProfilePrebootCoordinator({ dataRoot, legacyDataExists: async () => false }).initialize()

    expect(context).toMatchObject({
      mode: 'business',
      profileId: target.profileId,
      identityDigest: target.identityDigest,
      kind: 'authenticated'
    })
    await expect(journal.read()).resolves.toMatchObject({
      kind: 'ok',
      value: { phase: 'committed', operationId: OPERATION_ID }
    })
  })

  it('cleans committed source profile artifacts after switching to signed-out', async () => {
    const dataRoot = await createDataRoot()
    await new ProfilePrebootCoordinator({ dataRoot, legacyDataExists: async () => false }).initialize()
    const registry = new ProfileRegistry(path.join(dataRoot, 'control', 'profiles.json'))
    const source = (await registry.ensureAuthenticated(AUTHENTICATED_IDENTITY)).value
    const signedOut = await registry.requireActivatable(
      'signed-out',
      computeIdentityDigest({ kind: 'signed-out', bootstrapId: 'signed-out' })
    )
    const journal = new ProfileSwitchJournal(path.join(dataRoot, 'control', 'switch-journal.json'))
    await journal.prepare({
      operationId: OPERATION_ID,
      fromProfileId: source.profileId,
      targetProfileId: signedOut.profileId,
      targetIdentityDigest: signedOut.identityDigest
    })
    await new ProfileActivePointer(path.join(dataRoot, 'control', 'active-profile.json'), registry).commitPointer(
      signedOut,
      OPERATION_ID
    )
    await journal.commit({
      operationId: OPERATION_ID,
      targetProfileId: signedOut.profileId,
      targetIdentityDigest: signedOut.identityDigest
    })
    const cleanupCommittedSource = vi.fn()

    await new ProfilePrebootCoordinator({
      dataRoot,
      legacyDataExists: async () => false,
      cleanupCommittedSource
    }).initialize()

    expect(cleanupCommittedSource).toHaveBeenCalledWith(path.join(dataRoot, 'profiles', source.profileId))
  })

  it('does not reconcile a prepared journal against a pointer from another operation', async () => {
    const dataRoot = await createDataRoot()
    await new ProfilePrebootCoordinator({ dataRoot, legacyDataExists: async () => false }).initialize()
    const registry = new ProfileRegistry(path.join(dataRoot, 'control', 'profiles.json'))
    const target = (await registry.ensureAuthenticated(AUTHENTICATED_IDENTITY)).value
    const journal = new ProfileSwitchJournal(path.join(dataRoot, 'control', 'switch-journal.json'))
    await journal.prepare({
      operationId: OPERATION_ID,
      fromProfileId: 'signed-out',
      targetProfileId: target.profileId,
      targetIdentityDigest: target.identityDigest
    })
    await new ProfileActivePointer(path.join(dataRoot, 'control', 'active-profile.json'), registry).commitPointer(
      target,
      'b3d57d89-8ca3-4c5b-8f1e-a8ee94db7607'
    )

    const context = await new ProfilePrebootCoordinator({ dataRoot, legacyDataExists: async () => false }).initialize()

    expect(context).toMatchObject({ mode: 'signed-out', profileId: 'signed-out', kind: 'signed-out' })
    expect(context.mode).not.toBe('recovery')
    await expect(journal.read()).resolves.toMatchObject({ kind: 'ok', value: { phase: 'prepared' } })
  })

  it('rejects an active profile path that escapes through a profiles-root symlink', async () => {
    const dataRoot = await createDataRoot()
    const outside = await createDataRoot()
    await mkdir(path.join(dataRoot, 'control'), { recursive: true })
    await rm(path.join(dataRoot, 'profiles'), { recursive: true, force: true })
    await import('node:fs/promises').then(({ symlink }) => symlink(outside, path.join(dataRoot, 'profiles')))

    const context = await new ProfilePrebootCoordinator({ dataRoot, legacyDataExists: async () => false }).initialize()

    expect(context).toMatchObject({ mode: 'signed-out', profileId: 'signed-out', kind: 'signed-out' })
    expect(context.mode).not.toBe('recovery')
    expect(context.profileRoot).toBe(path.join(dataRoot, 'profiles', 'signed-out'))
  })
})
