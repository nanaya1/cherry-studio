import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { v4 as uuidv4 } from 'uuid'
import * as z from 'zod'

import { loggerService } from '@logger'
import { getNormalizedExecutablePath } from '@main/core/preboot/userDataLocation'
import { ProfileRegistry, createProfilePaths, resolveProfileRoot, type ProfileLaunchContext } from '@main/core/profiles'
import { bootConfigService } from '@main/data/bootConfig'
import type { UserDataRelocationInspection } from '@shared/types/userDataRelocation'

import { assertRelocationPaths, RelocationValidationError } from './userDataRelocation'

// export const DATA_ROOT_RELOCATION_OWNER = '.cherry-data-root-relocation-owner.json'
export const DATA_ROOT_RELOCATION_OWNER = '.meacowork-data-root-relocation-owner.json'
const LEGACY_DATA_ROOT_RELOCATION_OWNER = '.cherry-data-root-relocation-owner.json'
const PAYLOAD = 'payload'
const EXCLUDED_ROOT_ENTRIES = new Set([
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie',
  '.profile-data-reset.pending.json',
  DATA_ROOT_RELOCATION_OWNER,
  LEGACY_DATA_ROOT_RELOCATION_OWNER
])

const relocationFields = {
  taskId: z.uuid(),
  from: z.string().min(1),
  to: z.string().min(1)
}
const pendingSchema = z.strictObject({ status: z.literal('pending'), ...relocationFields })
const cleanupPendingSchema = z.strictObject({ status: z.literal('cleanup-pending'), ...relocationFields })
export type PendingDataRootRelocation = z.infer<typeof pendingSchema>
type CleanupPendingDataRootRelocation = z.infer<typeof cleanupPendingSchema>

// const ownerSchema = z.strictObject({ kind: z.literal('cherry-studio-data-root-relocation'), taskId: z.uuid() })
const ownerSchema = z.strictObject({
  kind: z.literal('meacowork-data-root-relocation'),
  taskId: z.uuid()
})
const legacyOwnerSchema = z.strictObject({
  kind: z.literal('cherry-studio-data-root-relocation'),
  taskId: z.uuid()
})

const logger = loggerService.withContext('DataRootRelocation')

// MEA:data-root-relocation-safety inspect 与 request 必须校验同一个可信 dataRoot。
export function inspectDataRootRelocationTarget(
  context: ProfileLaunchContext,
  targetPath: string
): UserDataRelocationInspection {
  if (context.mode !== 'business' || context.kind === 'signed-out') {
    return { valid: false, reason: 'source_missing' }
  }
  const existing = bootConfigService.get('temp.data_root_relocation')
  if (existing && existing.status !== 'failed') return { valid: false, reason: 'target_work_conflict' }
  try {
    const { targetEmpty } = assertRelocationPaths(context.dataRoot, targetPath)
    // const validationRoot = commonAncestor(context.dataRoot, targetPath)
    // assertPathHasNoSymlinkSync(context.dataRoot, validationRoot)
    // assertPathHasNoSymlinkSync(targetPath, validationRoot)
    // MEA:data-root-relocation-safety 两端分别从所属卷根检查，不以跨卷共同祖先拼接路径。
    assertPathHasNoSymlinkSync(context.dataRoot)
    assertPathHasNoSymlinkSync(targetPath)
    return targetEmpty
      ? { valid: true, targetEmpty: true, copyRequired: true, sourcePath: context.dataRoot }
      : { valid: false, reason: 'target_not_empty' }
  } catch (error) {
    if (error instanceof RelocationValidationError) return { valid: false, reason: error.reason }
    throw error
  }
}

// MEA:data-root-relocation-safety 同步预检与异步执行共用卷根遍历，包含根本身及 UNC share 根。
export function* relocationPathAncestors(target: string, paths: typeof path = path): Generator<string> {
  const resolved = paths.resolve(target)
  let current = paths.parse(resolved).root
  yield current
  for (const segment of paths.relative(current, resolved).split(paths.sep).filter(Boolean)) {
    current = paths.join(current, segment)
    yield current
  }
}

