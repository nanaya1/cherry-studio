import { lstat, mkdir, mkdtemp, rm, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createProfilePaths, resolveProfileRoot, validateExistingProfilePath } from '..'

const PROFILE_ID = '0123456789abcdef0123456789abcdef'
const temporaryDirectories: string[] = []

async function createDataRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'profile-paths-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('ProfilePaths', () => {
  it('derives control and profiles as direct children of an absolute POSIX dataRoot', () => {
    const paths = createProfilePaths('/var/lib/cherry-studio')

    expect(paths).toEqual({
      dataRoot: '/var/lib/cherry-studio',
      controlRoot: '/var/lib/cherry-studio/control',
      profilesRoot: '/var/lib/cherry-studio/profiles'
    })
  })

  it('derives direct children using Windows semantics for a Windows absolute dataRoot', () => {
    const paths = createProfilePaths('C:\\Users\\tester\\CherryStudio')

    expect(paths).toEqual({
      dataRoot: 'C:\\Users\\tester\\CherryStudio',
      controlRoot: 'C:\\Users\\tester\\CherryStudio\\control',
      profilesRoot: 'C:\\Users\\tester\\CherryStudio\\profiles'
    })
  })

  it.each(['relative/data', '.', '/', 'C:\\', '\\\\server\\share\\'])('rejects invalid dataRoot %j', (dataRoot) => {
    expect(() => createProfilePaths(dataRoot)).toThrow(/dataRoot/i)
  })

  it('maps signed-out and lowercase hash identifiers below profiles', () => {
    const paths = createProfilePaths('/var/lib/cherry-studio')

    expect(resolveProfileRoot(paths, 'signed-out')).toBe('/var/lib/cherry-studio/profiles/signed-out')
    expect(resolveProfileRoot(paths, PROFILE_ID)).toBe(`/var/lib/cherry-studio/profiles/${PROFILE_ID}`)
  })

  it.each([
    '',
    'SIGNED-OUT',
    'ABCDEF0123456789abcdef0123456789',
    'abcdef',
    '../signed-out',
    '..',
    '/signed-out',
    '\\signed-out',
    'C:signed-out',
    'C:\\signed-out',
    'signed/out',
    'signed\\out',
    `${PROFILE_ID}.`,
    `${PROFILE_ID}\n`
  ])('rejects unsafe profile identifier %j', (profileId) => {
    const paths = createProfilePaths('/var/lib/cherry-studio')

    expect(() => resolveProfileRoot(paths, profileId)).toThrow(/profileId/i)
  })

  it('performs string-only resolution without creating directories', async () => {
    const dataRoot = path.join(tmpdir(), `profile-paths-missing-${crypto.randomUUID()}`)
    const paths = createProfilePaths(dataRoot)

    resolveProfileRoot(paths, PROFILE_ID)

    await expect(lstat(dataRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['dataRoot', 'controlRoot', 'profilesRoot'] as const)(
    'rejects the %s itself as a profile root',
    async (key) => {
      const dataRoot = await createDataRoot()
      const paths = createProfilePaths(dataRoot)
      await mkdir(paths.profilesRoot)

      await expect(validateExistingProfilePath(paths, paths[key])).rejects.toThrow(/profile root/i)
    }
  )

  it.each([true, false])(
    'accepts a missing target after checking its nearest existing ancestor (profilesRoot exists: %s)',
    async (createProfilesRoot) => {
      const dataRoot = await createDataRoot()
      const paths = createProfilePaths(dataRoot)
      if (createProfilesRoot) {
        await mkdir(paths.profilesRoot)
      }
      const profileRoot = resolveProfileRoot(paths, PROFILE_ID)

      await expect(validateExistingProfilePath(paths, profileRoot)).resolves.toBeUndefined()
      await expect(lstat(profileRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it('rejects a missing target when its nearest existing ancestor is a symlink', async () => {
    const dataRoot = await createDataRoot()
    const outside = await createDataRoot()
    const paths = createProfilePaths(dataRoot)
    await symlink(outside, paths.profilesRoot)
    const profileRoot = resolveProfileRoot(paths, PROFILE_ID)

    await expect(validateExistingProfilePath(paths, profileRoot)).rejects.toThrow(/symbolic link/i)
    await unlink(paths.profilesRoot)
  })

  it('rejects an existing profile target that is a symlink', async () => {
    const dataRoot = await createDataRoot()
    const outside = await createDataRoot()
    const paths = createProfilePaths(dataRoot)
    await mkdir(paths.profilesRoot)
    const profileRoot = resolveProfileRoot(paths, PROFILE_ID)
    await symlink(outside, profileRoot)

    await expect(validateExistingProfilePath(paths, profileRoot)).rejects.toThrow(/symbolic link/i)
    await unlink(profileRoot)
  })

  it('rejects a path whose canonical existing ancestor escapes canonical profilesRoot', async () => {
    const dataRoot = await createDataRoot()
    const outside = await createDataRoot()
    const paths = createProfilePaths(dataRoot)
    await mkdir(paths.profilesRoot)
    const escapedRoot = path.join(outside, PROFILE_ID)

    await expect(validateExistingProfilePath(paths, escapedRoot)).rejects.toThrow(/profiles root/i)
  })

  it('does not treat ENOENT as safe when no controlled ancestor can be canonicalized', async () => {
    const dataRoot = path.join(tmpdir(), `profile-paths-never-created-${crypto.randomUUID()}`)
    const paths = createProfilePaths(dataRoot)
    const profileRoot = resolveProfileRoot(paths, PROFILE_ID)

    await expect(validateExistingProfilePath(paths, profileRoot)).rejects.toThrow(/dataRoot|canonical/i)
  })
})
