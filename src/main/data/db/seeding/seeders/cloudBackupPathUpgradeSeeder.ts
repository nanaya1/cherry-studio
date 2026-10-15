import { and, eq, inArray } from 'drizzle-orm'

import { preferenceTable } from '@data/db/schemas/preference'

import type { DbType, ISeeder } from '../../types'
import { hashObject } from '../hashObject'

const CLOUD_BACKUP_PATH_UPGRADE = {
  scope: 'default',
  keys: ['data.backup.nutstore.path', 'data.backup.webdav.path'],
  legacyPath: '/cherry-studio',
  nextPath: '/meacowork'
} as const

export class CloudBackupPathUpgradeSeeder implements ISeeder {
  readonly name = 'cloudBackupPathUpgrade'
  readonly description = 'Replace the legacy default cloud backup path'
  readonly version = hashObject(CLOUD_BACKUP_PATH_UPGRADE)

  run(db: DbType): void {
    db.update(preferenceTable)
      .set({ value: CLOUD_BACKUP_PATH_UPGRADE.nextPath })
      .where(
        and(
          eq(preferenceTable.scope, CLOUD_BACKUP_PATH_UPGRADE.scope),
          inArray(preferenceTable.key, CLOUD_BACKUP_PATH_UPGRADE.keys),
          eq(preferenceTable.value, CLOUD_BACKUP_PATH_UPGRADE.legacyPath)
        )
      )
      .run()
  }
}
