import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { computeIdentityDigest, type ProfileLaunchContext } from '@main/core/profiles'

const { getMock, persistMock, setMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  persistMock: vi.fn(),
  setMock: vi.fn()
}))

let state: Record<string, unknown>

vi.mock('@main/data/bootConfig', () => ({
  bootConfigService: {
    get: getMock,
    set: setMock,
    persist: persistMock
  }
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: (key: string) => (key === 'exe' ? '/mock/exe' : '/mock/unknown'),
    setAppLogsPath: vi.fn()
  }
}))

const PROFILE_ID = 'a'.repeat(32)
const DIGEST = 'a'.repeat(64)
let root: string
let source: string
let target: string

function context(): ProfileLaunchContext {
  return {
    mode: 'business',
    profileId: PROFILE_ID,
    identityDigest: DIGEST,
    kind: 'authenticated',
    dataRoot: source,
    profileRoot: path.join(source, 'profiles', PROFILE_ID)
  }
}

async function seedSource(): Promise<void> {
  await fs.mkdir(path.join(source, 'control'), { recursive: true })
  await fs.mkdir(path.join(source, 'profiles', 'signed-out'), { recursive: true })
  await fs.mkdir(path.join(source, 'profiles', PROFILE_ID), { recursive: true })
  await fs.mkdir(path.join(source, 'shared'), { recursive: true })
  await fs.writeFile(
    path.join(source, 'control', 'profiles.json'),
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
          profileId: PROFILE_ID,
          identityDigest: DIGEST,
          kind: 'authenticated',
          state: 'ready',
          createdAt: '2026-01-01T00:00:00.000Z'
        }
      ]
    })
  )
}

beforeEach(async () => {
  vi.clearAllMocks()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'data-root-boot-config-'))
  source = path.join(root, 'source')
  target = path.join(root, 'target')
  await seedSource()
  state = {
    'app.data_root_path': { '/other/exe': '/other/root' },
    'app.user_data_path': { '/mock/exe': '/legacy/user-data' },
    'temp.data_root_relocation': null
  }
  getMock.mockImplementation((key: string) => state[key])
  setMock.mockImplementation((key: string, value: unknown) => {
    state[key] = value
  })
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('dataRoot relocation BootConfig transaction', () => {
  it('stages the verified current dataRoot and target', async () => {
    const { requestDataRootRelocation } = await import('../dataRootRelocation')
    requestDataRootRelocation(context(), target)

    expect(state['temp.data_root_relocation']).toMatchObject({ status: 'pending', from: source, to: target })
    expect(persistMock).toHaveBeenCalledTimes(1)
  })

  it('commits only app.data_root_path and clears pending state', async () => {
    const { requestDataRootRelocation, runDataRootRelocation } = await import('../dataRootRelocation')
    requestDataRootRelocation(context(), target)
    persistMock.mockClear()

    await expect(runDataRootRelocation()).resolves.toBe('handled')

    expect(state['app.data_root_path']).toEqual({ '/other/exe': '/other/root', '/mock/exe': target })
    expect(state['app.user_data_path']).toEqual({ '/mock/exe': '/legacy/user-data' })
    expect(state['temp.data_root_relocation']).toBeNull()
    expect(persistMock).toHaveBeenCalledTimes(2)
  })

  it('resumes cleanup-pending without deleting or recopying the committed target', async () => {
    await fs.mkdir(target)
    await fs.writeFile(path.join(target, 'committed.txt'), 'committed')
    state['app.data_root_path'] = { '/mock/exe': target }
    state['temp.data_root_relocation'] = {
      status: 'cleanup-pending',
      taskId: '11111111-1111-4111-8111-111111111111',
      from: source,
      to: target
    }

    const { runDataRootRelocation } = await import('../dataRootRelocation')
    await expect(runDataRootRelocation()).resolves.toBe('handled')

    await expect(fs.readFile(path.join(target, 'committed.txt'), 'utf8')).resolves.toBe('committed')
    expect(state['temp.data_root_relocation']).toBeNull()
    expect(persistMock).toHaveBeenCalledTimes(1)
  })

  it('restores BootConfig state and removes the owned target when commit persistence fails', async () => {
    const { requestDataRootRelocation, runDataRootRelocation } = await import('../dataRootRelocation')
    requestDataRootRelocation(context(), target)
    const pending = state['temp.data_root_relocation']
    persistMock.mockClear().mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    await expect(runDataRootRelocation()).rejects.toThrow('disk full')

    expect(state['app.data_root_path']).toEqual({ '/other/exe': '/other/root' })
    expect(state['temp.data_root_relocation']).toEqual(pending)
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
