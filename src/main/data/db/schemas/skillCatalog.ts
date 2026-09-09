/**
 * Skill catalog mirror tables.
 *
 * These describe the currently synced, publishable catalog (skills, industries,
 * professional dimensions and their relations) plus the single-row sync state.
 * They are written only by the catalog synchronizer from a validated snapshot;
 * the renderer never writes them directly. They are independent of
 * `agent_global_skill`, which records what the user has actually installed.
 */

import type {
  CatalogSkillStatus,
  IndustryScope,
  SkillArtifact,
  SkillLogo,
  SnapshotSource,
  SyncStateStatus
} from '@shared/types/skillCatalog'
import { sql } from 'drizzle-orm'
import { check, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { createUpdateTimestamps } from './_columnHelpers'

// ============================================================================
// Industries
// ============================================================================

export const skillIndustryTable = sqliteTable(
  'skill_industry',
  {
    /** Stable industry code — the catalog's primary key, not a generated id. */
    code: text('code').primaryKey(),
    sortOrder: integer('sort_order').notNull(),
    isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(true),
    ...createUpdateTimestamps
  },
  (t) => [index('skill_industry_is_enabled_idx').on(t.isEnabled)]
)

export type SkillIndustryRow = typeof skillIndustryTable.$inferSelect
export type InsertSkillIndustryRow = typeof skillIndustryTable.$inferInsert

export const skillIndustryTranslationTable = sqliteTable(
  'skill_industry_translation',
  {
    industryCode: text('industry_code')
      .notNull()
      .references(() => skillIndustryTable.code, { onDelete: 'cascade' }),
    locale: text().notNull(),
    name: text().notNull()
  },
  (t) => [primaryKey({ columns: [t.industryCode, t.locale] })]
)

export type SkillIndustryTranslationRow = typeof skillIndustryTranslationTable.$inferSelect
export type InsertSkillIndustryTranslationRow = typeof skillIndustryTranslationTable.$inferInsert

// ============================================================================
// Professional dimensions
// ============================================================================

export const skillProfessionalDimensionTable = sqliteTable(
  'skill_professional_dimension',
  {
    /** Stable professional dimension code — the catalog's primary key. */
    code: text('code').primaryKey(),
    sortOrder: integer('sort_order').notNull(),
    isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(true),
    ...createUpdateTimestamps
  },
  (t) => [index('skill_professional_dimension_is_enabled_idx').on(t.isEnabled)]
)

export type SkillProfessionalDimensionRow = typeof skillProfessionalDimensionTable.$inferSelect
export type InsertSkillProfessionalDimensionRow = typeof skillProfessionalDimensionTable.$inferInsert

export const skillProfessionalDimensionTranslationTable = sqliteTable(
  'skill_professional_dimension_translation',
  {
    professionalDimensionCode: text('professional_dimension_code')
      .notNull()
      .references(() => skillProfessionalDimensionTable.code, { onDelete: 'cascade' }),
    locale: text().notNull(),
    name: text().notNull()
  },
  (t) => [primaryKey({ columns: [t.professionalDimensionCode, t.locale] })]
)

export type SkillProfessionalDimensionTranslationRow = typeof skillProfessionalDimensionTranslationTable.$inferSelect
export type InsertSkillProfessionalDimensionTranslationRow =
  typeof skillProfessionalDimensionTranslationTable.$inferInsert

// ============================================================================
// Skills
// ============================================================================

export const skillCatalogTable = sqliteTable(
  'skill_catalog',
  {
    /** Stable catalog id — the catalog's primary key, distinct from an installed skill's id. */
    id: text('id').primaryKey(),
    industryScope: text('industry_scope').$type<IndustryScope>().notNull(),
    /** Logo descriptor JSON; null when the skill has no logo. */
    logo: text({ mode: 'json' }).$type<SkillLogo | null>(),
    /** Install artifact descriptor JSON — always present and validated by the protocol. */
    artifact: text({ mode: 'json' }).$type<SkillArtifact>().notNull(),
    status: text().$type<CatalogSkillStatus>().notNull(),
    sortOrder: integer('sort_order').notNull(),
    /** Which release chain produced this mirrored row. */
    snapshotSource: text('snapshot_source').$type<SnapshotSource>().notNull(),
    /** The snapshot revision that produced this row. */
    catalogRevision: integer('catalog_revision').notNull(),
    ...createUpdateTimestamps
  },
  (t) => [
    check('skill_catalog_scope_check', sql`${t.industryScope} IN ('universal', 'specific')`),
    check('skill_catalog_status_check', sql`${t.status} IN ('draft', 'published', 'disabled')`),
    check('skill_catalog_source_check', sql`${t.snapshotSource} IN ('bundled', 'override')`),
    index('skill_catalog_status_idx').on(t.status),
    index('skill_catalog_snapshot_source_idx').on(t.snapshotSource)
  ]
)

export type SkillCatalogRow = typeof skillCatalogTable.$inferSelect
export type InsertSkillCatalogRow = typeof skillCatalogTable.$inferInsert

export const skillCatalogTranslationTable = sqliteTable(
  'skill_catalog_translation',
  {
    skillId: text('skill_id')
      .notNull()
      .references(() => skillCatalogTable.id, { onDelete: 'cascade' }),
    locale: text().notNull(),
    name: text().notNull(),
    description: text().notNull()
  },
  (t) => [primaryKey({ columns: [t.skillId, t.locale] })]
)

export type SkillCatalogTranslationRow = typeof skillCatalogTranslationTable.$inferSelect
export type InsertSkillCatalogTranslationRow = typeof skillCatalogTranslationTable.$inferInsert

// ============================================================================
// Relations (queryable, not opaque JSON arrays)
// ============================================================================

export const skillCatalogIndustryTable = sqliteTable(
  'skill_catalog_industry',
  {
    skillId: text('skill_id')
      .notNull()
      .references(() => skillCatalogTable.id, { onDelete: 'cascade' }),
    industryCode: text('industry_code')
      .notNull()
      .references(() => skillIndustryTable.code, { onDelete: 'cascade' })
  },
  (t) => [
    primaryKey({ columns: [t.skillId, t.industryCode] }),
    index('skill_catalog_industry_skill_id_idx').on(t.skillId),
    index('skill_catalog_industry_industry_code_idx').on(t.industryCode)
  ]
)

export type SkillCatalogIndustryRow = typeof skillCatalogIndustryTable.$inferSelect
export type InsertSkillCatalogIndustryRow = typeof skillCatalogIndustryTable.$inferInsert

export const skillCatalogProfessionalDimensionTable = sqliteTable(
  'skill_catalog_professional_dimension',
  {
    skillId: text('skill_id')
      .notNull()
      .references(() => skillCatalogTable.id, { onDelete: 'cascade' }),
    professionalDimensionCode: text('professional_dimension_code')
      .notNull()
      .references(() => skillProfessionalDimensionTable.code, { onDelete: 'cascade' })
  },
  (t) => [
    primaryKey({ columns: [t.skillId, t.professionalDimensionCode] }),
    index('skill_catalog_pd_skill_id_idx').on(t.skillId),
    index('skill_catalog_pd_code_idx').on(t.professionalDimensionCode)
  ]
)

export type SkillCatalogProfessionalDimensionRow = typeof skillCatalogProfessionalDimensionTable.$inferSelect
export type InsertSkillCatalogProfessionalDimensionRow = typeof skillCatalogProfessionalDimensionTable.$inferInsert

// ============================================================================
// Sync state (single row identifying the active mirrored snapshot)
// ============================================================================

export const skillCatalogSyncStateTable = sqliteTable(
  'skill_catalog_sync_state',
  {
    /** Fixed singleton key, e.g. `'active'`. */
    id: text('id').primaryKey(),
    snapshotSource: text('snapshot_source').$type<SnapshotSource>().notNull(),
    schemaVersion: integer('schema_version').notNull(),
    revision: integer('revision').notNull(),
    contentHash: text('content_hash').notNull(),
    /** Epoch millis of the last successful (or failed) sync attempt. */
    syncedAt: integer('synced_at').notNull(),
    status: text().$type<SyncStateStatus>().notNull(),
    errorMessage: text('error_message')
  },
  (t) => [
    check('skill_catalog_sync_state_source_check', sql`${t.snapshotSource} IN ('bundled', 'override')`),
    check('skill_catalog_sync_state_status_check', sql`${t.status} IN ('ready', 'failed')`)
  ]
)

export type SkillCatalogSyncStateRow = typeof skillCatalogSyncStateTable.$inferSelect
export type InsertSkillCatalogSyncStateRow = typeof skillCatalogSyncStateTable.$inferInsert
