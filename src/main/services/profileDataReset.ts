import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { dialog } from 'electron'
import * as z from 'zod'

import { application } from '@application'
import { createProfilePaths, ProfileRegistry, resolveProfileRoot, type ProfileLaunchContext } from '@main/core/profiles'

export const PROFILE_DATA_RESET_MARKER = '.profile-data-reset.pending.json'

const profileIdSchema = z.string().regex(/^[a-f0-9]{32}$/)
const identityDigestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const markerSchema = z.strictObject({
  version: z.literal(1),
  status: z.literal('pending'),
  phase: z.enum(['pending', 'deleting-profiles', 'deleting-shared', 'deleting-control']).default('pending'),
  requestedAt: z.string().min(1),
  scope: z.enum(['specified-profile', 'device']),
  requesterProfileId: profileIdSchema,
  identityDigest: identityDigestSchema,
  profileId: profileIdSchema.optional(),
  targetIdentityDigest: identityDigestSchema.optional(),
  canonicalTarget: z.string().min(1)
})

type ProfileDataResetMarker = z.infer<typeof markerSchema>

type StageProfileDataResetOptions =
  | {
      scope: 'specified-profile'
      context: ProfileLaunchContext
      profileId: string
      dedicatedPreboot?: boolean
    }
  | {
      scope: 'device'
      context: ProfileLaunchContext
    }

export async function requestDeviceDataReset(context: ProfileLaunchContext): Promise<void> {
  requireBusinessProfile(context)
  const { response, checkboxChecked } = await dialog.showMessageBox({
    type: 'warning',
    title: 'Reset Device Data',
    message: 'Delete all MEA Cowork profiles and shared data from this device?',
    detail: 'This removes every local profile, device control data, and shared data. This action cannot be undone.',
    buttons: ['Cancel', 'Reset Device'],
    defaultId: 0,
    cancelId: 0,
    checkboxLabel: 'I understand that all profiles on this device will be deleted',
    checkboxChecked: false
  })
  if (response !== 1 || !checkboxChecked) return

  await stageProfileDataReset({ scope: 'device', context })
  await application.shutdown()
  application.relaunch()
}

export async function stageProfileDataReset(options: StageProfileDataResetOptions): Promise<void> {
  const context = requireBusinessProfile(options.context)
  const paths = createProfilePaths(context.dataRoot)
  const registry = new ProfileRegistry(path.join(paths.controlRoot, 'profiles.json'))
  const requester = await registry.requireActivatable(context.profileId, context.identityDigest)
  if (requester.kind === 'signed-out') throw new Error('Signed-out profile cannot request a data reset')

  let marker: ProfileDataResetMarker
  if (options.scope === 'specified-profile') {
    if (options.profileId !== context.profileId && !options.dedicatedPreboot) {
      throw new Error('Resetting another profile requires dedicated preboot')
    }
    const state = await registry.read()
    const target = state.profiles.find((profile) => profile.profileId === options.profileId)
    if (!target || target.kind === 'signed-out' || target.state !== 'ready') {
      throw new Error(`Reset target profile is not available: ${options.profileId}`)
    }
    marker = {
      version: 1,
      status: 'pending',
      phase: 'pending',
      requestedAt: new Date().toISOString(),
      scope: 'specified-profile',
      requesterProfileId: context.profileId,
      identityDigest: context.identityDigest,
      profileId: target.profileId,
      targetIdentityDigest: target.identityDigest,
      canonicalTarget: canonicalize(resolveProfileRoot(paths, target.profileId))
    }
  } else {
    marker = {
      version: 1,
      status: 'pending',
      phase: 'pending',
      requestedAt: new Date().toISOString(),
      scope: 'device',
      requesterProfileId: context.profileId,
      identityDigest: context.identityDigest,
      canonicalTarget: canonicalize(paths.dataRoot)
    }
  }

  writeMarkerAtomically(path.join(paths.dataRoot, PROFILE_DATA_RESET_MARKER), marker)
}

export async function runProfileDataResetPreboot(
  dataRoot: string,
  remove: typeof fs.rmSync = fs.rmSync
): Promise<'none' | 'handled'> {
  const canonicalDataRoot = canonicalize(dataRoot)
  const markerFile = path.join(canonicalDataRoot, PROFILE_DATA_RESET_MARKER)
  let raw: string
  try {
    raw = fs.readFileSync(markerFile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'none'
    throw error
  }

  const marker = markerSchema.parse(JSON.parse(raw))
  const paths = createProfilePaths(canonicalDataRoot)
  const registry = new ProfileRegistry(path.join(paths.controlRoot, 'profiles.json'))

  if (marker.phase === 'pending') {
    const requester = await registry.requireActivatable(marker.requesterProfileId, marker.identityDigest)
    if (requester.kind === 'signed-out') throw new Error('Reset marker identity is signed-out')
  }

  if (marker.scope === 'specified-profile') {
    if (marker.phase !== 'pending') throw new Error('Specified-profile reset marker has an invalid phase')
    if (!marker.profileId || !marker.targetIdentityDigest)
      throw new Error('Specified-profile reset marker is incomplete')
    const target = await registry.requireActivatable(marker.profileId, marker.targetIdentityDigest)
    if (target.kind === 'signed-out') throw new Error('Signed-out profile cannot be reset')
    const targetRoot = resolveProfileRoot(paths, target.profileId)
    if (canonicalize(targetRoot) !== marker.canonicalTarget) {
      throw new Error('Reset target canonical path does not match the registry profile')
    }
    remove(targetRoot, { recursive: true, force: true })
  } else {
    if (marker.canonicalTarget !== canonicalDataRoot) {
      throw new Error('Device reset canonical target does not match dataRoot')
    }
    let current = marker
    if (current.phase === 'pending') {
      current = { ...current, phase: 'deleting-profiles' }
      writeMarkerAtomically(markerFile, current)
    }
    if (current.phase === 'deleting-profiles') {
      remove(paths.profilesRoot, { recursive: true, force: true })
      current = { ...current, phase: 'deleting-shared' }
      writeMarkerAtomically(markerFile, current)
    }
    if (current.phase === 'deleting-shared') {
      remove(path.join(paths.dataRoot, 'shared'), { recursive: true, force: true })
      current = { ...current, phase: 'deleting-control' }
      writeMarkerAtomically(markerFile, current)
    }
    if (current.phase === 'deleting-control') {
      remove(paths.controlRoot, { recursive: true, force: true })
    }
  }

  fs.unlinkSync(markerFile)
  syncDirectory(canonicalDataRoot)
  return 'handled'
}

function requireBusinessProfile(context: ProfileLaunchContext): ProfileLaunchContext {
  if (context.mode !== 'business' || context.kind === 'signed-out' || context.profileId === 'signed-out') {
    throw new Error('Profile data reset requires an active business profile')
  }
  return context
}

function canonicalize(target: string): string {
  return fs.realpathSync.native(path.resolve(target))
}

function writeMarkerAtomically(file: string, marker: ProfileDataResetMarker): void {
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify(marker))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
  syncDirectory(path.dirname(file))
}

function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return
  const fd = fs.openSync(directory, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}
