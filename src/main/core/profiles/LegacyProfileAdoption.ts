import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import Database from 'better-sqlite3'

import { ProfileActivePointer } from './ProfileActivePointer'
import { ProfileControlStore } from './ProfileControlStore'
import { ProfileInstallation } from './ProfileInstallation'
import { createProfilePaths } from './ProfilePaths'
import { ProfileRegistry } from './ProfileRegistry'
import { type LegacyAdoptionJournalV1, LegacyAdoptionJournalV1Schema, type ProfileRecordV1 } from './ProfileSchemas'
import { copyTransferPlan, scanTransferTree, type TransferCopyFile, type TransferFile } from './ProfileTreeTransfer'

export interface LegacyAdoptionManifestV1 {
  version: 1
  sourceRoot: string
  profileId: string
  totalBytes: number
  files: TransferFile[]
  quarantine: Array<{ path: string; category: string; size: number }>
}

export type SqliteIntegrityValidator = (filePath: string) => Promise<void>

interface LegacyProfileAdoptionOptions {
  legacyRoot: string
  dataRoot: string
  installation?: Pick<ProfileInstallation, 'getOrCreate'>
  registry?: Pick<ProfileRegistry, 'initialize' | 'ensureLocal'>
  pointer?: Pick<ProfileActivePointer, 'read' | 'commitPointer'>
  sqliteValidator?: SqliteIntegrityValidator
  copyFile?: TransferCopyFile
}

const EXCLUDED_TOP_LEVEL = /^(?:Singleton[^/]*|lock(?:file)?|temp|control|profiles)(?:\/|$)/i
const SENSITIVE = /^(?:Sensitive|Credentials|Session|Cookies)(?:\/|$)/i
const ENTERPRISE_SESSION = /(?:^|\/)enterprise\/(?:org-session|session|credentials?)\.json$/i
const AGENT_RUNTIME = /^Data\/Agents\/\.claude(?:\/|$)/i

export async function validateSqliteIntegrity(filePath: string): Promise<void> {
  const database = new Database(filePath, { readonly: true, fileMustExist: true })
  try {
    const rows = database.pragma('integrity_check') as Array<Record<string, unknown>>
    if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok')
      throw new Error(`SQLite integrity check failed: ${filePath}`)
  } finally {
    database.close()
  }
}

export class LegacyProfileAdoption {
  private readonly paths
  private readonly journal: ProfileControlStore<LegacyAdoptionJournalV1>
  private readonly installation: Pick<ProfileInstallation, 'getOrCreate'>
  private readonly registry: Pick<ProfileRegistry, 'initialize' | 'ensureLocal'>
  private readonly pointer: Pick<ProfileActivePointer, 'read' | 'commitPointer'>

  constructor(private readonly options: LegacyProfileAdoptionOptions) {
    this.paths = createProfilePaths(options.dataRoot)
    this.installation =
      options.installation ?? new ProfileInstallation(path.join(this.paths.controlRoot, 'installation.json'))
    this.registry = options.registry ?? new ProfileRegistry(path.join(this.paths.controlRoot, 'profiles.json'))
    this.pointer =
      options.pointer ??
      new ProfileActivePointer(
        path.join(this.paths.controlRoot, 'active-profile.json'),
        this.registry as ProfileRegistry
      )
    this.journal = new ProfileControlStore(
      path.join(this.paths.controlRoot, 'adoption-journal.json'),
      LegacyAdoptionJournalV1Schema
    )
  }

