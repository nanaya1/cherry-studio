import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

export interface ProfilePaths {
  dataRoot: string
  controlRoot: string
  profilesRoot: string
}

type PathImplementation = typeof path.posix

const PROFILE_ID_PATTERN = /^[a-f0-9]{32}$/

function selectPathImplementation(value: string): PathImplementation {
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
    return path.win32
  }
  if (path.posix.isAbsolute(value)) {
    return path.posix
  }
  throw new Error('dataRoot must be an absolute path')
}

function isFileSystemRoot(pathImplementation: PathImplementation, value: string): boolean {
  const normalized = pathImplementation.normalize(value)
  return normalized === pathImplementation.parse(normalized).root
}

function isWithin(pathImplementation: PathImplementation, parent: string, child: string): boolean {
  const relative = pathImplementation.relative(parent, child)
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${pathImplementation.sep}`) &&
    !pathImplementation.isAbsolute(relative)
  )
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export function createProfilePaths(dataRoot: string): ProfilePaths {
  const pathImplementation = selectPathImplementation(dataRoot)
  const normalizedDataRoot = pathImplementation.normalize(dataRoot)
  if (isFileSystemRoot(pathImplementation, normalizedDataRoot)) {
    throw new Error('dataRoot must not be a file system root')
  }

  return {
    dataRoot: normalizedDataRoot,
    controlRoot: pathImplementation.join(normalizedDataRoot, 'control'),
    profilesRoot: pathImplementation.join(normalizedDataRoot, 'profiles')
  }
}

export function resolveProfileRoot(paths: ProfilePaths, profileId: string): string {
  if (profileId !== 'signed-out' && !PROFILE_ID_PATTERN.test(profileId)) {
    throw new Error('profileId must be signed-out or 32 lowercase hexadecimal characters')
  }

  const pathImplementation = selectPathImplementation(paths.dataRoot)
  return pathImplementation.join(paths.profilesRoot, profileId)
}

export async function validateExistingProfilePath(paths: ProfilePaths, profileRoot: string): Promise<void> {
  const pathImplementation = selectPathImplementation(paths.dataRoot)
  const normalizedProfileRoot = pathImplementation.normalize(profileRoot)
  const protectedRoots = [paths.dataRoot, paths.controlRoot, paths.profilesRoot].map((value) =>
    pathImplementation.normalize(value)
  )

  if (protectedRoots.includes(normalizedProfileRoot)) {
    throw new Error('profile root must not equal dataRoot, controlRoot, or profilesRoot')
  }
  if (!isWithin(pathImplementation, protectedRoots[2], normalizedProfileRoot)) {
    throw new Error('profile root must be inside profiles root')
  }

  const relativeProfilePath = pathImplementation.relative(protectedRoots[2], normalizedProfileRoot)
  if (relativeProfilePath.includes(pathImplementation.sep)) {
    throw new Error('profile root must be a direct child of profiles root')
  }
  resolveProfileRoot(paths, relativeProfilePath)

  let currentPath = normalizedProfileRoot
  let nearestExistingAncestor: string | undefined
  let reachedDataRoot = false

  while (true) {
    try {
      const stats = await lstat(currentPath)
      if (stats.isSymbolicLink()) {
        throw new Error(`profile path contains a symbolic link: ${currentPath}`)
      }
      nearestExistingAncestor ??= currentPath
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error
      }
    }

    if (currentPath === protectedRoots[0]) {
      reachedDataRoot = true
      break
    }

    const parentPath = pathImplementation.dirname(currentPath)
    if (parentPath === currentPath || !isWithin(pathImplementation, protectedRoots[0], currentPath)) {
      break
    }
    currentPath = parentPath
  }

  if (!reachedDataRoot || !nearestExistingAncestor) {
    throw new Error('cannot canonicalize profile path because dataRoot does not exist')
  }

  const canonicalDataRoot = await realpath(protectedRoots[0])
  const canonicalExistingAncestor = await realpath(nearestExistingAncestor)
  const canonicalProfilesRoot = pathImplementation.join(canonicalDataRoot, 'profiles')
  const canonicalProfileRoot = pathImplementation.resolve(
    canonicalExistingAncestor,
    pathImplementation.relative(nearestExistingAncestor, normalizedProfileRoot)
  )

  if (!isWithin(pathImplementation, canonicalDataRoot, canonicalProfilesRoot)) {
    throw new Error('canonical profiles root must remain inside canonical dataRoot')
  }
  if (!isWithin(pathImplementation, canonicalProfilesRoot, canonicalProfileRoot)) {
    throw new Error('canonical profile root must remain inside canonical profiles root')
  }
}
