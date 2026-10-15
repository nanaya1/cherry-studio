import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  LegacyProfileAdoption,
  ProfileActivePointer,
  ProfileInstallation,
  ProfileRegistry,
  type LegacyAdoptionManifestV1,
  validateSqliteIntegrity
} from '..'

const roots: string[] = []

async function fixture() {
  const parent = await mkdtemp(path.join(tmpdir(), 'legacy-adoption-'))
  roots.push(parent)
  const legacyRoot = path.join(parent, 'legacy')
  const dataRoot = path.join(parent, 'profiles-v2')
  await mkdir(path.join(legacyRoot, 'Data'), { recursive: true })
  await writeFile(path.join(legacyRoot, 'Data', 'app.db'), 'sqlite-data')
  await writeFile(path.join(legacyRoot, 'Data', 'large.bin'), Buffer.alloc(2 * 1024 * 1024, 7))
  await writeFile(path.join(legacyRoot, 'Preferences'), 'ordinary-settings')
  await mkdir(path.join(legacyRoot, 'Sensitive'), { recursive: true })
  await writeFile(path.join(legacyRoot, 'Sensitive', 'token'), 'secret')
  await mkdir(path.join(legacyRoot, 'Data', 'enterprise'), { recursive: true })
  await writeFile(path.join(legacyRoot, 'Data', 'enterprise', 'org-session.json'), 'session')
  await writeFile(path.join(legacyRoot, 'SingletonLock'), 'locked')
  return { parent, legacyRoot, dataRoot }
}