// function assertPathHasNoSymlinkSync(target: string, validationRoot: string): void {
function assertPathHasNoSymlinkSync(target: string): void {
  // let current = path.resolve(validationRoot)
  // for (const segment of path.relative(current, path.resolve(target)).split(path.sep).filter(Boolean)) {
  //   current = path.join(current, segment)
  for (const current of relocationPathAncestors(target)) {
    try {
      // if (fs.lstatSync(current).isSymbolicLink()) {
      //   throw new RelocationValidationError('target_protected', 'dataRoot relocation refuses linked paths')
      // }
      // MEA:data-root-relocation-safety 放行卷根一级 root 持有的系统链接（macOS /var、/tmp），其余链接仍拒绝。
      if (fs.lstatSync(current).isSymbolicLink() && !isVolumeRootOwnedSymlink(current)) {
        throw new RelocationValidationError('target_protected', 'dataRoot relocation refuses linked paths')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

// MEA:data-root-relocation-safety 仅 macOS/Linux 根目录下 root 持有的系统符号链接视为同一物理位置；用户无法在卷根建链接。
export function isVolumeRootOwnedSymlink(current: string): boolean {
  if (process.platform === 'win32') return false
  if (path.dirname(current) !== path.parse(current).root) return false
  try {
    return fs.lstatSync(current).uid === 0
  } catch {
    return false
  }
}

export function requestDataRootRelocation(context: ProfileLaunchContext, targetPath: string): void {
  if (context.mode !== 'business' || context.kind === 'signed-out') {
    // throw new Error('dataRoot relocation requires an active business profile')
    throw new RelocationValidationError('source_missing', 'dataRoot relocation requires an active business profile')
  }
  const existing = bootConfigService.get('temp.data_root_relocation')
  if (existing && existing.status !== 'failed') {
    throw new RelocationValidationError('target_work_conflict', 'A dataRoot relocation is already pending')
  }
  const inspection = inspectDataRootRelocationTarget(context, targetPath)
  if (!inspection.valid) throw new RelocationValidationError(inspection.reason, 'Invalid dataRoot relocation target')
  const pending: PendingDataRootRelocation = pendingSchema.parse({
    status: 'pending',
    taskId: uuidv4(),
    from: path.resolve(context.dataRoot),
    to: path.resolve(targetPath)
  })
  assertSeparated(pending.from, pending.to)

  const previous = bootConfigService.get('temp.data_root_relocation')
  bootConfigService.set('temp.data_root_relocation', pending)
  try {
    bootConfigService.persist()
  } catch (error) {
    bootConfigService.set('temp.data_root_relocation', previous)
    throw error
  }
}

export async function runDataRootRelocation(lockedDataRoot?: string): Promise<'skipped' | 'handled'> {
  const relocation = bootConfigService.get('temp.data_root_relocation')
  if (!relocation) return 'skipped'
  if (relocation.status === 'cleanup-pending') {
    await finishCommittedRelocationCleanup(cleanupPendingSchema.parse(relocation))
    return 'handled'
  }
  // if (relocation.status !== 'pending') return 'skipped'
  if (relocation.status === 'failed') {
    await assertSourceAvailable(relocation.from, lockedDataRoot)
    return 'skipped'
  }
  // await executeDataRootRelocation(relocation, commitDataRootRelocation)
  // clearCommittedRelocation()
  // MEA:data-root-relocation-safety 失败停止重放，仅在原锁定根仍可读写时交回正常启动恢复。
  if (lockedDataRoot && path.resolve(lockedDataRoot) !== path.resolve(relocation.from)) {
    throw new Error('Relocation source differs from the locked dataRoot')
  }
  try {
    await executeDataRootRelocation(relocation, commitDataRootRelocation)
    clearCommittedRelocation()
    return 'handled'
  } catch (error) {
    if (bootConfigService.get('temp.data_root_relocation')?.status === 'cleanup-pending') throw error
    bootConfigService.set('temp.data_root_relocation', {
      ...relocation,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      failedAt: new Date().toISOString()
    })
    bootConfigService.persist()
    await assertSourceAvailable(relocation.from, lockedDataRoot)
    logger.error('DataRoot relocation failed; continuing normal source startup recovery', error as Error)
    return 'skipped'
  }
}

async function assertSourceAvailable(source: string, lockedDataRoot?: string): Promise<void> {
  if (lockedDataRoot && path.resolve(lockedDataRoot) !== path.resolve(source)) {
    throw new Error('Relocation source differs from the locked dataRoot')
  }
  // await assertNotSymlink(source, 'recovery source', path.parse(source).root)
  await assertNotSymlink(source, 'recovery source')
  await fsp.access(source, fs.constants.R_OK | fs.constants.W_OK)
  const profiles = await fsp.lstat(path.join(source, 'profiles'))
  const registry = await fsp.lstat(path.join(source, 'control', 'profiles.json'))
  if (!profiles.isDirectory() || profiles.isSymbolicLink() || !registry.isFile() || registry.isSymbolicLink()) {
    throw new Error('Relocation source structure is unavailable')
  }
}

export async function executeDataRootRelocation(
  input: PendingDataRootRelocation,
  commit: (target: string) => void,
  cleanup: (target: string, work: string) => Promise<void> = (target, work) =>
    cleanupRelocationArtifacts(target, work, input.taskId)
): Promise<void> {
  const pending = pendingSchema.parse(input)
  const source = path.resolve(pending.from)
  const target = path.resolve(pending.to)
  assertSeparated(source, target)
  // const pathValidationRoot = commonAncestor(source, target)
  // await assertNotSymlink(source, 'source', pathValidationRoot)
  await assertNotSymlink(source, 'source')

  const { work, payload } = artifactPaths(target, pending.taskId)
  // await assertPathHasNoSymlink(await nearestExistingAncestor(path.dirname(target)), 'target ancestor', pathValidationRoot)
  await assertPathHasNoSymlink(await nearestExistingAncestor(path.dirname(target)), 'target ancestor')
  await recoverOwnedPath(work, pending.taskId)
  await recoverOwnedPath(target, pending.taskId)
  /* await assertTargetIsSafe(target, pathValidationRoot) */
  await assertTargetIsSafe(target)

  let promoted = false
  let committed = false
  try {
    await fsp.mkdir(work, { recursive: false, mode: 0o700 })
    await fsp.writeFile(
      path.join(work, DATA_ROOT_RELOCATION_OWNER),
      // JSON.stringify({ kind: 'cherry-studio-data-root-relocation', taskId: pending.taskId }),
      JSON.stringify({ kind: 'meacowork-data-root-relocation', taskId: pending.taskId }),
      { flag: 'wx', mode: 0o600 }
    )
    await copyDataRoot(source, payload)
    await validateCopiedDataRoot(payload)
    // await renameDurable(payload, target)
    // promoted = true
    // await copyFileDurable(path.join(work, DATA_ROOT_RELOCATION_OWNER), path.join(target, DATA_ROOT_RELOCATION_OWNER))
    // MEA:data-root-relocation-safety 提升前携带归属标记，空目录仅非递归移除并复检竞态。
    await copyFileDurable(path.join(work, DATA_ROOT_RELOCATION_OWNER), path.join(payload, DATA_ROOT_RELOCATION_OWNER))
    /* await assertTargetIsSafe(target, pathValidationRoot) */
    await assertTargetIsSafe(target)
    try {
      await fsp.rmdir(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await fsp.rename(payload, target)
    promoted = true
    await fsyncDirectory(path.dirname(target))
    await fsyncDirectory(work)
    commit(target)
    committed = true
    await cleanup(target, work)
  } catch (error) {
    if (promoted && !committed) await recoverOwnedPath(target, pending.taskId)
    await recoverOwnedPath(work, pending.taskId)
    throw error
  }
}

function clearCommittedRelocation(): void {
  const relocation = bootConfigService.get('temp.data_root_relocation')
  bootConfigService.set('temp.data_root_relocation', null)
  try {
    bootConfigService.persist()
  } catch (error) {
    bootConfigService.set('temp.data_root_relocation', relocation)
    throw error
  }
}

async function finishCommittedRelocationCleanup(relocation: CleanupPendingDataRootRelocation): Promise<void> {
  const { work } = artifactPaths(path.resolve(relocation.to), relocation.taskId)
  await cleanupRelocationArtifacts(path.resolve(relocation.to), work, relocation.taskId)
  clearCommittedRelocation()
}

function commitDataRootRelocation(target: string): void {
  const executable = getNormalizedExecutablePath()
  const roots = bootConfigService.get('app.data_root_path')
  const relocation = pendingSchema.parse(bootConfigService.get('temp.data_root_relocation'))
  bootConfigService.set('app.data_root_path', { ...roots, [executable]: path.resolve(target) })
  bootConfigService.set('temp.data_root_relocation', {
    status: 'cleanup-pending',
    taskId: relocation.taskId,
    from: relocation.from,
    to: relocation.to
  })
  try {
    bootConfigService.persist()
  } catch (error) {
    bootConfigService.set('app.data_root_path', roots)
    bootConfigService.set('temp.data_root_relocation', relocation)
    throw error
  }
}

async function cleanupRelocationArtifacts(target: string, work: string, taskId: string): Promise<void> {
  // const validationRoot = path.parse(target).root
  // await assertNotSymlink(target, 'committed target', validationRoot)
  await assertNotSymlink(target, 'committed target')
  await fsp.rm(path.join(target, DATA_ROOT_RELOCATION_OWNER), { force: true })
  await fsp.rm(path.join(target, LEGACY_DATA_ROOT_RELOCATION_OWNER), { force: true })
  await fsyncDirectory(target)
  // await fsp.rm(work, { recursive: true, force: true })
  await recoverOwnedPath(work, taskId)
  await fsyncDirectory(path.dirname(work))
}

async function copyDataRoot(source: string, payload: string): Promise<void> {
  await fsp.mkdir(payload, { recursive: false, mode: 0o700 })
  for (const entry of await fsp.readdir(source)) {
    if (EXCLUDED_ROOT_ENTRIES.has(entry) || entry.startsWith('.data-root-relocation-')) continue
    const sourceEntry = path.join(source, entry)
    const targetEntry = path.join(payload, entry)
    await copyEntryRejectingSymlinks(sourceEntry, targetEntry)
  }
}

async function copyEntryRejectingSymlinks(source: string, target: string): Promise<void> {
  const stat = await fsp.lstat(source)
  if (stat.isSymbolicLink()) throw new Error(`dataRoot relocation refuses symlink: ${source}`)
  if (stat.isDirectory()) {
    await fsp.mkdir(target, { mode: stat.mode })
    for (const entry of await fsp.readdir(source)) {
      await copyEntryRejectingSymlinks(path.join(source, entry), path.join(target, entry))
    }
    await fsyncDirectory(target)
    return
  }
  if (!stat.isFile()) throw new Error(`dataRoot relocation refuses special file: ${source}`)
  await copyFileDurable(source, target)
}

async function copyFileDurable(source: string, target: string): Promise<void> {
  await fsp.copyFile(source, target)
  // const handle = await fsp.open(target, 'r')
  // MEA:data-root-relocation-safety Windows fsync 需要可写且不截断的文件句柄。
  const handle = await fsp.open(target, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

// async function renameDurable(source: string, target: string): Promise<void> {
//   await fsp.rename(source, target)
//   await fsyncDirectory(path.dirname(target))
//   const sourceParent = path.dirname(source)
//   if (sourceParent !== path.dirname(target)) await fsyncDirectory(sourceParent)
// }

async function fsyncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await fsp.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function validateCopiedDataRoot(dataRoot: string): Promise<void> {
  const paths = createProfilePaths(dataRoot)
  for (const required of [paths.controlRoot, paths.profilesRoot]) {
    const stat = await fsp.lstat(required)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Invalid dataRoot directory: ${required}`)
  }

  const sharedRoot = path.join(paths.dataRoot, 'shared')
  try {
    const stat = await fsp.lstat(sharedRoot)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Invalid dataRoot directory: ${sharedRoot}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const registry = new ProfileRegistry(path.join(paths.controlRoot, 'profiles.json'))
  const state = await registry.read()
  for (const profile of state.profiles) {
    const profileRoot = resolveProfileRoot(paths, profile.profileId)
    let stat: fs.Stats
    try {
      stat = await fsp.lstat(profileRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Profile directory is missing: ${profile.profileId}`)
      }
      throw error
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Invalid profile directory: ${profile.profileId}`)
    }
  }
}

// async function assertNotSymlink(target: string, label: string, validationRoot: string): Promise<void> {
//   await assertPathHasNoSymlink(target, label, validationRoot)
async function assertNotSymlink(target: string, label: string): Promise<void> {
  await assertPathHasNoSymlink(target, label)
  const stat = await fsp.lstat(target)
  if (!stat.isDirectory()) throw new Error(`dataRoot relocation ${label} must be a directory`)
}

// async function assertTargetIsSafe(target: string, validationRoot: string): Promise<void> {
async function assertTargetIsSafe(target: string): Promise<void> {
  try {
    const stat = await fsp.lstat(target)
    if (stat.isSymbolicLink()) throw new Error('dataRoot relocation target cannot be a symlink')
    // throw new Error('dataRoot relocation target must not already exist')
    // MEA:data-root-relocation-safety 与 inspect 的已有空目录契约一致，不合并或清空非空目录。
    if (!stat.isDirectory()) throw new Error('dataRoot relocation target must be a directory')
    if ((await fsp.readdir(target)).length !== 0) throw new Error('dataRoot relocation target must be empty')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const parent = await nearestExistingAncestor(path.dirname(target))
  // await assertPathHasNoSymlink(parent, 'target ancestor', validationRoot)
  await assertPathHasNoSymlink(parent, 'target ancestor')
}

// async function assertPathHasNoSymlink(target: string, label: string, validationRoot: string): Promise<void> {
async function assertPathHasNoSymlink(target: string, label: string): Promise<void> {
  // let current = path.resolve(validationRoot)
  // const relative = path.relative(current, path.resolve(target))
  // for (const segment of relative.split(path.sep).filter(Boolean)) {
  //   current = path.join(current, segment)
  // MEA:data-root-relocation-safety 不允许共同祖先缩短链接检查范围。
  for (const current of relocationPathAncestors(target)) {
    // const stat = await fsp.lstat(current)
    // if (stat.isSymbolicLink()) throw new Error(`dataRoot relocation ${label} cannot contain a symlink`)
    // MEA:data-root-relocation-safety 与同步预检一致，放行卷根一级 root 持有的系统链接（macOS /var、/tmp）。
    const stat = await fsp.lstat(current)
    if (stat.isSymbolicLink() && !isVolumeRootOwnedSymlink(current)) {
      throw new Error(`dataRoot relocation ${label} cannot contain a symlink`)
    }
  }
}

async function nearestExistingAncestor(candidate: string): Promise<string> {
  let current = candidate
  while (true) {
    try {
      await fsp.lstat(current)
      return current
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}

// function commonAncestor(left: string, right: string): string {
//   let current = path.dirname(left)
//   while (!isInside(current, right) && current !== right) {
//     const parent = path.dirname(current)
//     if (parent === current) return current
//     current = parent
//   }
//   return current
// }

function assertSeparated(source: string, target: string): void {
  if (source === target || isInside(source, target) || isInside(target, source)) {
    throw new Error('dataRoot relocation source and target cannot contain each other')
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  // return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function artifactPaths(target: string, taskId: string): { work: string; payload: string } {
  const work = path.join(path.dirname(target), `.${path.basename(target)}.data-root-relocation-${taskId}-work`)
  return { work, payload: path.join(work, PAYLOAD) }
}

async function recoverOwnedPath(target: string, taskId: string): Promise<void> {
  try {
    const stat = await fsp.lstat(target)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Relocation artifact must not be a symlink')
    let raw: string
    let legacy = false
    try {
      raw = await fsp.readFile(path.join(target, DATA_ROOT_RELOCATION_OWNER), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      raw = await fsp.readFile(path.join(target, LEGACY_DATA_ROOT_RELOCATION_OWNER), 'utf8')
      legacy = true
    }
    const owner = legacy ? legacyOwnerSchema.parse(JSON.parse(raw)) : ownerSchema.parse(JSON.parse(raw))
    if (owner.taskId !== taskId) throw new Error(`Relocation path is owned by another task: ${target}`)
    await fsp.rm(target, { recursive: true, force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}
