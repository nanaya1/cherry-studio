import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, opendir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type ProfileSensitiveDataItem =
  | 'mcp-oauth'
  | 'mcp-memory'
  | 'mcp-registry'
  | 'mcp-settings'
  | 'copilot-token'
  | 'enterprise-state'
  | 'enterprise-credentials'

interface MigrationProfile {
  kind: 'local' | 'authenticated'
  profileId: string
  identityDigest: string
}

interface MigrationInput {
  mode: 'business' | string
  profile: MigrationProfile
  userData: string
}

interface MigrationOptions {
  cherryHome: string
  legacyUserData?: string
  beforeCommit?: (item: ProfileSensitiveDataItem) => Promise<void>
}

interface MigrationEntry {
  item: ProfileSensitiveDataItem
  source: string
  target: string
  credential: boolean
}

interface MigrationManifest {
  version: 1
  profileId: string
  identityDigest: string
  completed: Record<string, 'copied' | 'preserved-existing' | 'source-missing'>
}

export type ProfileSensitiveDataMigrationResult =
  | { status: 'skipped'; reason: 'not-business' | 'authenticated-requires-claim' }
  | { status: 'already-complete' }
  | { status: 'migrated'; items: ProfileSensitiveDataItem[] }

export class ProfileSensitiveDataMigrator {
  constructor(private readonly options: MigrationOptions) {}

  async migrate(input: MigrationInput): Promise<ProfileSensitiveDataMigrationResult> {
    if (input.mode !== 'business') return { status: 'skipped', reason: 'not-business' }
    if (input.profile.kind === 'authenticated') {
      return { status: 'skipped', reason: 'authenticated-requires-claim' }
    }
    return this.copyItems(input, this.entries(input.userData), false)
  }

  async importClaimedItems(
    input: MigrationInput,
    items: readonly ProfileSensitiveDataItem[],
    identityDigest: string
  ): Promise<ProfileSensitiveDataMigrationResult> {
    if (input.mode !== 'business') return { status: 'skipped', reason: 'not-business' }
    if (input.profile.identityDigest !== identityDigest) {
      throw new Error('Cannot import sensitive data without a proven profile identity')
    }
    const selected = new Set(items)
    return this.copyItems(
      input,
      this.entries(input.userData).filter((entry) => selected.has(entry.item)),
      true
    )
  }

