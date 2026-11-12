import { sql } from 'drizzle-orm'
// The one sanctioned call site: this module is what wraps migrate() in the foreign-key
// handling that the ban points every other caller to.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

import { loggerService } from '@logger'

import { CUSTOM_SQL_STATEMENTS } from './customSqls'
import type { DbType } from './types'

const logger = loggerService.withContext('applyMigrations')

const REMOTE_KNOWLEDGE_SCHEMA_REPAIR_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS \`agent_remote_knowledge_base\` (
    \`agent_id\` text NOT NULL,
    \`remote_base_id\` text NOT NULL,
    \`created_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL,
    PRIMARY KEY(\`agent_id\`, \`remote_base_id\`),
    FOREIGN KEY (\`agent_id\`) REFERENCES \`agent\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  `CREATE TABLE IF NOT EXISTS \`assistant_remote_knowledge_base\` (
    \`assistant_id\` text NOT NULL,
    \`remote_base_id\` text NOT NULL,
    \`created_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL,
    PRIMARY KEY(\`assistant_id\`, \`remote_base_id\`),
    FOREIGN KEY (\`assistant_id\`) REFERENCES \`assistant\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  `CREATE TABLE IF NOT EXISTS \`remote_knowledge_service\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`name\` text NOT NULL,
    \`base_url\` text NOT NULL,
    \`auth_type\` text DEFAULT 'bearer' NOT NULL,
    \`api_key_encrypted\` text,
    \`headers\` text,
    \`timeout_ms\` integer DEFAULT 30000 NOT NULL,
    \`enabled\` integer DEFAULT true NOT NULL,
    \`created_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL,
    CONSTRAINT "remote_knowledge_service_auth_type_check" CHECK("remote_knowledge_service"."auth_type" IN ('bearer', 'api_key', 'oauth2'))
  )`
] as const

/**
 * Apply drizzle migrations, then the custom SQL drizzle cannot manage
 * (FTS5 virtual tables, triggers — all idempotent, see customSqls.ts).
 *
 * Pure function over an injected connection so all three consumers share one
 * migration path: DbService.onInit (live DB), the test harness (throwaway DB),
 * and the backup restore pipeline (detached work.sqlite migrate-forward).
 */
export function applyMigrations(db: DbType, migrationsFolder: string): void {
  // SQLite cannot alter a table constraint in place, so drizzle-kit compiles any
  // constraint / column-type change into a table recreate (CREATE __new_x →
  // INSERT SELECT → DROP x → RENAME) guarded by its own `PRAGMA foreign_keys=OFF`.
  // That guard never takes effect: drizzle-orm's migrator wraps every statement in
  // one transaction, and SQLite documents the pragma as a no-op inside one — so the
  // DROP fires every child's ON DELETE action and silently takes their rows with it.
  // Toggling enforcement here, outside the migrator's transaction, is the only place
  // it actually applies.
  const enforced = isForeignKeysEnforced(db)
  db.run(sql.raw('PRAGMA foreign_keys = OFF'))
  try {
    migrate(db, { migrationsFolder })
  } finally {
    db.run(sql.raw(`PRAGMA foreign_keys = ${enforced ? 'ON' : 'OFF'}`))
  }

  // Enforcement was on before the call, so anything reported now is a dangling
  // reference the migration itself introduced. Boot must not be blocked over it —
  // applyMigrations is also the restore and test-harness path, and a hard failure
  // would be unrecoverable for the user — but it must never pass unremarked.
  if (enforced) {
    const violations = db.all(sql.raw('PRAGMA foreign_key_check'))
    if (violations.length > 0) {
      logger.error('Migration left dangling foreign key references', { violations })
    }
  }

  // MEA:remote-knowledge-schema-repair Repair databases whose migration cursor skipped 0031_busy_spot.
  for (const statement of REMOTE_KNOWLEDGE_SCHEMA_REPAIR_STATEMENTS) {
    db.run(sql.raw(statement))
  }

  for (const statement of CUSTOM_SQL_STATEMENTS) {
    db.run(sql.raw(statement))
  }
}

function isForeignKeysEnforced(db: DbType): boolean {
  const rows = db.all(sql.raw('PRAGMA foreign_keys')) as Array<{ foreign_keys?: number }>
  return Number(rows[0]?.foreign_keys ?? 0) === 1
}
