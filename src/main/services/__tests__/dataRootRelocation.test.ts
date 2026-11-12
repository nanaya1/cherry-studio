import fssync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { computeIdentityDigest } from '@main/core/profiles'

import {
  DATA_ROOT_RELOCATION_OWNER,
  executeDataRootRelocation,
  isVolumeRootOwnedSymlink,
  relocationPathAncestors
} from '../dataRootRelocation'

const TASK_ID = '11111111-1111-4111-8111-111111111111'
const PROFILE_A = 'a'.repeat(32)
const PROFILE_B = 'b'.repeat(32)
let root: string
let source: string
let target: string

async function seedSource(): Promise<void> {
  source = path.join(root, 'source')
  target = path.join(root, 'target')
  await fs.mkdir(path.join(source, 'control'), { recursive: true })
  await fs.mkdir(path.join(source, 'profiles', 'signed-out'), { recursive: true })
  await fs.mkdir(path.join(source, 'profiles', PROFILE_A), { recursive: true })
  await fs.mkdir(path.join(source, 'profiles', PROFILE_B), { recursive: true })
  await fs.mkdir(path.join(source, 'shared'), { recursive: true })
  await fs.writeFile(path.join(source, 'profiles', PROFILE_A, 'a.txt'), 'a')
  await fs.writeFile(path.join(source, 'profiles', PROFILE_B, 'b.txt'), 'b')
  await fs.writeFile(path.join(source, 'shared', 'shared.txt'), 'shared')
  await fs.writeFile(path.join(source, 'SingletonLock'), 'lock')
  await fs.writeFile(path.join(source, '.profile-data-reset.pending.json'), 'marker')
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
        ...[
          [PROFILE_A, 'a'.repeat(64), 'authenticated'],
          [PROFILE_B, 'b'.repeat(64), 'local']
        ].map(([profileId, identityDigest, kind]) => ({
          version: 1,
          profileId,
          identityDigest,
          kind,
          state: 'ready',
          createdAt: '2026-01-01T00:00:00.000Z'
        }))
      ]
    })
  )
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'data-root-relocation-'))
  await seedSource()
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('Windows relocation path contract', () => {
  // MEA:data-root-relocation-safety 使用真实 win32 解析，不 mock relative 的跨盘/UNC 结果。
  it.each([
    ['C:/sandbox/source', ['C:\\', 'C:\\sandbox', 'C:\\sandbox\\source']],
    ['D:/sandbox/target/', ['D:\\', 'D:\\sandbox', 'D:\\sandbox\\target']],
    ['D:\\sandbox/child\\..\\target', ['D:\\', 'D:\\sandbox', 'D:\\sandbox\\target']],
    ['C:/', ['C:\\']],
    ['D:\\', ['D:\\']],
    ['//server/share/', ['\\\\server\\share\\']],
    ['//server/share/dir/target', ['\\\\server\\share\\', '\\\\server\\share\\dir', '\\\\server\\share\\dir\\target']],
    ['//server/other/target', ['\\\\server\\other\\', '\\\\server\\other\\target']]
  ])('walks only the owning volume for %s', (input, expected) => {
    expect([...relocationPathAncestors(input, path.win32)]).toEqual(expected)
  })
})

