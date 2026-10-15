import Database from 'better-sqlite3'

import { SAFE_IMPORT_TARGET_NOT_EMPTY_ERROR_CODE } from '@shared/types/backup'

export function assertSafeImportTargetEmpty(databasePath: string): void {
  const sqlite = new Database(databasePath, { readonly: true, fileMustExist: true })
  try {
    const tables = sqlite
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%'
           AND name <> '__drizzle_migrations'
         ORDER BY name`
      )
      .pluck()
      .all() as string[]

    for (const table of tables) {
      const quotedTable = `"${table.replaceAll('"', '""')}"`
      if (sqlite.prepare(`SELECT 1 FROM ${quotedTable} LIMIT 1`).get() !== undefined) {
        throw new Error(
          `${SAFE_IMPORT_TARGET_NOT_EMPTY_ERROR_CODE}: Safe import requires an empty business profile and will not replace existing data.`
        )
      }
    }
  } finally {
    sqlite.close()
  }
}