async function control(dataRoot: string) {
  const controlRoot = path.join(dataRoot, 'control')
  await mkdir(controlRoot, { recursive: true })
  const installation = new ProfileInstallation(path.join(controlRoot, 'installation.json'))
  const registry = new ProfileRegistry(path.join(controlRoot, 'profiles.json'))
  await registry.initialize()
  const pointer = new ProfileActivePointer(path.join(controlRoot, 'active-profile.json'), registry)
  return { installation, registry, pointer }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('LegacyProfileAdoption', () => {
  it('checks SQLite integrity through a readonly better-sqlite3 connection', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sqlite-integrity-'))
    roots.push(root)
    const databasePath = path.join(root, 'valid.sqlite')
    const database = new Database(databasePath)
    database.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY); INSERT INTO sample DEFAULT VALUES')
    database.close()

    await expect(validateSqliteIntegrity(databasePath)).resolves.toBeUndefined()
    await writeFile(path.join(root, 'invalid.sqlite'), 'not-a-database')
    await expect(validateSqliteIntegrity(path.join(root, 'invalid.sqlite'))).rejects.toThrow()
  })

  it('copies legacy business data into default local with a verified manifest and quarantines excluded paths', async () => {
    const { legacyRoot, dataRoot } = await fixture()
    const { installation, registry, pointer } = await control(dataRoot)
    const sqliteValidator = vi.fn(async () => undefined)
    const service = new LegacyProfileAdoption({ legacyRoot, dataRoot, installation, registry, pointer, sqliteValidator })

    const result = await service.adopt()

    expect(result.status).toBe('adopted')
    if (result.status !== 'adopted') throw new Error('expected adoption')
    expect(result.profile.kind).toBe('local')
    expect(sqliteValidator).toHaveBeenCalledWith(expect.stringContaining(path.join('Data', 'app.db')))
    const target = path.join(dataRoot, 'profiles', result.profile.profileId, 'userData')
    await expect(readFile(path.join(target, 'Data', 'large.bin'))).resolves.toHaveLength(2 * 1024 * 1024)
    await expect(access(path.join(target, 'Sensitive'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(path.join(target, 'SingletonLock'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path.join(legacyRoot, 'Data', 'app.db'), 'utf8')).resolves.toBe('sqlite-data')

    const manifest = JSON.parse(
      await readFile(path.join(target, 'Runtime', 'LegacyProfileAdoption', 'manifest.json'), 'utf8')
    ) as LegacyAdoptionManifestV1
    expect(manifest.totalBytes).toBe(manifest.files.reduce((total, file) => total + file.size, 0))
    expect(manifest.files).toContainEqual({
      path: 'Preferences',
      size: Buffer.byteLength('ordinary-settings'),
      sha256: createHash('sha256').update('ordinary-settings').digest('hex')
    })
    expect(manifest.quarantine.map((item) => item.path)).toEqual(
      expect.arrayContaining(['Sensitive', 'SingletonLock', 'Data/enterprise/org-session.json'])
    )
    await expect(pointer.read()).resolves.toMatchObject({ kind: 'ok', record: { kind: 'local' } })
  })

  it.each([
    ['target inside source', (root: string) => [root, path.join(root, 'profiles-v2')]],
    ['source inside target', (root: string) => [path.join(root, 'legacy'), root]]
  ])('rejects recursive path topology: %s', async (_name, pathsFor) => {
    const root = await mkdtemp(path.join(tmpdir(), 'legacy-recursion-'))
    roots.push(root)
    const [legacyRoot, dataRoot] = pathsFor(root)
    await mkdir(legacyRoot, { recursive: true })
    await expect(new LegacyProfileAdoption({ legacyRoot, dataRoot }).adopt()).rejects.toThrow(/inside|overlap/i)
  })

  it('rejects symlinks without committing a pointer', async () => {
    const { parent, legacyRoot, dataRoot } = await fixture()
    await symlink(path.join(legacyRoot, 'Data'), path.join(legacyRoot, 'linked'))
    const { installation, registry, pointer } = await control(dataRoot)
    await expect(
      new LegacyProfileAdoption({ legacyRoot, dataRoot, installation, registry, pointer }).adopt()
    ).rejects.toThrow(/symbolic link/i)
    await expect(pointer.read()).resolves.toEqual({ kind: 'none' })
    await expect(access(path.join(parent, 'legacy', 'linked'))).resolves.toBeUndefined()
  })

  it.each(['ENOSPC', 'EBUSY'])('keeps pointer unchanged when staging copy fails with %s', async (code) => {
    const { legacyRoot, dataRoot } = await fixture()
    const { installation, registry, pointer } = await control(dataRoot)
    const copyFile = vi.fn(async () => {
      throw Object.assign(new Error(code), { code })
    })
    const service = new LegacyProfileAdoption({ legacyRoot, dataRoot, installation, registry, pointer, copyFile })

    await expect(service.adopt()).rejects.toMatchObject({ code })
    await expect(pointer.read()).resolves.toEqual({ kind: 'none' })
  })

  it('revalidates a promoted staged target before recovery commits the pointer', async () => {
    const { legacyRoot, dataRoot } = await fixture()
    const { installation, registry } = await control(dataRoot)
    const pointer = {
      read: vi.fn(async () => ({ kind: 'none' as const })),
      commitPointer: vi
        .fn()
        .mockRejectedValueOnce(new Error('crash before pointer commit'))
        .mockResolvedValue({ durability: { kind: 'durable' } })
    }
    const sqliteValidator = vi.fn(async () => undefined)
    const service = new LegacyProfileAdoption({ legacyRoot, dataRoot, installation, registry, pointer, sqliteValidator })

    await expect(service.adopt()).rejects.toThrow('crash before pointer commit')
    const journal = JSON.parse(await readFile(path.join(dataRoot, 'control', 'adoption-journal.json'), 'utf8')) as {
      targetRoot: string
    }
    await writeFile(path.join(journal.targetRoot, 'userData', 'Preferences'), 'tampered')

    await expect(service.adopt()).resolves.toMatchObject({ status: 'adopted' })
    expect(pointer.commitPointer).toHaveBeenCalledTimes(2)
    await expect(readFile(path.join(journal.targetRoot, 'userData', 'Preferences'), 'utf8')).resolves.toBe(
      'ordinary-settings'
    )
    expect(sqliteValidator).toHaveBeenCalledTimes(2)
  })

  it('recovers an interrupted staging journal and is idempotent after commit', async () => {
    const { legacyRoot, dataRoot } = await fixture()
    const { installation, registry, pointer } = await control(dataRoot)
    const operationId = randomUUID()
    const staleStaging = path.join(dataRoot, 'profiles', `.adopt-${operationId}.staging`)
    await mkdir(staleStaging, { recursive: true })
    await writeFile(path.join(staleStaging, 'partial'), 'partial')
    await writeFile(
      path.join(dataRoot, 'control', 'adoption-journal.json'),
      JSON.stringify({ version: 1, phase: 'copying', operationId, legacyRoot, stagingRoot: staleStaging })
    )
    const service = new LegacyProfileAdoption({
      legacyRoot,
      dataRoot,
      installation,
      registry,
      pointer,
      sqliteValidator: async () => undefined
    })

    const first = await service.adopt()
    await expect(access(staleStaging)).rejects.toMatchObject({ code: 'ENOENT' })
    const second = await service.adopt()
    expect(first.status).toBe('adopted')
    expect(second).toMatchObject({ status: 'already-adopted' })
  })
})