describe('dataRoot relocation', () => {
  it('preserves a target populated during copying instead of merging or deleting it', async () => {
    const copy = fs.copyFile.bind(fs)
    const spy = vi.spyOn(fs, 'copyFile').mockImplementationOnce(async (...args) => {
      await fs.mkdir(target)
      await fs.writeFile(path.join(target, 'keep.txt'), 'concurrent')
      return copy(...args)
    })
    try {
      await expect(
        executeDataRootRelocation({ status: 'pending', taskId: TASK_ID, from: source, to: target }, vi.fn())
      ).rejects.toThrow('empty')
      await expect(fs.readFile(path.join(target, 'keep.txt'), 'utf8')).resolves.toBe('concurrent')
      await expect(fs.readFile(path.join(source, 'profiles', PROFILE_A, 'a.txt'), 'utf8')).resolves.toBe('a')
    } finally {
      spy.mockRestore()
    }
  })

  it('preserves concurrent data added after the last empty-directory check', async () => {
    await fs.mkdir(target)
    const rmdir = fs.rmdir.bind(fs)
    const spy = vi.spyOn(fs, 'rmdir').mockImplementationOnce(async (...args) => {
      await fs.writeFile(path.join(target, 'late.txt'), 'late')
      return rmdir(...args)
    })
    try {
      await expect(
        executeDataRootRelocation({ status: 'pending', taskId: TASK_ID, from: source, to: target }, vi.fn())
      ).rejects.toMatchObject({ code: 'ENOTEMPTY' })
      await expect(fs.readFile(path.join(target, 'late.txt'), 'utf8')).resolves.toBe('late')
    } finally {
      spy.mockRestore()
    }
  })

  it('rejects junction targets and nested ..archive paths without touching their data', async () => {
    const real = path.join(root, 'real')
    await fs.mkdir(real)
    await fs.symlink(real, target, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(
      executeDataRootRelocation({ status: 'pending', taskId: TASK_ID, from: source, to: target }, vi.fn())
    ).rejects.toThrow('symlink')
    await expect(
      executeDataRootRelocation(
        { status: 'pending', taskId: TASK_ID, from: source, to: path.join(source, '..archive') },
        vi.fn()
      )
    ).rejects.toThrow('contain')
    expect(await fs.readdir(real)).toEqual([])
  })

  it('moves control, all profiles, and shared while excluding singleton and temporary markers', async () => {
    const commit = vi.fn()
    await executeDataRootRelocation({ status: 'pending', taskId: TASK_ID, from: source, to: target }, commit)

    await expect(fs.readFile(path.join(target, 'profiles', PROFILE_A, 'a.txt'), 'utf8')).resolves.toBe('a')
    await expect(fs.readFile(path.join(target, 'profiles', PROFILE_B, 'b.txt'), 'utf8')).resolves.toBe('b')
    await expect(fs.readFile(path.join(target, 'shared', 'shared.txt'), 'utf8')).resolves.toBe('shared')
    await expect(fs.stat(path.join(target, 'SingletonLock'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(path.join(target, '.profile-data-reset.pending.json'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(commit).toHaveBeenCalledWith(target)
  })

  it('allows relocation before the optional shared directory is initialized', async () => {
    await fs.rm(path.join(source, 'shared'), { recursive: true })
    const commit = vi.fn()

    await executeDataRootRelocation({ status: 'pending', taskId: TASK_ID, from: source, to: target }, commit)

    expect(commit).toHaveBeenCalledWith(target)
    await expect(fs.stat(path.join(target, 'shared'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects shared when it exists as a symlink', async () => {
    await fs.rm(path.join(source, 'shared'), { recursive: true })
    await fs.symlink(path.join(source, 'profiles'), path.join(source, 'shared'), 'dir')

    await expect(
      executeDataRootRelocation({ status: 'pending', taskId: TASK_ID, from: source, to: target }, vi.fn())
    ).rejects.toThrow('symlink')
  })

  it('rejects source and target symlinks before copying', async () => {
    const linkedSource = path.join(root, 'linked-source')
    await fs.symlink(source, linkedSource, 'dir')
    await expect(
      executeDataRootRelocation({ status: 'pending', taskId: TASK_ID, from: linkedSource, to: target }, vi.fn())
    ).rejects.toThrow('symlink')

    const realTarget = path.join(root, 'real-target')
    await fs.mkdir(realTarget)
    await fs.symlink(realTarget, target, 'dir')
    await expect(
      executeDataRootRelocation({ status: 'pending', taskId: TASK_ID, from: source, to: target }, vi.fn())
    ).rejects.toThrow('symlink')
  })

  it('rejects a target whose intermediate ancestor is a symlink', async () => {
    const realParent = path.join(root, 'real-parent')
    const linkedParent = path.join(root, 'linked-parent')
    await fs.mkdir(path.join(realParent, 'nested'), { recursive: true })
    await fs.symlink(realParent, linkedParent, 'dir')

    await expect(
      executeDataRootRelocation(
        { status: 'pending', taskId: TASK_ID, from: source, to: path.join(linkedParent, 'nested', 'target') },
        vi.fn()
      )
    ).rejects.toThrow('symlink')
  })

  it('refuses source and target containment in either direction', async () => {
    await expect(
      executeDataRootRelocation(
        { status: 'pending', taskId: TASK_ID, from: source, to: path.join(source, 'nested') },
        vi.fn()
      )
    ).rejects.toThrow('contain')
  })

  it('validates every registry profile directory before commit', async () => {
    await fs.rm(path.join(source, 'profiles', PROFILE_B), { recursive: true })
    const commit = vi.fn()

    await expect(
      executeDataRootRelocation({ status: 'pending', taskId: TASK_ID, from: source, to: target }, commit)
    ).rejects.toThrow(PROFILE_B)
    expect(commit).not.toHaveBeenCalled()
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('recovers an owned promoted target after interruption before BootConfig commit', async () => {
    await fs.mkdir(target)
    await fs.writeFile(
      path.join(target, '.cherry-data-root-relocation-owner.json'),
      JSON.stringify({ kind: 'cherry-studio-data-root-relocation', taskId: TASK_ID })
    )
    await fs.writeFile(path.join(target, 'stale.txt'), 'stale')

    await executeDataRootRelocation({ status: 'pending', taskId: TASK_ID, from: source, to: target }, vi.fn())

    await expect(fs.stat(path.join(target, 'stale.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(path.join(target, 'profiles', PROFILE_A, 'a.txt'), 'utf8')).resolves.toBe('a')
  })

  it('keeps the promoted target after commit when cleanup fails', async () => {
    const commit = vi.fn()
    const cleanup = vi.fn(async () => {
      throw new Error('cleanup failed')
    })

    await expect(
      executeDataRootRelocation({ status: 'pending', taskId: TASK_ID, from: source, to: target }, commit, cleanup)
    ).rejects.toThrow('cleanup failed')

    expect(commit).toHaveBeenCalledWith(target)
    await expect(fs.readFile(path.join(target, 'profiles', PROFILE_A, 'a.txt'), 'utf8')).resolves.toBe('a')
  })

  it('recovers an owned partial work tree after interruption', async () => {
    const work = path.join(root, `.target.data-root-relocation-${TASK_ID}-work`)
    await fs.mkdir(work)
    await fs.writeFile(
      path.join(work, DATA_ROOT_RELOCATION_OWNER),
      // JSON.stringify({ kind: 'cherry-studio-data-root-relocation', taskId: TASK_ID })
      JSON.stringify({ kind: 'meacowork-data-root-relocation', taskId: TASK_ID })
    )
    await fs.writeFile(path.join(work, 'partial.txt'), 'partial')

    await executeDataRootRelocation({ status: 'pending', taskId: TASK_ID, from: source, to: target }, vi.fn())

    await expect(fs.stat(work)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(path.join(target, 'profiles', PROFILE_A, 'a.txt'), 'utf8')).resolves.toBe('a')
  })

  // MEA:data-root-relocation-safety 系统链接豁免仅限卷根一级 root 持有链接，非根位置与普通用户链接不得豁免。
  it('exempts only root-owned symlinks directly under a volume root', async () => {
    const nested = path.join(root, 'link')
    await fs.symlink(source, nested, 'dir')
    expect(isVolumeRootOwnedSymlink(nested)).toBe(false)
    expect(isVolumeRootOwnedSymlink(path.join(path.parse(os.tmpdir()).root, 'nonexistent-link'))).toBe(false)
    // 卷根本身在测试环境只读，无法创建真实链接；以现有系统链接（macOS /var 等）验证豁免判定。
    const existingRootLink = fssync
      .readdirSync(path.parse(os.tmpdir()).root)
      .map((entry) => path.join(path.parse(os.tmpdir()).root, entry))
      .find((entry) => {
        try {
          return fssync.lstatSync(entry).isSymbolicLink() && fssync.lstatSync(entry).uid === 0
        } catch {
          return false
        }
      })
    if (existingRootLink) {
      expect(isVolumeRootOwnedSymlink(existingRootLink)).toBe(true)
    }
  })
})
