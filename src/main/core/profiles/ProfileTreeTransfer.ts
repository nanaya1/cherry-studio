import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { copyFile, lstat, mkdir, opendir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

export interface TransferFile {
  path: string
  size: number
  sha256: string
}

export interface TransferExcluded {
  path: string
  category: string
  size: number
}

export interface TransferPlan {
  files: TransferFile[]
  excluded: TransferExcluded[]
  totalBytes: number
}

export type TransferClassifier = (
  relativePath: string,
  directory: boolean
) => { action: 'include'; category: string } | { action: 'exclude'; category: string }

export type TransferCopyFile = (source: string, target: string) => Promise<void>

function portableRelative(value: string): string {
  return value.split(path.sep).join('/')
}

async function hashFile(filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(filePath))
    .digest('hex')
}

async function directorySize(root: string): Promise<number> {
  let total = 0
  const directory = await opendir(root)
  for await (const entry of directory) {
    const child = path.join(root, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) total += await directorySize(child)
    else if (entry.isFile()) total += (await stat(child)).size
    else throw new Error(`Refusing to copy unsupported filesystem entry: ${child}`)
  }
  return total
}

export async function scanTransferTree(root: string, classify: TransferClassifier): Promise<TransferPlan> {
  const files: TransferFile[] = []
  const excluded: TransferExcluded[] = []

  async function visit(directoryPath: string, relativeDirectory: string): Promise<void> {
    const directory = await opendir(directoryPath)
    const entries: Dirent<string>[] = []
    for await (const entry of directory) entries.push(entry)
    entries.sort((left, right) => left.name.localeCompare(right.name))

    for (const entry of entries) {
      const absolute = path.join(directoryPath, entry.name)
      const relative = portableRelative(path.join(relativeDirectory, entry.name))
      if (entry.isSymbolicLink()) throw new Error(`Refusing to copy symbolic link: ${absolute}`)
      if (!entry.isDirectory() && !entry.isFile()) {
        throw new Error(`Refusing to copy unsupported filesystem entry: ${absolute}`)
      }
      const decision = classify(relative, entry.isDirectory())
      if (decision.action === 'exclude') {
        excluded.push({
          path: relative,
          category: decision.category,
          size: entry.isDirectory() ? await directorySize(absolute) : (await stat(absolute)).size
        })
        continue
      }
      if (entry.isDirectory()) await visit(absolute, relative)
      else {
        const size = (await stat(absolute)).size
        files.push({ path: relative, size, sha256: await hashFile(absolute) })
      }
    }
  }

  const rootStats = await lstat(root)
  if (rootStats.isSymbolicLink()) throw new Error(`Refusing to copy symbolic link: ${root}`)
  if (!rootStats.isDirectory()) throw new Error(`Copy source is not a directory: ${root}`)
  await visit(root, '')
  return { files, excluded, totalBytes: files.reduce((total, file) => total + file.size, 0) }
}

export async function copyTransferPlan(
  sourceRoot: string,
  targetRoot: string,
  plan: TransferPlan,
  copier: TransferCopyFile = copyFile
): Promise<void> {
  for (const file of plan.files) {
    const source = path.join(sourceRoot, ...file.path.split('/'))
    const target = path.join(targetRoot, ...file.path.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    await copier(source, target)
    const copied = await stat(target)
    if (copied.size !== file.size || (await hashFile(target)) !== file.sha256) {
      throw new Error(`Copied file verification failed: ${file.path}`)
    }
  }
}
