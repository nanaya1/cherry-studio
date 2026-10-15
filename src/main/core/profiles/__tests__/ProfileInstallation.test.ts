import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { InstallationRecordV1Schema, ProfileControlStore, ProfileInstallation } from '..'

const temporaryDirectories: string[] = []

async function createInstallationPath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'profile-installation-'))
  temporaryDirectories.push(directory)
  return path.join(directory, 'installation.json')
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('ProfileInstallation', () => {
  it('returns the committed value with unknown durability when confirmation fails', async () => {
    const filePath = await createInstallationPath()
    const store = new ProfileControlStore(filePath, InstallationRecordV1Schema, async () => {
      throw new Error('directory sync failed')
    })

    const result = await new ProfileInstallation(store).getOrCreate()

    expect(result.value.deviceInstallId).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.durability).toEqual({
      kind: 'committed-durability-unknown',
      reason: 'error',
      error: 'directory sync failed'
    })
    await expect(readFile(filePath, 'utf8')).resolves.toContain(result.value.deviceInstallId)
  })

  it('creates a random UUID and persists it stably', async () => {
    const filePath = await createInstallationPath()
    const installation = new ProfileInstallation(filePath)

    const first = (await installation.getOrCreate()).value
    const second = (await installation.getOrCreate()).value
    const reloaded = (await new ProfileInstallation(filePath).getOrCreate()).value

    expect(first.deviceInstallId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(first.createdAt).toBe(new Date(first.createdAt).toISOString())
    expect(second).toEqual(first)
    expect(reloaded).toEqual(first)
  })

  it('merges concurrent initialization calls within one instance', async () => {
    const filePath = await createInstallationPath()
    const installation = new ProfileInstallation(filePath)

    const firstPromise = installation.getOrCreate()
    const secondPromise = installation.getOrCreate()

    expect(secondPromise).toBe(firstPromise)
    const [first, second] = await Promise.all([firstPromise, secondPromise])
    expect(second).toEqual(first)
  })

  it.each([
    ['same path', (directory: string) => path.join(directory, 'installation.json')],
    ['dot segment', (directory: string) => `${directory}/./installation.json`],
    ['symlink parent', (directory: string) => path.join(`${directory}-link`, 'installation.json')]
  ])('serializes concurrent initialization across instances using an equivalent %s', async (_case, equivalentPath) => {
    const filePath = await createInstallationPath()
    const directory = path.dirname(filePath)
    const linkPath = `${directory}-link`

    if (_case === 'symlink parent') {
      await symlink(directory, linkPath, 'dir')
    }
    let results: Awaited<ReturnType<ProfileInstallation['getOrCreate']>>[]
    try {
      results = await Promise.all([
        new ProfileInstallation(filePath).getOrCreate(),
        new ProfileInstallation(equivalentPath(directory)).getOrCreate()
      ])
    } finally {
      if (_case === 'symlink parent') {
        await unlink(linkPath)
      }
    }

    expect(results[1].value).toEqual(results[0].value)
    expect(results.filter((result) => result.durability.kind !== 'not-written')).toHaveLength(1)
    expect(results.filter((result) => result.durability.kind === 'not-written')).toHaveLength(1)
  })

  it.each([
    ['invalid JSON', '{not-json'],
    [
      'invalid UUID',
      JSON.stringify({ version: 1, deviceInstallId: 'not-a-uuid', createdAt: '2026-10-14T12:34:56.000Z' })
    ]
  ])('fails closed for %s and does not overwrite the file', async (_case, content) => {
    const filePath = await createInstallationPath()
    await writeFile(filePath, content, 'utf8')
    const installation = new ProfileInstallation(filePath)

    await expect(installation.getOrCreate()).rejects.toThrow(/corrupt/i)
    await expect(readFile(filePath, 'utf8')).resolves.toBe(content)
  })

  it('does not return a temporary record when persistence fails', async () => {
    const parentFile = await createInstallationPath()
    await writeFile(parentFile, 'not-a-directory', 'utf8')
    const filePath = path.join(parentFile, 'installation.json')
    const installation = new ProfileInstallation(filePath)

    await expect(installation.getOrCreate()).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it('persists only the version, random identifier, and creation time', async () => {
    const filePath = await createInstallationPath()
    const installation = new ProfileInstallation(filePath)

    await installation.getOrCreate()
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>

    expect(Object.keys(persisted).sort()).toEqual(['createdAt', 'deviceInstallId', 'version'])
    expect(JSON.stringify(persisted)).not.toMatch(/hostname|hostName|mac|username|userName/i)
  })
})
