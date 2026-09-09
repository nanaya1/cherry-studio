import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

import { createUpdateTimestamps, uuidPrimaryKey } from './_columnHelpers'

export const agentGlobalSkillTable = sqliteTable(
  'agent_global_skill',
  {
    id: uuidPrimaryKey(),
    name: text().notNull(),
    displayName: text(),
    displayNameEn: text(),
    description: text(),
    descriptionEn: text(),
    folderName: text().notNull(),
    source: text().notNull(),
    sourceUrl: text(),
    namespace: text(),
    author: text(),
    version: text(),
    iconFileName: text(),
    /** Stable catalog skill id when this skill was installed from the catalog; null for other sources. */
    catalogSkillId: text('catalog_skill_id'),
    /** Catalog artifact version recorded at install/update time. */
    catalogVersion: text('catalog_version'),
    tags: text({ mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    contentHash: text().notNull(),
    isEnabled: integer({ mode: 'boolean' }).notNull().default(false),
    ...createUpdateTimestamps
  },
  (t) => [
    uniqueIndex('agent_global_skill_folder_name_unique').on(t.folderName),
    uniqueIndex('agent_global_skill_catalog_skill_id_unique').on(t.catalogSkillId),
    index('agent_global_skill_source_idx').on(t.source),
    index('agent_global_skill_is_enabled_idx').on(t.isEnabled)
  ]
)

export type AgentGlobalSkillRow = typeof agentGlobalSkillTable.$inferSelect
export type InsertAgentGlobalSkillRow = typeof agentGlobalSkillTable.$inferInsert