  async adopt(): Promise<
    { status: 'adopted'; profile: ProfileRecordV1 } | { status: 'already-adopted'; profile: ProfileRecordV1 }
  > {
    this.assertDisjointRoots(this.options.legacyRoot, this.options.dataRoot)
    await this.assertNotSymlink(this.options.legacyRoot)
    await this.assertNotSymlink(path.dirname(this.paths.dataRoot))
    await this.assertDisjointCanonicalRoots()
    await mkdir(this.paths.controlRoot, { recursive: true })
    await mkdir(this.paths.profilesRoot, { recursive: true })
    await this.registry.initialize()
    const installation = await this.installation.getOrCreate()
    const local = await this.registry.ensureLocal(installation.value.deviceInstallId, 'default')
    const targetRoot = path.join(this.paths.profilesRoot, local.value.profileId)
    const existingPointer = await this.pointer.read()
    if (existingPointer.kind === 'ok' && existingPointer.record.profileId === local.value.profileId) {
      return { status: 'already-adopted', profile: local.value }
    }

    const recovered = await this.recover(local.value, targetRoot)
    if (recovered) return recovered

    if (await this.exists(targetRoot)) throw new Error('Legacy adoption target must be empty')
    const operationId = randomUUID()
    const stagingRoot = path.join(this.paths.profilesRoot, `.adopt-${operationId}.staging`)
    await this.writeJournal({
      version: 1,
      phase: 'copying',
      operationId,
      legacyRoot: this.options.legacyRoot,
      stagingRoot
    })

    try {
      const plan = await scanTransferTree(this.options.legacyRoot, (relativePath) => {
        if (EXCLUDED_TOP_LEVEL.test(relativePath) || AGENT_RUNTIME.test(relativePath)) {
          return { action: 'exclude', category: 'runtime' }
        }
        if (SENSITIVE.test(relativePath)) return { action: 'exclude', category: 'sensitive' }
        if (ENTERPRISE_SESSION.test(relativePath)) return { action: 'exclude', category: 'enterprise-session' }
        return { action: 'include', category: 'business-data' }
      })
      await mkdir(path.join(stagingRoot, 'userData'), { recursive: true })
      await copyTransferPlan(
        this.options.legacyRoot,
        path.join(stagingRoot, 'userData'),
        plan,
        this.durableCopier(this.options.copyFile ?? copyFile)
      )
      await this.validateSqliteFiles(path.join(stagingRoot, 'userData'), plan.files)
      const manifest: LegacyAdoptionManifestV1 = {
        version: 1,
        sourceRoot: this.options.legacyRoot,
        profileId: local.value.profileId,
        totalBytes: plan.totalBytes,
        files: plan.files,
        quarantine: plan.excluded
      }
      const manifestPath = path.join(stagingRoot, 'userData', 'Runtime', 'LegacyProfileAdoption', 'manifest.json')
      await mkdir(path.dirname(manifestPath), { recursive: true })
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
      await this.fsyncFileAndParent(manifestPath)
      await this.writeJournal({
        version: 1,
        phase: 'staged',
        operationId,
        legacyRoot: this.options.legacyRoot,
        stagingRoot,
        profileId: local.value.profileId,
        identityDigest: local.value.identityDigest,
        targetRoot
      })
      await this.renameDurable(stagingRoot, targetRoot)
      await this.commitPointer(local.value, operationId)
      await this.writeJournal({
        version: 1,
        phase: 'committed',
        operationId,
        legacyRoot: this.options.legacyRoot,
        stagingRoot,
        profileId: local.value.profileId,
        identityDigest: local.value.identityDigest,
        targetRoot,
        committedAt: new Date().toISOString()
      })
      return { status: 'adopted', profile: local.value }
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  private async recover(profile: ProfileRecordV1, targetRoot: string) {
    const state = await this.journal.read()
    if (state.kind === 'none') return undefined
    if (state.kind === 'corrupt') throw new Error(`Legacy adoption journal is corrupt: ${state.error}`)
    if (state.value.legacyRoot !== this.options.legacyRoot) throw new Error('Legacy adoption journal source mismatch')
    if (state.value.phase === 'committed') {
      await this.commitPointer(profile, state.value.operationId)
      return { status: 'already-adopted' as const, profile }
    }
    if (state.value.phase === 'staged' && (await this.exists(state.value.targetRoot))) {
      if (state.value.targetRoot !== targetRoot || state.value.profileId !== profile.profileId) {
        throw new Error('Legacy adoption journal target mismatch')
      }
      try {
        await this.validatePromotedTarget(state.value.targetRoot, profile)
      } catch {
        await rm(state.value.targetRoot, { recursive: true, force: true })
        await this.fsyncDirectory(path.dirname(state.value.targetRoot))
        return undefined
      }
      await this.commitPointer(profile, state.value.operationId)
      await this.writeJournal({ ...state.value, phase: 'committed', committedAt: new Date().toISOString() })
      return { status: 'already-adopted' as const, profile }
    }
    await rm(state.value.stagingRoot, { recursive: true, force: true })
    return undefined
  }

  private async commitPointer(profile: ProfileRecordV1, operationId: string): Promise<void> {
    const result = await this.pointer.commitPointer(profile, operationId)
    if (result.durability.kind === 'committed-durability-unknown') {
      throw new Error(`Legacy adoption pointer durability is unknown: ${result.durability.error}`)
    }
  }

  private async writeJournal(value: LegacyAdoptionJournalV1): Promise<void> {
    const durability = await this.journal.write(value)
    if (durability.kind === 'committed-durability-unknown') {
      throw new Error(`Legacy adoption journal durability is unknown: ${durability.error}`)
    }
  }

  private durableCopier(copier: TransferCopyFile): TransferCopyFile {
    return async (source, target) => {
      await copier(source, target)
      await this.fsyncFileAndParent(target)
    }
  }

  private async validatePromotedTarget(targetRoot: string, profile: ProfileRecordV1): Promise<void> {
    const userDataRoot = path.join(targetRoot, 'userData')
    const manifestPath = path.join(userDataRoot, 'Runtime', 'LegacyProfileAdoption', 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as LegacyAdoptionManifestV1
    if (
      manifest.version !== 1 ||
      manifest.sourceRoot !== this.options.legacyRoot ||
      manifest.profileId !== profile.profileId ||
      manifest.totalBytes !== manifest.files.reduce((total, file) => total + file.size, 0)
    ) {
      throw new Error('Legacy adoption manifest mismatch')
    }
    for (const file of manifest.files) {
      const target = path.join(userDataRoot, ...file.path.split('/'))
      const metadata = await stat(target)
      const digest = createHash('sha256')
        .update(await readFile(target))
        .digest('hex')
      if (!metadata.isFile() || metadata.size !== file.size || digest !== file.sha256) {
        throw new Error(`Legacy adoption promoted file verification failed: ${file.path}`)
      }
    }
    await this.validateSqliteFiles(userDataRoot, manifest.files)
  }

  private async fsyncFileAndParent(filePath: string): Promise<void> {
    const handle = await open(filePath, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await this.fsyncDirectory(path.dirname(filePath))
  }

  private async renameDurable(source: string, target: string): Promise<void> {
    await rename(source, target)
    await this.fsyncDirectory(path.dirname(target))
    const sourceParent = path.dirname(source)
    if (sourceParent !== path.dirname(target)) await this.fsyncDirectory(sourceParent)
  }

  private async fsyncDirectory(directory: string): Promise<void> {
    if (process.platform === 'win32') return
    const handle = await open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  private async validateSqliteFiles(root: string, files: TransferFile[]): Promise<void> {
    const validator = this.options.sqliteValidator ?? validateSqliteIntegrity
    for (const file of files) {
      if (/\.(?:sqlite|sqlite3|db)$/i.test(file.path)) await validator(path.join(root, ...file.path.split('/')))
    }
  }

  private assertDisjointRoots(sourceValue: string, targetValue: string): void {
    const source = path.resolve(sourceValue)
    const target = path.resolve(targetValue)
    const sourceToTarget = path.relative(source, target)
    const targetToSource = path.relative(target, source)
    const inside = (relative: string) => relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..')
    if (inside(sourceToTarget) || inside(targetToSource))
      throw new Error('Legacy source and profile dataRoot must not overlap or be inside each other')
  }

  private async assertDisjointCanonicalRoots(): Promise<void> {
    const canonicalSource = await realpath(this.options.legacyRoot)
    const canonicalTargetParent = await realpath(path.dirname(this.options.dataRoot))
    const canonicalTarget = path.join(canonicalTargetParent, path.basename(this.options.dataRoot))
    this.assertDisjointRoots(canonicalSource, canonicalTarget)
  }

  private async assertNotSymlink(value: string): Promise<void> {
    if ((await lstat(value)).isSymbolicLink()) throw new Error(`Refusing to adopt symbolic link: ${value}`)
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await lstat(filePath)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
}
