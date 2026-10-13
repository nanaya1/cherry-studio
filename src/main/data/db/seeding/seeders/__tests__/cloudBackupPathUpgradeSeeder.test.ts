import { setupTestDatabase } from '@test-helpers/db'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { preferenceTable } from '@data/db/schemas/preference'
import { seeders } from '@data/db/seeding/seederRegistry'
import { SeedRunner } from '@data/db/seeding/SeedRunner'

const NUTSTORE_PATH_KEY = 'data.backup.nutstore.path'
const WEBDAV_PATH_KEY = 'data.backup.webdav.path'
const CLOUD_BACKUP_PATH_SEEDERS = seeders.filter(
  ({ name }) => name === 'cloudBackupPathUpgrade' || name === 'preference'
)

describe('CloudBackupPathUpgradeSeeder', () => {
  const dbh = setupTestDatabase()

  const readPreference = (key: string) =>
    dbh.db
      .select({ value: preferenceTable.value })
      .from(preferenceTable)
      .where(and(eq(preferenceTable.scope, 'default'), eq(preferenceTable.key, key)))
      .get()?.value

  const writePreference = (key: string, value: string) => {
    dbh.db
      .insert(preferenceTable)
      .values({ scope: 'default', key, value })
      .onConflictDoUpdate({
        target: [preferenceTable.scope, preferenceTable.key],
        set: { value }
      })
      .run()
  }

  it('replaces persisted Cherry Studio cloud backup paths', () => {
    writePreference(NUTSTORE_PATH_KEY, '/cherry-studio')
    writePreference(WEBDAV_PATH_KEY, '/cherry-studio')

    new SeedRunner(dbh.db).runAll(CLOUD_BACKUP_PATH_SEEDERS)

    expect(readPreference(NUTSTORE_PATH_KEY)).toBe('/meacowork')
    expect(readPreference(WEBDAV_PATH_KEY)).toBe('/meacowork')
  })

  it('does not overwrite custom cloud backup paths', () => {
    writePreference(NUTSTORE_PATH_KEY, '/personal/nutstore')
    writePreference(WEBDAV_PATH_KEY, '/personal/webdav')

    new SeedRunner(dbh.db).runAll(CLOUD_BACKUP_PATH_SEEDERS)

    expect(readPreference(NUTSTORE_PATH_KEY)).toBe('/personal/nutstore')
    expect(readPreference(WEBDAV_PATH_KEY)).toBe('/personal/webdav')
  })

  it('does not overwrite later user choices when seeders run again', () => {
    writePreference(NUTSTORE_PATH_KEY, '/cherry-studio')
    const runner = new SeedRunner(dbh.db)

    runner.runAll(CLOUD_BACKUP_PATH_SEEDERS)
    expect(readPreference(NUTSTORE_PATH_KEY)).toBe('/meacowork')

    writePreference(NUTSTORE_PATH_KEY, '/new-location')
    runner.runAll(CLOUD_BACKUP_PATH_SEEDERS)

    expect(readPreference(NUTSTORE_PATH_KEY)).toBe('/new-location')
  })
})