  private async copyItems(
    input: MigrationInput,
    entries: MigrationEntry[],
    explicitClaim: boolean
  ): Promise<ProfileSensitiveDataMigrationResult> {
    const migrationRoot = path.join(input.userData, 'Runtime', 'ProfileMigration')
    const manifestPath = path.join(migrationRoot, 'legacy-sensitive-data.json')
    const journalPath = path.join(migrationRoot, 'legacy-sensitive-data.journal.json')
    const manifest = await this.readManifest(manifestPath, input.profile)
    await this.recoverJournal(journalPath, input, entries)
    const pending = entries.filter(
      (entry) => manifest.completed[entry.item] === undefined || manifest.completed[entry.item] === 'source-missing'
    )
    if (pending.length === 0) return { status: 'already-complete' }

    const migrated: ProfileSensitiveDataItem[] = []
    await mkdir(migrationRoot, { recursive: true })
    for (const entry of pending) {
      if (entry.credential && input.profile.kind === 'authenticated' && !explicitClaim) continue
      const staging = `${entry.target}.staging-${process.pid}-${randomUUID()}`
      try {
        const sourceKind = await this.pathKind(entry.source)
        if (sourceKind === null) {
          manifest.completed[entry.item] = 'source-missing'
          await this.writeManifest(manifestPath, manifest)
          continue
        }
        await mkdir(path.dirname(entry.target), { recursive: true })
        await rm(staging, { recursive: true, force: true })
        if (sourceKind === 'directory') await this.assertTreeHasNoSymlinks(entry.source)
        await cp(entry.source, staging, { recursive: sourceKind === 'directory', errorOnExist: true })
        await this.atomicWrite(
          journalPath,
          JSON.stringify({ version: 1, profileId: input.profile.profileId, item: entry.item, staging, target: entry.target })
        )
        await this.options.beforeCommit?.(entry.item)
        if ((await this.pathKind(entry.target)) === null) {
          await rename(staging, entry.target)
          manifest.completed[entry.item] = 'copied'
        } else {
          await rm(staging, { recursive: true, force: true })
          manifest.completed[entry.item] = 'preserved-existing'
        }
        await this.writeManifest(manifestPath, manifest)
        await rm(journalPath, { force: true })
        migrated.push(entry.item)
      } catch (error) {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
    }
    return migrated.length === 0 ? { status: 'already-complete' } : { status: 'migrated', items: migrated }
  }

  private entries(userData: string): MigrationEntry[] {
    const legacyEnterprise = this.options.legacyUserData
      ? path.join(this.options.legacyUserData, 'Data', 'enterprise')
      : path.join(this.options.cherryHome, 'enterprise')
    return [
      this.entry('mcp-oauth', 'config/mcp/oauth', userData, 'Sensitive/Mcp/oauth', true),
      this.entry('mcp-memory', 'config/memory.json', userData, 'Sensitive/Mcp/memory.json', false),
      this.entry('mcp-registry', 'config/mcp-registry.json', userData, 'Sensitive/Mcp/registry.json', false),
      this.entry(
        'mcp-settings',
        'config/mcp-auto-install-settings.json',
        userData,
        'Sensitive/Mcp/auto-install-settings.json',
        false
      ),
      this.entry('copilot-token', 'config/.copilot_token', userData, 'Sensitive/Copilot/token.enc', true),
      {
        item: 'enterprise-state',
        source: path.join(legacyEnterprise, 'org-state.json'),
        target: path.join(userData, 'Sensitive/Enterprise/org-state.json'),
        credential: false
      },
      {
        item: 'enterprise-credentials',
        source: path.join(legacyEnterprise, 'org-session.json'),
        target: path.join(userData, 'Sensitive/Enterprise/org-session.json'),
        credential: true
      }
    ]
  }

  private entry(
    item: ProfileSensitiveDataItem,
    source: string,
    userData: string,
    target: string,
    credential: boolean
  ): MigrationEntry {
    return {
      item,
      source: path.join(this.options.cherryHome, source),
      target: path.join(userData, target),
      credential
    }
  }

  private async readManifest(filePath: string, profile: MigrationProfile): Promise<MigrationManifest> {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as MigrationManifest
      if (
        parsed.version !== 1 ||
        parsed.profileId !== profile.profileId ||
        parsed.identityDigest !== profile.identityDigest ||
        typeof parsed.completed !== 'object' ||
        parsed.completed === null
      ) {
        throw new Error('Sensitive migration manifest does not match the current profile')
      }
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return {
        version: 1,
        profileId: profile.profileId,
        identityDigest: profile.identityDigest,
        completed: {}
      }
    }
  }

  private async recoverJournal(journalPath: string, input: MigrationInput, entries: MigrationEntry[]): Promise<void> {
    let decoded: unknown
    try {
      decoded = JSON.parse(await readFile(journalPath, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!decoded || typeof decoded !== 'object') throw new Error('Sensitive migration journal is invalid')
    const journal = decoded as Record<string, unknown>
    const entry = entries.find((candidate) => candidate.item === journal.item)
    const staging = typeof journal.staging === 'string' ? journal.staging : ''
    if (
      journal.version !== 1 ||
      journal.profileId !== input.profile.profileId ||
      !entry ||
      journal.target !== entry.target ||
      path.dirname(staging) !== path.dirname(entry.target) ||
      !path.basename(staging).startsWith(`${path.basename(entry.target)}.staging-`)
    ) {
      throw new Error('Sensitive migration journal does not match the current profile')
    }
    await rm(staging, { recursive: true, force: true })
    await rm(journalPath, { force: true })
  }

  private async assertTreeHasNoSymlinks(root: string): Promise<void> {
    const directory = await opendir(root)
    for await (const entry of directory) {
      const child = path.join(root, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Refusing to migrate symbolic link: ${child}`)
      if (entry.isDirectory()) await this.assertTreeHasNoSymlinks(child)
      else if (!entry.isFile()) throw new Error(`Refusing to migrate unsupported filesystem entry: ${child}`)
    }
  }

  private async writeManifest(filePath: string, manifest: MigrationManifest): Promise<void> {
    await this.atomicWrite(filePath, `${JSON.stringify(manifest, null, 2)}\n`)
  }

  private async atomicWrite(filePath: string, content: string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true })
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: 'wx' })
      await rename(temporary, filePath)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private async pathKind(filePath: string): Promise<'file' | 'directory' | null> {
    try {
      const stats = await lstat(filePath)
      if (stats.isSymbolicLink()) throw new Error(`Refusing to migrate symbolic link: ${filePath}`)
      if (stats.isDirectory()) return 'directory'
      if (stats.isFile()) return 'file'
      throw new Error(`Refusing to migrate unsupported filesystem entry: ${filePath}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
}
