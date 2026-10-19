import fs from 'node:fs'
import path from 'node:path'

import Database from 'better-sqlite3'

import { loggerService } from '@logger'
import { checkpointTruncateAssert } from '@main/data/db/restore/checkpoint'

const logger = loggerService.withContext('BrandDataFileMigration')

const LEGACY_DATABASE_NAME = 'cherrystudio.sqlite'
const BRANDED_DATABASE_NAME = 'meacowork.sqlite'
const LEGACY_CREDENTIALS_NAME = 'cherry-account.json'
const BRANDED_CREDENTIALS_NAME = 'meacowork-account.json'
const SQLITE_SIDECARS = ['-wal', '-shm', '-journal'] as const

export class BrandDataFileMigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BrandDataFileMigrationError'
  }
}

function assertNoConflict(legacyPath: string, brandedPath: string, label: string): void {
  if (fs.existsSync(legacyPath) && fs.existsSync(brandedPath)) {
    throw new BrandDataFileMigrationError(
      `Both legacy and branded ${label} files exist; refusing to overwrite either file`
    )
  }
}

function syncParentDirectory(filePath: string): void {
  if (process.platform === 'win32') return
  const fd = fs.openSync(path.dirname(filePath), 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function migrateDatabase(userData: string): boolean {
  const dataDirectory = path.join(userData, 'Data')
  const legacyPath = path.join(dataDirectory, LEGACY_DATABASE_NAME)
  const brandedPath = path.join(dataDirectory, BRANDED_DATABASE_NAME)
  if (!fs.existsSync(legacyPath)) return false

  const sqlite = new Database(legacyPath, { fileMustExist: true })
  try {
    checkpointTruncateAssert(sqlite)
    const integrity = String(sqlite.pragma('integrity_check', { simple: true }))
    if (integrity !== 'ok') throw new Error(`Legacy SQLite integrity check failed: ${integrity}`)
  } finally {
    sqlite.close()
  }

  fs.renameSync(legacyPath, brandedPath)
  for (const suffix of SQLITE_SIDECARS) fs.rmSync(`${legacyPath}${suffix}`, { force: true })
  syncParentDirectory(brandedPath)
  return true
}

function migrateCredentials(userData: string): boolean {
  const credentialsDirectory = path.join(userData, 'Credentials')
  const legacyPath = path.join(credentialsDirectory, LEGACY_CREDENTIALS_NAME)
  const brandedPath = path.join(credentialsDirectory, BRANDED_CREDENTIALS_NAME)
  if (!fs.existsSync(legacyPath)) return false

  fs.renameSync(legacyPath, brandedPath)
  syncParentDirectory(brandedPath)
  return true
}

export function migrateBrandDataFiles(userData: string): void {
  const legacyDatabase = path.join(userData, 'Data', LEGACY_DATABASE_NAME)
  const brandedDatabase = path.join(userData, 'Data', BRANDED_DATABASE_NAME)
  const legacyCredentials = path.join(userData, 'Credentials', LEGACY_CREDENTIALS_NAME)
  const brandedCredentials = path.join(userData, 'Credentials', BRANDED_CREDENTIALS_NAME)

  assertNoConflict(legacyDatabase, brandedDatabase, 'database')
  assertNoConflict(legacyCredentials, brandedCredentials, 'credential')

  try {
    const databaseMigrated = migrateDatabase(userData)
    const credentialsMigrated = migrateCredentials(userData)
    if (databaseMigrated || credentialsMigrated) {
      logger.info('Migrated legacy data files to MEA Cowork names', { databaseMigrated, credentialsMigrated })
    }
  } catch (error) {
    if (error instanceof BrandDataFileMigrationError) throw error
    throw new BrandDataFileMigrationError(`Failed to migrate legacy data files in ${userData}`, {
      cause: error
    })
  }
}
