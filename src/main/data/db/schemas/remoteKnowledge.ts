import { sql } from 'drizzle-orm'
import { check, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import type { RemoteAuthType } from '@shared/data/types/remoteKnowledge'

import { agentTable } from './agent'
import { assistantTable } from './assistant'
import { createUpdateTimestamps, uuidPrimaryKey } from './_columnHelpers'

/**
 * A configured external knowledge service (provider-side retrieval). The API
 * key is stored as safeStorage ciphertext (base64); plaintext never reaches
 * the DB. Disabled services keep their row ( reversible pause); deleting the
 * row cascades binding cleanup in RemoteKnowledgeService.delete.
 */
export const remoteKnowledgeServiceTable = sqliteTable(
  'remote_knowledge_service',
  {
    id: uuidPrimaryKey(),
    name: text().notNull(),
    baseUrl: text().notNull(),
    authType: text().$type<RemoteAuthType>().notNull().default('bearer'),
    // safeStorage ciphertext (base64); NULL for services without a key.
    apiKeyEncrypted: text(),
    headers: text({ mode: 'json' }).$type<Record<string, string>>(),
    timeoutMs: integer().notNull().default(30_000),
    enabled: integer({ mode: 'boolean' }).notNull().default(true),
    ...createUpdateTimestamps
  },
  (t) => [check('remote_knowledge_service_auth_type_check', sql`${t.authType} IN ('bearer', 'api_key', 'oauth2')`)]
)

/**
 * Assistant-side remote base bindings. Unlike assistant_knowledge_base there
 * is NO foreign key to knowledge_base: the stored value is the full
 * `remote:{serviceId}:{remoteBaseId}` string, which is not a local row id.
 * Rows are removed when the owning assistant is deleted (assistant FK cascade)
 * and by RemoteKnowledgeService.delete when the service goes away.
 */
export const assistantRemoteKnowledgeBaseTable = sqliteTable(
  'assistant_remote_knowledge_base',
  {
    assistantId: text()
      .notNull()
      .references(() => assistantTable.id, { onDelete: 'cascade' }),
    remoteBaseId: text().notNull(),
    ...createUpdateTimestamps
  },
  (t) => [primaryKey({ columns: [t.assistantId, t.remoteBaseId] })]
)

/** Agent-side mirror of {@link assistantRemoteKnowledgeBaseTable}. */
export const agentRemoteKnowledgeBaseTable = sqliteTable(
  'agent_remote_knowledge_base',
  {
    agentId: text()
      .notNull()
      .references(() => agentTable.id, { onDelete: 'cascade' }),
    remoteBaseId: text().notNull(),
    ...createUpdateTimestamps
  },
  (t) => [primaryKey({ columns: [t.agentId, t.remoteBaseId] })]
)
