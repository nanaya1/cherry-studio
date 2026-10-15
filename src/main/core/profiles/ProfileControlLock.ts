import { realpath } from 'node:fs/promises'
import path from 'node:path'

// This serializes control-file updates within one process only; cross-process locking is intentionally out of scope.
const tails = new Map<string, Promise<void>>()

async function canonicalizeControlPath(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath)
  try {
    return path.join(await realpath(path.dirname(resolved)), path.basename(resolved))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return resolved
    }
    throw error
  }
}

async function withCanonicalLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve()
  let release: () => void = () => undefined
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  tails.set(key, tail)

  await previous
  try {
    return await operation()
  } finally {
    release()
    if (tails.get(key) === tail) {
      tails.delete(key)
    }
  }
}

export async function withProfileControlLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  return withCanonicalLock(await canonicalizeControlPath(filePath), operation)
}

export async function withProfileControlLocks<T>(filePaths: string[], operation: () => Promise<T>): Promise<T> {
  const keys = [...new Set(await Promise.all(filePaths.map(canonicalizeControlPath)))].sort()

  const acquire = (index: number): Promise<T> => {
    if (index === keys.length) {
      return operation()
    }
    return withCanonicalLock(keys[index], () => acquire(index + 1))
  }

  return acquire(0)
}
