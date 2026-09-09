import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import { application } from '@application'
import { agentGlobalSkillTable } from '@data/db/schemas/agentGlobalSkill'
import {
  skillCatalogIndustryTable,
  skillCatalogProfessionalDimensionTable,
  skillCatalogSyncStateTable,
  skillCatalogTable,
  skillCatalogTranslationTable,
  skillIndustryTable,
  skillIndustryTranslationTable,
  skillProfessionalDimensionTable,
  skillProfessionalDimensionTranslationTable
} from '@data/db/schemas/skillCatalog'
import { loggerService } from '@logger'
import { skillService } from '@main/ai/skills/SkillService'
import { BaseService, DependsOn, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import type { SkillCatalogFacet, SkillCatalogItem, SkillCatalogResponse } from '@shared/data/api/schemas/skillCatalog'
import {
  type CatalogLocale,
  DEFAULT_CATALOG_LOCALE,
  RelativePathSchema,
  type SkillCatalogSnapshot,
  validateSkillCatalog
} from '@shared/types/skillCatalog'
import { asc, eq } from 'drizzle-orm'
import { app } from 'electron'

const logger = loggerService.withContext('SkillCatalogService')
const ACTIVE_STATE_ID = 'active'

function hashBuffer(buffer: Buffer): string {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`
}

function resolveSnapshotFileUrl(root: string, location: string, expectedHash: string): string | null {
  try {
    const relative = RelativePathSchema.parse(location)
    const filePath = path.resolve(root, relative)
    if (filePath === root || !filePath.startsWith(root + path.sep)) return null
    const realRoot = fs.realpathSync(root)
    const realFile = fs.realpathSync(filePath)
    if (!realFile.startsWith(realRoot + path.sep)) return null
    const stat = fs.statSync(realFile)
    if (!stat.isFile() || hashBuffer(fs.readFileSync(realFile)) !== expectedHash) return null
    return pathToFileURL(realFile).href
  } catch {
    return null
  }
}

async function hashDirectory(directory: string): Promise<string> {
  const files: string[] = []
  const walk = async (current: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name)
      const stat = await fs.promises.lstat(entryPath)
      if (stat.isSymbolicLink()) throw new Error(`Catalog artifact contains a symlink: ${entryPath}`)
      if (stat.isDirectory()) await walk(entryPath)
      else if (stat.isFile()) files.push(entryPath)
      else throw new Error(`Catalog artifact contains an unsupported file: ${entryPath}`)
    }
  }
  await walk(directory)
  const hash = createHash('sha256')
  for (const relativePath of files.map((file) => path.relative(directory, file).split(path.sep).join('/')).sort()) {
    hash.update(relativePath)
    hash.update('\0')
    hash.update(await fs.promises.readFile(path.join(directory, relativePath)))
    hash.update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}

@Injectable('SkillCatalogService')
@DependsOn(['DbService'])
@ServicePhase(Phase.WhenReady)
export class SkillCatalogService extends BaseService {
  protected async onReady(): Promise<void> {
    await this.syncBundledSnapshot()
  }

  async syncBundledSnapshot(): Promise<boolean> {
    const root = path.resolve(application.getPath('feature.agents.skills.catalog'))
    const [manifestBuffer, catalogBuffer] = await Promise.all([
      fs.promises.readFile(path.join(root, 'manifest.json')),
      fs.promises.readFile(path.join(root, 'catalog.json'))
    ])
    const manifest = JSON.parse(manifestBuffer.toString('utf8'))
    const snapshot = JSON.parse(catalogBuffer.toString('utf8'))
    const validated = validateSkillCatalog(manifest, snapshot, { currentAppVersion: app.getVersion() })
    if (!validated.ok) throw new Error(`Invalid bundled skill catalog: ${validated.errors.join('; ')}`)

    const contentHash = hashBuffer(catalogBuffer)
    if (validated.manifest.files['catalog.json'] !== contentHash) {
      throw new Error('Bundled skill catalog hash does not match manifest')
    }

    const db = application.get('DbService').getDb()
    const current = db
      .select()
      .from(skillCatalogSyncStateTable)
      .where(eq(skillCatalogSyncStateTable.id, ACTIVE_STATE_ID))
      .get()
    if (
      current?.status === 'ready' &&
      current.snapshotSource === 'bundled' &&
      current.schemaVersion === validated.manifest.schemaVersion &&
      current.revision === validated.manifest.revision &&
      current.contentHash === contentHash
    ) {
      return false
    }

    this.replaceMirror(validated.snapshot, contentHash)
    logger.info('Bundled skill catalog mirrored', {
      revision: validated.snapshot.revision,
      skillCount: validated.snapshot.skills.length
    })
    return true
  }

  list(locale: CatalogLocale): SkillCatalogResponse {
    const db = application.get('DbService').getDb()
    const translate = <T extends { locale: string }>(rows: T[]): T | undefined =>
      rows.find((row) => row.locale === locale) ?? rows.find((row) => row.locale === DEFAULT_CATALOG_LOCALE)

    const industryRows = db.select().from(skillIndustryTable).orderBy(asc(skillIndustryTable.sortOrder)).all()
    const industryTranslations = db.select().from(skillIndustryTranslationTable).all()
    const industries = industryRows.flatMap((row): SkillCatalogFacet[] => {
      if (!row.isEnabled) return []
      const text = translate(industryTranslations.filter((item) => item.industryCode === row.code))
      return text ? [{ code: row.code, name: text.name }] : []
    })
    const industryByCode = new Map(industries.map((item) => [item.code, item]))

    const dimensionRows = db
      .select()
      .from(skillProfessionalDimensionTable)
      .orderBy(asc(skillProfessionalDimensionTable.sortOrder))
      .all()
    const dimensionTranslations = db.select().from(skillProfessionalDimensionTranslationTable).all()
    const professionalDimensions = dimensionRows.flatMap((row): SkillCatalogFacet[] => {
      if (!row.isEnabled) return []
      const text = translate(dimensionTranslations.filter((item) => item.professionalDimensionCode === row.code))
      return text ? [{ code: row.code, name: text.name }] : []
    })
    const dimensionByCode = new Map(professionalDimensions.map((item) => [item.code, item]))

    const translations = db.select().from(skillCatalogTranslationTable).all()
    const skillIndustries = db.select().from(skillCatalogIndustryTable).all()
    const skillDimensions = db.select().from(skillCatalogProfessionalDimensionTable).all()
    const installed = db
      .select({
        id: agentGlobalSkillTable.id,
        catalogSkillId: agentGlobalSkillTable.catalogSkillId,
        version: agentGlobalSkillTable.catalogVersion
      })
      .from(agentGlobalSkillTable)
      .all()
    const installedByCatalogId = new Map(
      installed.flatMap((item) => (item.catalogSkillId ? [[item.catalogSkillId, item]] : []))
    )
    const snapshotRoot = path.resolve(application.getPath('feature.agents.skills.catalog'))

    const skills = db
      .select()
      .from(skillCatalogTable)
      .where(eq(skillCatalogTable.status, 'published'))
      .orderBy(asc(skillCatalogTable.sortOrder))
      .all()
      .flatMap((row): SkillCatalogItem[] => {
        const text = translate(translations.filter((item) => item.skillId === row.id))
        if (!text) return []
        const installedSkill = installedByCatalogId.get(row.id)
        const installState = !installedSkill
          ? 'not-installed'
          : installedSkill.version === row.artifact.version
            ? 'installed'
            : 'update-available'
        return [
          {
            id: row.id,
            name: text.name,
            description: text.description,
            version: row.artifact.version,
            industryScope: row.industryScope,
            industries: skillIndustries
              .filter((item) => item.skillId === row.id)
              .flatMap((item) => industryByCode.get(item.industryCode) ?? []),
            professionalDimensions: skillDimensions
              .filter((item) => item.skillId === row.id)
              .flatMap((item) => dimensionByCode.get(item.professionalDimensionCode) ?? []),
            logoUrl: row.logo ? resolveSnapshotFileUrl(snapshotRoot, row.logo.location, row.logo.sha256) : null,
            installState,
            installedSkillId: installedSkill?.id ?? null
          }
        ]
      })

    return { industries, professionalDimensions, skills }
  }

  async install(catalogSkillId: string): Promise<string> {
    const db = application.get('DbService').getDb()
    const state = db
      .select()
      .from(skillCatalogSyncStateTable)
      .where(eq(skillCatalogSyncStateTable.id, ACTIVE_STATE_ID))
      .get()
    const catalogSkill = db.select().from(skillCatalogTable).where(eq(skillCatalogTable.id, catalogSkillId)).get()
    if (!state || state.status !== 'ready' || !catalogSkill || catalogSkill.status !== 'published') {
      throw new Error(`Catalog skill is unavailable: ${catalogSkillId}`)
    }
    if (catalogSkill.snapshotSource !== state.snapshotSource || catalogSkill.catalogRevision !== state.revision) {
      throw new Error(`Catalog skill is not part of the active snapshot: ${catalogSkillId}`)
    }

    const root = path.resolve(application.getPath('feature.agents.skills.catalog'))
    const relative = RelativePathSchema.parse(catalogSkill.artifact.location)
    const artifactPath = path.resolve(root, relative)
    if (artifactPath !== root && !artifactPath.startsWith(root + path.sep))
      throw new Error('Catalog artifact escapes snapshot root')
    const realRoot = await fs.promises.realpath(root)
    const realArtifact = await fs.promises.realpath(artifactPath)
    if (realArtifact !== realRoot && !realArtifact.startsWith(realRoot + path.sep)) {
      throw new Error('Catalog artifact resolves outside snapshot root')
    }
    if (catalogSkill.artifact.type !== 'directory') throw new Error('Archive catalog artifacts are not supported yet')
    if ((await hashDirectory(realArtifact)) !== catalogSkill.artifact.sha256) {
      throw new Error(`Catalog artifact hash mismatch: ${catalogSkillId}`)
    }

    const translations = db
      .select()
      .from(skillCatalogTranslationTable)
      .where(eq(skillCatalogTranslationTable.skillId, catalogSkillId))
      .all()
    const zh = translations.find((item) => item.locale === 'zh-CN')
    const en = translations.find((item) => item.locale === 'en-US')
    const fallback = zh ?? en
    if (!fallback) throw new Error(`Catalog skill has no display metadata: ${catalogSkillId}`)

    const installed = await skillService.installFromCatalog(
      realArtifact,
      catalogSkillId,
      catalogSkill.artifact.version,
      {
        displayName: zh?.name ?? fallback.name,
        displayNameEn: en?.name ?? fallback.name,
        description: zh?.description ?? fallback.description,
        descriptionEn: en?.description ?? fallback.description
      }
    )
    return installed.id
  }

  private replaceMirror(snapshot: SkillCatalogSnapshot, contentHash: string): void {
    application.get('DbService').withWriteTx((tx) => {
      tx.delete(skillCatalogSyncStateTable).run()
      tx.delete(skillCatalogTable).run()
      tx.delete(skillIndustryTable).run()
      tx.delete(skillProfessionalDimensionTable).run()

      if (snapshot.industries.length) {
        tx.insert(skillIndustryTable)
          .values(
            snapshot.industries.map((item) => ({
              code: item.code,
              sortOrder: item.sortOrder,
              isEnabled: item.isEnabled
            }))
          )
          .run()
        const translations = snapshot.industries.flatMap((item) =>
          Object.entries(item.translations).flatMap(([locale, text]) =>
            text ? [{ industryCode: item.code, locale, name: text.name }] : []
          )
        )
        if (translations.length) tx.insert(skillIndustryTranslationTable).values(translations).run()
      }

      if (snapshot.professionalDimensions.length) {
        tx.insert(skillProfessionalDimensionTable)
          .values(
            snapshot.professionalDimensions.map((item) => ({
              code: item.code,
              sortOrder: item.sortOrder,
              isEnabled: item.isEnabled
            }))
          )
          .run()
        const translations = snapshot.professionalDimensions.flatMap((item) =>
          Object.entries(item.translations).flatMap(([locale, text]) =>
            text ? [{ professionalDimensionCode: item.code, locale, name: text.name }] : []
          )
        )
        if (translations.length) tx.insert(skillProfessionalDimensionTranslationTable).values(translations).run()
      }

      if (snapshot.skills.length) {
        tx.insert(skillCatalogTable)
          .values(
            snapshot.skills.map((item) => ({
              id: item.id,
              industryScope: item.industryScope,
              logo: item.logo,
              artifact: item.artifact,
              status: item.status,
              sortOrder: item.sortOrder,
              snapshotSource: 'bundled' as const,
              catalogRevision: snapshot.revision
            }))
          )
          .run()
        const translations = snapshot.skills.flatMap((item) =>
          Object.entries(item.translations).flatMap(([locale, text]) =>
            text ? [{ skillId: item.id, locale, name: text.name, description: text.description }] : []
          )
        )
        if (translations.length) tx.insert(skillCatalogTranslationTable).values(translations).run()
        const industries = snapshot.skills.flatMap((item) =>
          item.industryCodes.map((industryCode) => ({ skillId: item.id, industryCode }))
        )
        if (industries.length) tx.insert(skillCatalogIndustryTable).values(industries).run()
        const dimensions = snapshot.skills.flatMap((item) =>
          item.professionalDimensionCodes.map((professionalDimensionCode) => ({
            skillId: item.id,
            professionalDimensionCode
          }))
        )
        if (dimensions.length) tx.insert(skillCatalogProfessionalDimensionTable).values(dimensions).run()
      }

      tx.insert(skillCatalogSyncStateTable)
        .values({
          id: ACTIVE_STATE_ID,
          snapshotSource: 'bundled',
          schemaVersion: snapshot.schemaVersion,
          revision: snapshot.revision,
          contentHash,
          syncedAt: Date.now(),
          status: 'ready',
          errorMessage: null
        })
        .run()
    })
  }
}
