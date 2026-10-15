import nodeFs from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { computeIdentityDigest, type ProfileLaunchContext } from '@main/core/profiles'

import { PROFILE_DATA_RESET_MARKER, runProfileDataResetPreboot, stageProfileDataReset } from '../profileDataReset'

const PROFILE_A = 'a'.repeat(32)
const PROFILE_B = 'b'.repeat(32)
const DIGEST_A = 'a'.repeat(64)
const DIGEST_B = 'b'.repeat(64)

let dataRoot: string

function context(): ProfileLaunchContext {
  return {
    mode: 'business',
    profileId: PROFILE_A,
    identityDigest: DIGEST_A,
    kind: 'authenticated',
    dataRoot,
    profileRoot: path.join(dataRoot, 'profiles', PROFILE_A)
  }
}

async function seedDataRoot(): Promise<void> {
  await fs.mkdir(path.join(dataRoot, 'control'), { recursive: true })
  await fs.mkdir(path.join(dataRoot, 'profiles', PROFILE_A), { recursive: true })
  await fs.mkdir(path.join(dataRoot, 'profiles', PROFILE_B), { recursive: true })
  await fs.mkdir(path.join(dataRoot, 'shared'), { recursive: true })
  await fs.writeFile(path.join(dataRoot, 'profiles', PROFILE_A, 'a.txt'), 'a')
  await fs.writeFile(path.join(dataRoot, 'profiles', PROFILE_B, 'b.txt'), 'b')
  await fs.writeFile(path.join(dataRoot, 'shared', 'shared.txt'), 'shared')
  await fs.writeFile(
    path.join(dataRoot, 'control', 'profiles.json'),
    JSON.stringify({
      version: 1,
      profiles: [
        {
          version: 1,
          profileId: 'signed-out',
          identityDigest: computeIdentityDigest({ kind: 'signed-out', bootstrapId: 'signed-out' }),
          kind: 'signed-out',
          state: 'ready',
          createdAt: '2026-01-01T00:00:00.000Z'
        },
        {
          version: 1,
          profileId: PROFILE_A,
          identityDigest: DIGEST_A,
          kind: 'authenticated',
          state: 'ready',
          createdAt: '2026-01-01T00:00:00.000Z'
        },
        {
          version: 1,
          profileId: PROFILE_B,
          identityDigest: DIGEST_B,
          kind: 'local',
          state: 'ready',
          createdAt: '2026-01-01T00:00:00.000Z'
        }
      ]
    })
  )
}

beforeEach(async () => {
  dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-data-reset-'))
  await seedDataRoot()
})

afterEach(async () => {
  await fs.rm(dataRoot, { recursive: true, force: true })
})

describe('profile data reset dedicated preboot', () => {
  it('refuses to stage another profile from a normal running launch', async () => {
    await expect(
      stageProfileDataReset({ scope: 'specified-profile', context: context(), profileId: PROFILE_B })
    ).rejects.toThrow('dedicated preboot')

    await expect(fs.stat(path.join(dataRoot, PROFILE_DATA_RESET_MARKER))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes a registry-verified specified profile only in dedicated preboot', async () => {
    await stageProfileDataReset({
      scope: 'specified-profile',
      context: context(),
      profileId: PROFILE_B,
      dedicatedPreboot: true
    })

    await expect(runProfileDataResetPreboot(dataRoot)).resolves.toBe('handled')
    await expect(fs.stat(path.join(dataRoot, 'profiles', PROFILE_B))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(path.join(dataRoot, 'profiles', PROFILE_A, 'a.txt'), 'utf8')).resolves.toBe('a')
    await expect(fs.stat(path.join(dataRoot, PROFILE_DATA_RESET_MARKER))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes control, all profiles, and shared for a device reset', async () => {
    await stageProfileDataReset({ scope: 'device', context: context() })
    const removalOrder: string[] = []
    const originalRmSync = nodeFs.rmSync
    const remove = ((target: nodeFs.PathLike, options: nodeFs.RmDirOptions) => {
      removalOrder.push(path.basename(String(target)))
      return originalRmSync(target, options)
    }) as typeof nodeFs.rmSync
    await expect(runProfileDataResetPreboot(dataRoot, remove)).resolves.toBe('handled')
    expect(removalOrder.slice(0, 3)).toEqual(['profiles', 'shared', 'control'])
    for (const entry of ['control', 'profiles', 'shared']) {
      await expect(fs.stat(path.join(dataRoot, entry))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('finishes a device reset after control and its registry were already deleted', async () => {
    await stageProfileDataReset({ scope: 'device', context: context() })
    const markerFile = path.join(dataRoot, PROFILE_DATA_RESET_MARKER)
    const marker = JSON.parse(await fs.readFile(markerFile, 'utf8'))
    marker.phase = 'deleting-control'
    await fs.writeFile(markerFile, JSON.stringify(marker))
    await fs.rm(path.join(dataRoot, 'profiles'), { recursive: true, force: true })
    await fs.rm(path.join(dataRoot, 'shared'), { recursive: true, force: true })
    await fs.rm(path.join(dataRoot, 'control'), { recursive: true, force: true })

    await expect(runProfileDataResetPreboot(dataRoot)).resolves.toBe('handled')
    await expect(fs.stat(markerFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not delete anything when marker authorization is tampered', async () => {
    await stageProfileDataReset({ scope: 'device', context: context() })
    const markerFile = path.join(dataRoot, PROFILE_DATA_RESET_MARKER)
    const marker = JSON.parse(await fs.readFile(markerFile, 'utf8'))
    marker.identityDigest = 'd'.repeat(64)
    await fs.writeFile(markerFile, JSON.stringify(marker))

    await expect(runProfileDataResetPreboot(dataRoot)).rejects.toThrow('identity')
    await expect(fs.readFile(path.join(dataRoot, 'profiles', PROFILE_A, 'a.txt'), 'utf8')).resolves.toBe('a')
    await expect(fs.readFile(path.join(dataRoot, 'shared', 'shared.txt'), 'utf8')).resolves.toBe('shared')
  })
})
