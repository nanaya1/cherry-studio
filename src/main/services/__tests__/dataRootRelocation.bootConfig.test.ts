import { execFileSync } from 'node:child_process'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { computeIdentityDigest, type ProfileLaunchContext } from '@main/core/profiles'

const { getMock, persistMock, setMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  persistMock: vi.fn(),
  setMock: vi.fn()
}))

let state: Record<string, unknown>

// 仅使故障注入可替换属性；所有文件系统操作仍调用真实实现。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fsSync>()
  return { ...actual, default: { ...actual } }
})

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
  persistMock.mockReset()
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
  // MEA:data-root-relocation-safety 捕获真实跨卷 inspect 放行但 execute 拼出 C:\\D: 的缺陷。
  it.runIf(process.platform === 'win32').each([
    ['C-to-D', 'empty'],
    ['C-to-D', 'missing'],
    ['D-to-C', 'empty'],
    ['D-to-C', 'missing']
  ])('copies across volumes after inspect/request: %s %s', async (direction, kind) => {
    const projectTemp = await fs.mkdtemp(path.resolve('.tmp-tests', 'relocation-cross-volume-'))
    try {
      expect(path.parse(root).root.toLowerCase()).toBe('c:\\')
      expect(path.parse(projectTemp).root.toLowerCase()).toBe('d:\\')
      source = path.join(direction === 'C-to-D' ? root : projectTemp, 'cross-source')
      target = path.join(direction === 'C-to-D' ? projectTemp : root, 'cross-target')
      await seedSource()
      const file = path.join('profiles', PROFILE_ID, 'cross-volume.txt')
      await fs.writeFile(path.join(source, file), 'real cross-volume copy')
      if (kind === 'empty') await fs.mkdir(target)
      const { inspectDataRootRelocationTarget, requestDataRootRelocation, runDataRootRelocation } =
        await import('../dataRootRelocation')
      expect(inspectDataRootRelocationTarget(context(), target).valid).toBe(true)
      requestDataRootRelocation(context(), target)
      await expect(runDataRootRelocation(source)).resolves.toBe('handled')
      expect(state['temp.data_root_relocation']).toBeNull()
      expect(state['app.data_root_path']).toMatchObject({ '/mock/exe': target })
      await expect(fs.readFile(path.join(target, file), 'utf8')).resolves.toBe('real cross-volume copy')
      await expect(fs.readFile(path.join(source, file), 'utf8')).resolves.toBe('real cross-volume copy')
    } finally {
      await fs.rm(projectTemp, { recursive: true, force: true })
    }
  })
  it.runIf(process.platform === 'win32').each(['source', 'target', 'ancestor'])(
    'rejects cross-volume junction %s in inspection and execution',
    async (linked) => {
      const projectTemp = await fs.mkdtemp(path.resolve('.tmp-tests', 'relocation-linked-'))
      try {
        target = path.join(projectTemp, 'target')
        const real = path.join(projectTemp, 'real')
        await fs.mkdir(real)
        if (linked === 'source') {
          const alias = path.join(root, 'source-alias')
          await fs.symlink(source, alias, 'junction')
          source = alias
        } else if (linked === 'target') {
          await fs.symlink(real, target, 'junction')
        } else {
          const alias = path.join(projectTemp, 'alias')
          await fs.symlink(real, alias, 'junction')
          target = path.join(alias, 'missing-target')
        }
        const { inspectDataRootRelocationTarget, requestDataRootRelocation, executeDataRootRelocation } =
          await import('../dataRootRelocation')
        expect(inspectDataRootRelocationTarget(context(), target).valid).toBe(false)
        expect(() => requestDataRootRelocation(context(), target)).toThrow()
        await expect(
          executeDataRootRelocation(
            { status: 'pending', taskId: '11111111-1111-4111-8111-111111111111', from: source, to: target },
            () => {
              throw new Error('must not commit')
            }
          )
        ).rejects.toThrow('symlink')
        expect(await fs.readdir(real)).toEqual([])
        expect(state['temp.data_root_relocation']).toBeNull()
      } finally {
        await fs.rm(projectTemp, { recursive: true, force: true })
      }
    }
  )

  it.runIf(process.platform === 'win32')(
    'recovers a cross-volume commit failure and replaces failed only on a new request',
    async () => {
      const projectTemp = await fs.mkdtemp(path.resolve('.tmp-tests', 'relocation-recovery-'))
      try {
        target = path.join(projectTemp, 'target')
        const { requestDataRootRelocation, runDataRootRelocation } = await import('../dataRootRelocation')
        requestDataRootRelocation(context(), target)
        persistMock.mockImplementationOnce(() => {
          throw new Error('cross-volume commit failed')
        })
        await expect(runDataRootRelocation(source)).resolves.toBe('skipped')
        expect(state['temp.data_root_relocation']).toMatchObject({
          status: 'failed',
          error: 'cross-volume commit failed'
        })
        expect(state['app.data_root_path']).toEqual({ '/other/exe': '/other/root' })
        await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(fs.readFile(path.join(source, 'control', 'profiles.json'), 'utf8')).resolves.toContain(PROFILE_ID)
        await expect(runDataRootRelocation(source)).resolves.toBe('skipped')
        requestDataRootRelocation(context(), target)
        await expect(runDataRootRelocation(source)).resolves.toBe('handled')
        expect(state['temp.data_root_relocation']).toBeNull()
      } finally {
        await fs.rm(projectTemp, { recursive: true, force: true })
      }
    }
  )

  // 捕获空目标拒绝、Windows fsync、pending 重放与提交后仍使用旧目录的回归。
  it.each(['empty', 'missing'])('relocates an inspected %s target and starts from the committed root', async (kind) => {
    if (kind === 'empty') await fs.mkdir(target)
    const profileFile = path.join('profiles', PROFILE_ID, 'contract.txt')
    await fs.writeFile(path.join(source, profileFile), 'preserved')
    const { inspectDataRootRelocationTarget, requestDataRootRelocation, runDataRootRelocation } =
      await import('../dataRootRelocation')
    expect(inspectDataRootRelocationTarget(context(), target)).toEqual({
      valid: true,
      targetEmpty: true,
      copyRequired: true,
      sourcePath: source
    })
    requestDataRootRelocation(context(), target)
    await expect(runDataRootRelocation(source)).resolves.toBe('handled')
    await expect(runDataRootRelocation(target)).resolves.toBe('skipped')
    const { resolveProfileDataRoot, applyProfileIsolationPaths } =
      await import('@main/core/preboot/profileIsolationPreboot')
    const resolved = resolveProfileDataRoot(
      '/legacy',
      '/mock/exe',
      state['app.data_root_path'] as Record<string, string>
    )
    expect(resolved).toBe(target)
    const setPath = vi.fn()
    applyProfileIsolationPaths(
      { ...context(), dataRoot: resolved, profileRoot: path.join(resolved, 'profiles', PROFILE_ID) },
      {
        setPath,
        setAppLogsPath: vi.fn(),
        mkdirSync: vi.fn(),
        acquireDataRootLock: vi.fn(),
        requestSingleInstanceLock: vi.fn(),
        freezePathRegistry: vi.fn()
      }
    )
    expect(setPath).toHaveBeenCalledWith('userData', path.join(target, 'profiles', PROFILE_ID, 'userData'))
    await fs.writeFile(path.join(resolved, 'profiles', PROFILE_ID, 'after-start.txt'), 'new write')
    await expect(fs.readFile(path.join(target, profileFile), 'utf8')).resolves.toBe('preserved')
    await expect(fs.readFile(path.join(source, profileFile), 'utf8')).resolves.toBe('preserved')
    await expect(fs.stat(path.join(source, 'profiles', PROFILE_ID, 'after-start.txt'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(state['temp.data_root_relocation']).toBeNull()
  })

  it('propagates ancestor permission errors in inspection/request and execution', async () => {
    const denied = Object.assign(new Error('ancestor access denied'), { code: 'EACCES' })
    const { inspectDataRootRelocationTarget, requestDataRootRelocation, executeDataRootRelocation } =
      await import('../dataRootRelocation')
    const lstatSync = fsSync.lstatSync.bind(fsSync)
    const syncSpy = vi.spyOn(fsSync, 'lstatSync').mockImplementation((...args) => {
      if (args[0] === path.parse(source).root) throw denied
      return lstatSync(...args)
    })
    try {
      expect(() => inspectDataRootRelocationTarget(context(), target)).toThrow(denied)
      expect(() => requestDataRootRelocation(context(), target)).toThrow(denied)
      expect(state['temp.data_root_relocation']).toBeNull()
    } finally {
      syncSpy.mockRestore()
    }
    const lstat = fs.lstat.bind(fs)
    const asyncSpy = vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      if (args[0] === path.parse(source).root) throw denied
      return lstat(...args)
    })
    try {
      await expect(
        executeDataRootRelocation(
          { status: 'pending', taskId: '11111111-1111-4111-8111-111111111111', from: source, to: target },
          () => {
            throw new Error('must not commit')
          }
        )
      ).rejects.toBe(denied)
      await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      asyncSpy.mockRestore()
    }
  })

  it('preserves request state when persistence fails and refuses replacing an outstanding task', async () => {
    const { requestDataRootRelocation } = await import('../dataRootRelocation')
    persistMock.mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    expect(() => requestDataRootRelocation(context(), target)).toThrow('disk full')
    expect(state['temp.data_root_relocation']).toBeNull()
    requestDataRootRelocation(context(), target)
    const pending = state['temp.data_root_relocation']
    expect(() => requestDataRootRelocation(context(), path.join(root, 'other'))).toThrow('already pending')
    expect(state['temp.data_root_relocation']).toBe(pending)
  })

  it('persists failure without overwriting an occupied target and never replays it', async () => {
    const { requestDataRootRelocation, runDataRootRelocation } = await import('../dataRootRelocation')
    requestDataRootRelocation(context(), target)
    await fs.mkdir(target)
    await fs.writeFile(path.join(target, 'keep.txt'), 'keep')
    await expect(runDataRootRelocation(source)).resolves.toBe('skipped')
    expect(state['temp.data_root_relocation']).toMatchObject({ status: 'failed', from: source, to: target })
    await expect(runDataRootRelocation(source)).resolves.toBe('skipped')
    await expect(fs.readFile(path.join(target, 'keep.txt'), 'utf8')).resolves.toBe('keep')
  })

  it('uses identical inspection and request rules for unsafe targets', async () => {
    const { inspectDataRootRelocationTarget, requestDataRootRelocation } = await import('../dataRootRelocation')
    for (const invalid of ['relative', source, path.join(source, '..archive'), root]) {
      expect(inspectDataRootRelocationTarget(context(), invalid).valid).toBe(false)
      expect(() => requestDataRootRelocation(context(), invalid)).toThrow()
      expect(state['temp.data_root_relocation']).toBeNull()
    }
    await fs.mkdir(target)
    await fs.writeFile(path.join(target, 'keep'), 'keep')
    expect(inspectDataRootRelocationTarget(context(), target)).toEqual({ valid: false, reason: 'target_not_empty' })
    expect(() => requestDataRootRelocation(context(), target)).toThrow()
  })

  it('does not create a fresh source profile when failed relocation points at a missing source', async () => {
    const { requestDataRootRelocation, runDataRootRelocation } = await import('../dataRootRelocation')
    requestDataRootRelocation(context(), target)
    await fs.mkdir(target)
    await fs.writeFile(path.join(target, 'keep'), 'keep')
    await expect(runDataRootRelocation(source)).resolves.toBe('skipped')
    await fs.rename(source, path.join(root, 'preserved-source'))
    await expect(runDataRootRelocation(source)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(source)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses executing against a different locked root', async () => {
    const { requestDataRootRelocation, runDataRootRelocation } = await import('../dataRootRelocation')
    requestDataRootRelocation(context(), target)
    await expect(runDataRootRelocation(path.join(root, 'other'))).rejects.toThrow('locked')
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the new mapping and cleanup-pending if clearing the committed state fails', async () => {
    const { requestDataRootRelocation, runDataRootRelocation } = await import('../dataRootRelocation')
    requestDataRootRelocation(context(), target)
    persistMock
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('clear failed')
      })
    await expect(runDataRootRelocation(source)).rejects.toThrow('clear failed')
    expect(state['app.data_root_path']).toMatchObject({ '/mock/exe': target })
    expect(state['temp.data_root_relocation']).toMatchObject({ status: 'cleanup-pending' })
    await expect(runDataRootRelocation(target)).resolves.toBe('handled')
    expect(state['temp.data_root_relocation']).toBeNull()
  })

  it('persists the request and commit through the real isolated BootConfig file', async () => {
    const configPath = path.join(root, 'boot-config.json')
    vi.doMock('@main/core/paths/constants', () => ({ BOOT_CONFIG_PATH: configPath }))
    const { BootConfigService } = await import('@main/data/bootConfig/BootConfigService')
    const config = new BootConfigService()
    getMock.mockImplementation((key) => config.get(key))
    setMock.mockImplementation((key, value) => config.set(key, value))
    persistMock.mockImplementation(() => config.persist())
    try {
      const { requestDataRootRelocation, runDataRootRelocation } = await import('../dataRootRelocation')
      requestDataRootRelocation(context(), target)
      expect(JSON.parse(await fs.readFile(configPath, 'utf8'))['temp.data_root_relocation']).toMatchObject({
        status: 'pending',
        from: source,
        to: target
      })
      await expect(runDataRootRelocation(source)).resolves.toBe('handled')
      const reloaded = new BootConfigService()
      expect(reloaded.get('app.data_root_path')['/mock/exe']).toBe(target)
      expect(reloaded.get('temp.data_root_relocation')).toBeNull()
      const moduleUrl = pathToFileURL(path.resolve('src/main/data/bootConfig/BootConfigService.ts')).href
      const schemaUrl = pathToFileURL(path.resolve('src/shared/data/bootConfig/bootConfigSchemas.ts')).href
      const resolverUrl = pathToFileURL(path.resolve('src/main/core/preboot/profileIsolationPreboot.ts')).href
      const output = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import { registerHooks } from 'node:module';
        registerHooks({ resolve(specifier, context, next) {
          if (specifier === '@logger') return { url: 'data:text/javascript,export const loggerService={withContext:()=>({info(){},warn(){},error(){}})}', shortCircuit:true };
          if (specifier === '@main/core/paths/constants') return { url: 'data:text/javascript,' + encodeURIComponent('export const BOOT_CONFIG_PATH=' + JSON.stringify(${JSON.stringify(configPath)})), shortCircuit:true };
          if (specifier === '@shared/data/bootConfig/bootConfigSchemas') return { url:${JSON.stringify(schemaUrl)}, shortCircuit:true };
          return next(specifier, context);
        }});
        const { BootConfigService } = await import(${JSON.stringify(moduleUrl)});
        const { resolveProfileDataRoot } = await import(${JSON.stringify(resolverUrl)});
        const config = new BootConfigService();
        process.stdout.write(JSON.stringify({root:resolveProfileDataRoot('/legacy','/mock/exe',config.get('app.data_root_path')),pending:config.get('temp.data_root_relocation')}));
      `
        ],
        { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
      )
      expect(JSON.parse(output)).toEqual({ root: target, pending: null })
    } finally {
      config.persist()
      vi.doUnmock('@main/core/paths/constants')
    }
  })

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

    // await expect(runDataRootRelocation()).rejects.toThrow('disk full')
    await expect(runDataRootRelocation(source)).resolves.toBe('skipped')

    expect(state['app.data_root_path']).toEqual({ '/other/exe': '/other/root' })
    // expect(state['temp.data_root_relocation']).toEqual(pending)
    expect(state['temp.data_root_relocation']).toMatchObject({
      ...(pending as object),
      status: 'failed',
      error: 'disk full'
    })
    await expect(runDataRootRelocation(source)).resolves.toBe('skipped')
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
