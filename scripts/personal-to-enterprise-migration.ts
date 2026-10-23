import { lstat } from 'node:fs/promises'
import path from 'node:path'

import { validateSqliteIntegrity, ProfileClaimService, type ProfileClaimAllow } from '../src/main/core/profiles'

interface MigrationOptions {
  source: string
  target: string
  apply: boolean
  allow: ProfileClaimAllow[]
}

export interface MigrationPreview {
  status: 'preview'
  totalBytes: number
  included: string[]
  excluded: Array<{ category: string; paths: string[]; bytes: number }>
}

export interface MigrationApplied {
  status: 'applied'
  totalBytes: number
  included: string[]
}

export type MigrationResult = MigrationPreview | MigrationApplied

async function resolveTargetUserData(target: string): Promise<string> {
  const normalized = path.normalize(target)
  if (path.basename(normalized) === 'userData') return normalized

  const existing = await lstat(normalized).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (existing?.isSymbolicLink()) throw new Error(`Refusing symbolic-link target: ${normalized}`)
  if (existing && !existing.isDirectory()) throw new Error(`Target profile root is not a directory: ${normalized}`)
  if (path.basename(normalized) === 'userData') return normalized
  return path.join(normalized, 'userData')
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`)
  return value
}

export function parseArgs(args: string[]): MigrationOptions {
  let source: string | undefined
  let target: string | undefined
  let apply = false
  const allow: ProfileClaimAllow[] = []

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--source') source = path.resolve(requireValue(args, index++, '--source'))
    else if (argument === '--target') target = path.resolve(requireValue(args, index++, '--target'))
    else if (argument === '--apply') apply = true
    else if (argument === '--allow-api-keys') allow.push('api-keys')
    else if (argument === '--allow-ordinary-config') allow.push('ordinary-config')
    else if (argument === '--help' || argument === '-h') throw new Error(usage())
    else throw new Error(`Unknown option: ${argument}`)
  }

  if (!source) throw new Error('--source is required')
  if (!target) throw new Error('--target is required')
  return { source, target, apply, allow: [...new Set(allow)] }
}

export async function runMigration(options: MigrationOptions): Promise<MigrationResult> {
  const targetUserData = await resolveTargetUserData(options.target)
  const service = new ProfileClaimService({
    localUserData: options.source,
    targetUserData,
    sqliteValidator: validateSqliteIntegrity
  })
  const preview = await service.preview()
  if (preview.status === 'already-claimed') throw new Error('The target has already been claimed')
  if (preview.status === 'staged') throw new Error('An interrupted migration needs recovery before retrying')
  if (preview.status === 'unsupported') throw new Error('The target directory must be empty')

  const excluded = preview.excluded.reduce<MigrationPreview['excluded']>((groups, item) => {
    const group = groups.find((candidate) => candidate.category === item.category)
    if (group) {
      // ProfileClaimPreviewItem 按分类聚合，路径通过 paths 一次返回。
      // group.paths.push(item.path)
      group.paths.push(...item.paths)
      group.bytes += item.bytes
    } else {
      // groups.push({ category: item.category, paths: [item.path], bytes: item.bytes })
      groups.push({ category: item.category, paths: item.paths, bytes: item.bytes })
    }
    return groups
  }, [])
  if (!options.apply) {
    return {
      status: 'preview',
      totalBytes: preview.totalBytes,
      included: preview.included.flatMap((item) => item.paths),
      excluded
    }
  }

  const result = await service.confirm({ previewId: preview.previewId, allow: options.allow })
  if (result.status !== 'claimed') throw new Error('Migration was cancelled')
  await service.commit()
  return {
    status: 'applied',
    totalBytes: preview.totalBytes,
    included: preview.included.flatMap((item) => item.paths)
  }
}

function usage(): string {
  return [
    'Usage: pnpm tsx scripts/personal-to-enterprise-migration.ts --source <personal-user-data> --target <enterprise-profile-root> [options]',
    '',
    'Options:',
    '  --apply                  Copy files. Without this flag, only preview is generated.',
    '  --allow-api-keys         Include provider/API key configuration.',
    '  --allow-ordinary-config  Include non-secret ordinary configuration.',
    '  --help                   Show this help.'
  ].join('\n')
}

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2))
    const result = await runMigration(options)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) void main()
