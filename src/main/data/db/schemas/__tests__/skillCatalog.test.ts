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
import { setupTestDatabase } from '@test-helpers/db'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

const DIGEST = `sha256:${'a'.repeat(64)}`

describe('skill_catalog mirror', () => {
  const dbh = setupTestDatabase()

  const seedIndustry = (code: string) =>
    dbh.db.insert(skillIndustryTable).values({ code, sortOrder: 10, isEnabled: true }).run()

  const seedDimension = (code: string) =>
    dbh.db.insert(skillProfessionalDimensionTable).values({ code, sortOrder: 10, isEnabled: true }).run()

  const seedSkill = (id: string, over: Partial<typeof skillCatalogTable.$inferInsert> = {}) =>
    dbh.db
      .insert(skillCatalogTable)
      .values({
        id,
        industryScope: 'universal',
        logo: { type: 'snapshot', location: 'logos/x.png', sha256: DIGEST },
        artifact: { type: 'directory', location: 'packages/x', version: '1.0.0', sha256: DIGEST },
        status: 'published',
        sortOrder: 10,
        snapshotSource: 'bundled',
        catalogRevision: 1,
        ...over
      })
      .run()

  it('rejects a duplicate skill+locale translation (composite PK)', () => {
    seedSkill('browser-use')
    const row = { skillId: 'browser-use', locale: 'zh-CN', name: '浏览器使用', description: 'd' }
    dbh.db.insert(skillCatalogTranslationTable).values(row).run()
    expect(() => dbh.db.insert(skillCatalogTranslationTable).values(row).run()).toThrow()
  })

  it('rejects a duplicate industry_code+locale translation (composite PK)', () => {
    seedIndustry('aerospace')
    const row = { industryCode: 'aerospace', locale: 'zh-CN', name: '航空航天' }
    dbh.db.insert(skillIndustryTranslationTable).values(row).run()
    expect(() => dbh.db.insert(skillIndustryTranslationTable).values(row).run()).toThrow()
  })

  it('rejects a duplicate professional_dimension_code+locale translation (composite PK)', () => {
    seedDimension('research-design')
    const row = { professionalDimensionCode: 'research-design', locale: 'zh-CN', name: '研发设计' }
    dbh.db.insert(skillProfessionalDimensionTranslationTable).values(row).run()
    expect(() => dbh.db.insert(skillProfessionalDimensionTranslationTable).values(row).run()).toThrow()
  })

  it('rejects a duplicate skill+industry relation (composite PK)', () => {
    seedSkill('browser-use')
    seedIndustry('aerospace')
    const row = { skillId: 'browser-use', industryCode: 'aerospace' }
    dbh.db.insert(skillCatalogIndustryTable).values(row).run()
    expect(() => dbh.db.insert(skillCatalogIndustryTable).values(row).run()).toThrow()
  })

  it('rejects a duplicate skill+professionalDimension relation (composite PK)', () => {
    seedSkill('browser-use')
    seedDimension('research-design')
    const row = { skillId: 'browser-use', professionalDimensionCode: 'research-design' }
    dbh.db.insert(skillCatalogProfessionalDimensionTable).values(row).run()
    expect(() => dbh.db.insert(skillCatalogProfessionalDimensionTable).values(row).run()).toThrow()
  })

  it('round-trips logo and artifact JSON as typed objects', () => {
    seedSkill('browser-use')
    const [row] = dbh.db.select().from(skillCatalogTable).where(eq(skillCatalogTable.id, 'browser-use')).all()
    expect(row.logo).toEqual({ type: 'snapshot', location: 'logos/x.png', sha256: DIGEST })
    expect(row.artifact).toMatchObject({ type: 'directory', location: 'packages/x', version: '1.0.0' })
    expect(row.artifact.sha256).toBe(DIGEST)
  })

  it('stores a null logo', () => {
    seedSkill('no-logo', { logo: null })
    const [row] = dbh.db.select().from(skillCatalogTable).where(eq(skillCatalogTable.id, 'no-logo')).all()
    expect(row.logo).toBeNull()
  })

  it('cascades skill deletion to its translations and relations', () => {
    seedSkill('browser-use')
    seedIndustry('aerospace')
    seedDimension('research-design')
    dbh.db
      .insert(skillCatalogTranslationTable)
      .values({ skillId: 'browser-use', locale: 'zh-CN', name: '浏览器使用', description: 'd' })
      .run()
    dbh.db.insert(skillCatalogIndustryTable).values({ skillId: 'browser-use', industryCode: 'aerospace' }).run()
    dbh.db
      .insert(skillCatalogProfessionalDimensionTable)
      .values({ skillId: 'browser-use', professionalDimensionCode: 'research-design' })
      .run()

    dbh.db.delete(skillCatalogTable).where(eq(skillCatalogTable.id, 'browser-use')).run()

    expect(dbh.db.select().from(skillCatalogTranslationTable).all()).toHaveLength(0)
    expect(dbh.db.select().from(skillCatalogIndustryTable).all()).toHaveLength(0)
    expect(dbh.db.select().from(skillCatalogProfessionalDimensionTable).all()).toHaveLength(0)
  })

  it('records the single active sync state', () => {
    dbh.db
      .insert(skillCatalogSyncStateTable)
      .values({
        id: 'active',
        snapshotSource: 'bundled',
        schemaVersion: 1,
        revision: 1,
        contentHash: DIGEST,
        syncedAt: 123,
        status: 'ready'
      })
      .run()

    const [row] = dbh.db.select().from(skillCatalogSyncStateTable).all()
    expect(row.id).toBe('active')
    expect(row.status).toBe('ready')
    expect(row.snapshotSource).toBe('bundled')
  })
})

describe('agent_global_skill catalog linkage', () => {
  const dbh = setupTestDatabase()

  const insertInstalled = (catalogSkillId: string | null) =>
    dbh.db
      .insert(agentGlobalSkillTable)
      .values({
        name: 'Browser Use',
        folderName: `folder-${catalogSkillId ?? 'local'}`,
        source: catalogSkillId ? 'catalog' : 'local',
        sourceUrl: catalogSkillId ? `catalog:${catalogSkillId}` : null,
        contentHash: 'sha256:x',
        catalogSkillId,
        catalogVersion: catalogSkillId ? '1.0.0' : null
      })
      .run()

  it('allows a non-catalog (local) skill with a null catalog_skill_id', () => {
    expect(() => insertInstalled(null)).not.toThrow()
  })

  it('rejects two installed skills sharing the same catalog_skill_id', () => {
    insertInstalled('browser-use')
    expect(() => insertInstalled('browser-use')).toThrow()
  })
})
