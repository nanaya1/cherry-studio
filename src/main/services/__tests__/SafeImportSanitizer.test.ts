import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

import { sanitizeSafeImportDatabase } from '../SafeImportSanitizer'
import { assertSafeImportTargetEmpty } from '../SafeImportTarget'

const directories: string[] = []

function createDatabase(): { file: string; db: Database.Database } {
  const directory = mkdtempSync(path.join(tmpdir(), 'safe-import-'))
  directories.push(directory)
  const file = path.join(directory, 'import.sqlite')
  const db = new Database(file)
  db.exec(`
    CREATE TABLE user_provider (provider_id TEXT PRIMARY KEY, name TEXT, api_keys TEXT, auth_config TEXT);
    CREATE TABLE remote_knowledge_service (id TEXT PRIMARY KEY, api_key_encrypted TEXT);
    CREATE TABLE preference (scope TEXT, key TEXT, value TEXT, PRIMARY KEY (scope, key));
    CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)
  return { file, db }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('assertSafeImportTargetEmpty', () => {
  it('accepts a migrated database that contains only migration metadata', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'safe-import-empty-'))
    directories.push(directory)
    const file = path.join(directory, 'empty.sqlite')
    const db = new Database(file)
    db.exec(`
      CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT, created_at INTEGER);
      CREATE TABLE topic (id TEXT PRIMARY KEY);
      INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('hash', 1);
    `)
    db.close()

    expect(() => assertSafeImportTargetEmpty(file)).not.toThrow()
  })

  it('rejects a target database with any business row', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'safe-import-nonempty-'))
    directories.push(directory)
    const file = path.join(directory, 'nonempty.sqlite')
    const db = new Database(file)
    db.exec(`
      CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT, created_at INTEGER);
      CREATE TABLE topic (id TEXT PRIMARY KEY);
      INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('hash', 1);
      INSERT INTO topic VALUES ('existing-topic');
    `)
    db.close()

    expect(() => assertSafeImportTargetEmpty(file)).toThrow('SAFE_IMPORT_TARGET_NOT_EMPTY')
  })
})

describe('sanitizeSafeImportDatabase', () => {
  it('strips provider, remote knowledge, integration, backup, enterprise and profile secrets', () => {
    const { file, db } = createDatabase()
    db.prepare('INSERT INTO user_provider VALUES (?, ?, ?, ?)').run('p1', 'Provider', '["secret"]', '{"token":"x"}')
    db.prepare('INSERT INTO remote_knowledge_service VALUES (?, ?)').run('r1', 'encrypted-secret')
    const insertPreference = db.prepare('INSERT INTO preference VALUES (?, ?, ?)')
    insertPreference.run('default', 'data.backup.nutstore.token', '"secret"')
    insertPreference.run('default', 'data.integration.joplin.token', '"secret"')
    insertPreference.run('default', 'ui.theme.mode', '"dark"')
    db.prepare('INSERT INTO app_state VALUES (?, ?)').run('enterprise.session', '"secret"')
    db.prepare('INSERT INTO app_state VALUES (?, ?)').run('ordinary-state', '"kept"')
    db.close()

    sanitizeSafeImportDatabase(file)

    const sanitized = new Database(file, { readonly: true })
    expect(sanitized.prepare('SELECT api_keys, auth_config FROM user_provider').get()).toEqual({
      api_keys: '[]',
      auth_config: null
    })
    expect(sanitized.prepare('SELECT api_key_encrypted FROM remote_knowledge_service').get()).toEqual({
      api_key_encrypted: null
    })
    expect(sanitized.prepare('SELECT key FROM preference ORDER BY key').all()).toEqual([{ key: 'ui.theme.mode' }])
    expect(sanitized.prepare('SELECT key FROM app_state ORDER BY key').all()).toEqual([{ key: 'ordinary-state' }])
    sanitized.close()
  })

  it('fails closed without modifying the database when a required table is missing', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'safe-import-invalid-'))
    directories.push(directory)
    const file = path.join(directory, 'invalid.sqlite')
    const db = new Database(file)
    db.exec('CREATE TABLE ordinary (value TEXT); INSERT INTO ordinary VALUES (\'kept\');')
    db.close()

    expect(() => sanitizeSafeImportDatabase(file)).toThrow(/required table/i)

    const unchanged = new Database(file, { readonly: true })
    expect(unchanged.prepare('SELECT value FROM ordinary').pluck().all()).toEqual(['kept'])
    unchanged.close()
  })
})
