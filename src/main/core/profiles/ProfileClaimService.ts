import { randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'

import { ProfileControlStore } from './ProfileControlStore'
import { type ProfileClaimJournalV1, ProfileClaimJournalV1Schema } from './ProfileSchemas'
import { copyTransferPlan, scanTransferTree, type TransferExcluded, type TransferFile } from './ProfileTreeTransfer'

export type ProfileClaimAllow = 'api-keys' | 'ordinary-config'
export type ProfileClaimCategory =
  | 'business-data'
  | 'ordinary-config'
  | 'api-key'
  | 'credentials'
  | 'session-cookies'
  | 'mcp-oauth'
  | 'copilot'
  | 'enterprise-resource'
  | 'sensitive'
  | 'runtime'

export interface ProfileClaimPreviewItem {
  category: ProfileClaimCategory
  bytes: number
  paths: string[]
  credential: boolean
}

export type ProfileClaimPreview =
  | { status: 'already-claimed' }
  | { status: 'staged' }
  | { status: 'unsupported'; reason: 'target-not-empty' }
  | {
      status: 'ready'
      previewId: string
      totalBytes: number
      included: ProfileClaimPreviewItem[]
      excluded: ProfileClaimPreviewItem[]
    }

interface ProfileClaimServiceOptions {
  localUserData: string
  targetUserData: string
  journalPath?: string
  sqliteValidator?: (filePath: string) => Promise<void>
  rename?: (source: string, target: string) => Promise<void>
}

interface StoredPreview {
  previewId: string
  plan: Awaited<ReturnType<typeof scanTransferTree>>
}

const NEVER_ALLOWED = new Set<ProfileClaimCategory>([
  'credentials',
  'session-cookies',
  'mcp-oauth',
  'copilot',
  'enterprise-resource',
  'sensitive',
  'runtime'
])

export class ProfileClaimService {
  private previewState: StoredPreview | undefined
  private readonly journal: ProfileControlStore<ProfileClaimJournalV1>

  constructor(private readonly options: ProfileClaimServiceOptions) {
    const journalPath =
      options.journalPath ??
      path.join(path.dirname(options.targetUserData), 'Runtime', 'ProfileClaim', 'claim-journal.json')
    this.journal = new ProfileControlStore(journalPath, ProfileClaimJournalV1Schema)
  }

  async preview(): Promise<ProfileClaimPreview> {
    const recovered = await this.recoverInterruptedCopy()
    if (recovered === 'committed') return { status: 'already-claimed' }
    if (recovered === 'staged') return { status: 'staged' }
    if (await this.isNonEmptyDirectory(this.options.targetUserData)) {
      return { status: 'unsupported', reason: 'target-not-empty' }
    }
    const previewId = randomUUID()
    const plan = await scanTransferTree(this.options.localUserData, (relativePath, directory) => {
      if (directory && this.requiresLeafClassification(relativePath)) {
        return { action: 'include', category: 'business-data' }
      }
      const category = this.category(relativePath)
      return NEVER_ALLOWED.has(category) || category === 'api-key' || category === 'ordinary-config'
        ? { action: 'exclude', category }
        : { action: 'include', category }
    })
    if (this.options.sqliteValidator) {
      for (const file of plan.files) {
        if (/\.(?:sqlite|sqlite3|db)$/i.test(file.path)) {
          await this.options.sqliteValidator(path.join(this.options.localUserData, ...file.path.split('/')))
        }
      }
    }
    this.previewState = { previewId, plan }
    return {
      status: 'ready',
      previewId,
      totalBytes: plan.totalBytes,
      included: this.summarizeFiles(plan.files),
      excluded: this.summarizeExcluded(plan.excluded)
    }
  }

  async confirm(request: {
    previewId: string
    allow: ProfileClaimAllow[]
    signal?: AbortSignal
  }): Promise<{ status: 'claimed' } | { status: 'cancelled' }> {
    if (!this.previewState || this.previewState.previewId !== request.previewId) {
      throw new Error('Profile claim preview is missing or stale')
    }
    if (request.signal?.aborted) return { status: 'cancelled' }
    if (await this.isNonEmptyDirectory(this.options.targetUserData)) {
      throw new Error('Structured import is unsupported for a non-empty target')
    }

    const allowedCategories = new Set<ProfileClaimCategory>()
    if (request.allow.includes('api-keys')) allowedCategories.add('api-key')
    if (request.allow.includes('ordinary-config')) allowedCategories.add('ordinary-config')
    const extraFiles = this.previewState.plan.excluded
      .filter((item) => allowedCategories.has(item.category as ProfileClaimCategory))
      .map(async (item) => {
        const one = await scanTransferTree(this.options.localUserData, (relativePath, directory) => {
          const inside = relativePath === item.path || relativePath.startsWith(`${item.path}/`)
          if (!inside && directory && item.path.startsWith(`${relativePath}/`))
            return { action: 'include' as const, category: item.category }
          return inside
            ? { action: 'include' as const, category: item.category }
            : { action: 'exclude' as const, category: 'not-selected' }
        })
        return one.files
      })
    const files = [...this.previewState.plan.files, ...(await Promise.all(extraFiles)).flat()]
    const totalBytes = files.reduce((total, file) => total + file.size, 0)
    const operationId = randomUUID()
    const targetParent = path.dirname(this.options.targetUserData)
    const stagingRoot = path.join(targetParent, `.claim-${operationId}.staging`)
    await mkdir(targetParent, { recursive: true })
    await mkdir(path.dirname(this.journal.path), { recursive: true })
    await this.writeJournal({
      version: 1,
      phase: 'copying',
      operationId,
      previewId: request.previewId,
      sourceRoot: this.options.localUserData,
      targetRoot: this.options.targetUserData,
      stagingRoot
    })
    try {
      await mkdir(stagingRoot, { recursive: true })
      await copyTransferPlan(
        this.options.localUserData,
        stagingRoot,
        { files, excluded: [], totalBytes },
        async (source, target) => {
          if (request.signal?.aborted) throw Object.assign(new Error('Profile claim cancelled'), { code: 'ABORT_ERR' })
          await copyFile(source, target)
        }
      )
      if (request.signal?.aborted) {
        await rm(stagingRoot, { recursive: true, force: true })
        return { status: 'cancelled' }
      }
      await (this.options.rename ?? rename)(stagingRoot, this.options.targetUserData)
      await this.writeJournal({
        version: 1,
        phase: 'staged',
        operationId,
        previewId: request.previewId,
        sourceRoot: this.options.localUserData,
        targetRoot: this.options.targetUserData,
        stagingRoot
      })
      this.previewState = undefined
      return { status: 'claimed' }
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
      if ((error as NodeJS.ErrnoException).code === 'ABORT_ERR') return { status: 'cancelled' }
      throw error
    }
  }

  private requiresLeafClassification(relativePath: string): boolean {
    return /^(?:Sensitive|Config)(?:\/|$)/i.test(relativePath)
  }

  private async writeJournal(value: ProfileClaimJournalV1): Promise<void> {
    const durability = await this.journal.write(value)
    if (durability.kind === 'committed-durability-unknown') {
      throw new Error(`Profile claim journal durability is unknown: ${durability.error}`)
    }
  }

  private category(relativePath: string): ProfileClaimCategory {
    if (/^Credentials(?:\/|$)/i.test(relativePath)) return 'credentials'
    if (/^(?:Session|Cookies)(?:\/|$)/i.test(relativePath) || /(?:^|\/)Cookies(?:\/|$)/i.test(relativePath)) {
      return 'session-cookies'
    }
    if (/^Sensitive\/Mcp\/oauth(?:\/|$)/i.test(relativePath)) return 'mcp-oauth'
    if (/^Sensitive\/Copilot(?:\/|$)/i.test(relativePath)) return 'copilot'
    if (/^Sensitive(?:\/|$)/i.test(relativePath)) return 'sensitive'
    if (/^Data\/enterprise(?:\/|$)/i.test(relativePath)) return 'enterprise-resource'
    if (/^Data\/Agents\/\.claude(?:\/|$)/i.test(relativePath)) return 'runtime'
    if (/^(?:Runtime|temp|logs|crashDumps)(?:\/|$)/i.test(relativePath)) return 'runtime'
    if (/^(?:Config|Preferences)(?:\/|$)/i.test(relativePath)) {
      return /api[-_]?key|providers?\.json/i.test(relativePath) ? 'api-key' : 'ordinary-config'
    }
    return 'business-data'
  }

  private summarizeFiles(files: TransferFile[]): ProfileClaimPreviewItem[] {
    return this.summarize(
      files.map((file) => ({ path: file.path, size: file.size, category: this.category(file.path) }))
    )
  }

  private summarizeExcluded(items: TransferExcluded[]): ProfileClaimPreviewItem[] {
    return this.summarize(items)
  }

  private summarize(items: Array<{ path: string; size: number; category: string }>): ProfileClaimPreviewItem[] {
    const groups = new Map<ProfileClaimCategory, ProfileClaimPreviewItem>()
    for (const item of items) {
      const category = item.category as ProfileClaimCategory
      const group = groups.get(category) ?? { category, bytes: 0, paths: [], credential: this.isCredential(category) }
      group.bytes += item.size
      group.paths.push(item.path)
      groups.set(category, group)
    }
    return [...groups.values()]
  }

  private isCredential(category: ProfileClaimCategory): boolean {
    return ['credentials', 'session-cookies', 'mcp-oauth', 'copilot', 'api-key'].includes(category)
  }

  async commit(): Promise<void> {
    const state = await this.journal.read()
    if (state.kind !== 'ok') throw new Error('Profile claim is not staged')
    if (
      state.value.sourceRoot !== this.options.localUserData ||
      state.value.targetRoot !== this.options.targetUserData
    ) {
      throw new Error('Profile claim journal does not match source and target')
    }
    if (state.value.phase === 'committed') return
    if (state.value.phase !== 'staged') throw new Error('Profile claim is not staged')
    await this.writeJournal({ ...state.value, phase: 'committed', committedAt: new Date().toISOString() })
  }

  private async recoverInterruptedCopy(): Promise<'none' | 'staged' | 'committed'> {
    const state = await this.journal.read()
    if (state.kind === 'none') return 'none'
    if (state.kind === 'corrupt') throw new Error(`Profile claim journal is corrupt: ${state.error}`)
    if (state.value.sourceRoot !== this.options.localUserData) {
      throw new Error('Profile claim journal does not match source')
    }
    if (state.value.phase === 'committed') return 'committed'
    if (state.value.targetRoot !== this.options.targetUserData) {
      throw new Error('Profile claim journal does not match target')
    }
    if (state.value.phase === 'staged') return 'staged'
    await rm(state.value.stagingRoot, { recursive: true, force: true })
    if (await this.isNonEmptyDirectory(this.options.targetUserData)) {
      await this.writeJournal({ ...state.value, phase: 'staged' })
      return 'staged'
    }
    return 'none'
  }

  private async isNonEmptyDirectory(directory: string): Promise<boolean> {
    try {
      const stats = await lstat(directory)
      if (stats.isSymbolicLink()) throw new Error(`Refusing profile claim symbolic link: ${directory}`)
      if (!stats.isDirectory()) return true
      return (await readdir(directory)).length > 0
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
}
