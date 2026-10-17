import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveMigrationsPath } from '@test-helpers/db/internal/migrationsPath'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { applyMigrations } from '@data/db/applyMigrations'
import { MESSAGE_FTS_STATEMENTS } from '@data/db/schemas/message'
import type { DbType } from '@data/db/types'

/**
 * Direct tests over a throwaway file-backed DB — deliberately NOT via
 * setupTestDatabase(): the harness itself delegates to applyMigrations,
 * so these tests must not run through the code under test's consumer.
 */

// Names of the FTS objects applyMigrations must create, extracted from the
// statements themselves so a schema rename cannot silently defang the assertion.
const ftsObjectNames = MESSAGE_FTS_STATEMENTS.flatMap((statement) => {
  const match = statement.match(/CREATE (?:VIRTUAL TABLE IF NOT EXISTS|TRIGGER)\s+(\w+)/)
  return match ? [match[1]] : []
})

/**
 * Later than every `when` in the production journal, so appended migrations
 * always sort after the shipped chain.
 */
const APPENDED_WHEN_BASE = 2_000_000_000_000

describe('applyMigrations', () => {
  let tempDir: string
  let sqlite: Database.Database
  let db: DbType

  /**
   * Copies the production chain into the temp dir so a synthetic migration can be
   * appended to it. The shipped chain is CREATE-only, so the table-recreate SQL
   * drizzle-kit emits for any constraint / column-type change would otherwise have
   * no coverage at all.
   */
  const stageMigrations = (): string => {
    const staged = join(tempDir, 'migrations')
    cpSync(resolveMigrationsPath(), staged, { recursive: true })
    return staged
  }

  const appendMigration = (staged: string, tag: string, statements: string[]): void => {
    const journalPath = join(staged, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf-8')) as {
      entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>
    }
    writeFileSync(join(staged, `${tag}.sql`), statements.join('\n--> statement-breakpoint\n'))
    journal.entries.push({
      idx: journal.entries.length,
      version: '6',
      when: APPENDED_WHEN_BASE + journal.entries.length,
      tag,
      breakpoints: true
    })
    writeFileSync(journalPath, JSON.stringify(journal))
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cs-apply-migrations-'))
    sqlite = new Database(join(tempDir, 'test.db'))
    sqlite.pragma('foreign_keys = ON')
    db = drizzle({ client: sqlite, casing: 'snake_case' })
  })

  afterEach(() => {
    sqlite.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('migrates an empty database to a healthy schema including FTS objects', () => {
    applyMigrations(db, resolveMigrationsPath())

    expect(String(sqlite.pragma('integrity_check', { simple: true }))).toBe('ok')

    const masterNames = (sqlite.prepare('SELECT name FROM sqlite_master').all() as Array<{ name: string }>).map(
      (row) => row.name
    )
    expect(masterNames).toContain('message')
    expect(ftsObjectNames.length).toBeGreaterThan(0)
    for (const name of ftsObjectNames) {
      expect(masterNames).toContain(name)
    }
  })

  it('repairs remote knowledge tables skipped by a later legacy migration timestamp without losing data', () => {
    const staged = stageMigrations()
    const journalPath = join(staged, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: Array<{ tag: string; when: number }>
    }
    const legacyTimestamp = 1789841624693
    const baseline = journal.entries.filter((entry) => entry.when < legacyTimestamp && entry.tag !== '0031_busy_spot')
    writeFileSync(journalPath, JSON.stringify({ ...journal, entries: baseline }))
    applyMigrations(db, staged)
    sqlite
      .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
      .run('legacy-release-migration', legacyTimestamp)
    sqlite
      .prepare(
        'INSERT INTO user_provider (provider_id, name, order_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run('existing', 'Existing provider', 'a0', 1000, 2000)

    applyMigrations(db, resolveMigrationsPath())
    for (const table of [
      'assistant_remote_knowledge_base',
      'agent_remote_knowledge_base',
      'remote_knowledge_service'
    ]) {
      expect(sqlite.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', table)).toEqual({
        name: table
      })
    }
    sqlite
      .prepare(`INSERT INTO remote_knowledge_service (id, name, base_url, created_at, updated_at)
        VALUES ('kept-service', 'Existing service', 'https://knowledge.example', 1000, 2000)`)
      .run()
    applyMigrations(db, resolveMigrationsPath())
    expect(sqlite.prepare('SELECT name FROM user_provider WHERE provider_id = ?').get('existing')).toEqual({
      name: 'Existing provider'
    })
    expect(sqlite.prepare('SELECT name FROM remote_knowledge_service WHERE id = ?').get('kept-service')).toEqual({
      name: 'Existing service'
    })
    expect(sqlite.pragma('foreign_key_check')).toEqual([])
    expect(String(sqlite.pragma('integrity_check', { simple: true }))).toBe('ok')
  })

  it('is idempotent when run again on an already-migrated database', () => {
    applyMigrations(db, resolveMigrationsPath())

    expect(() => applyMigrations(db, resolveMigrationsPath())).not.toThrow()
    expect(String(sqlite.pragma('integrity_check', { simple: true }))).toBe('ok')
  })

  it('preserves child rows across a table-recreate migration on a populated database', () => {
    const staged = stageMigrations()
    appendMigration(staged, '0001_seedable_pair', [
      'CREATE TABLE `recreated` (\n\t`id` text PRIMARY KEY NOT NULL\n);',
      'CREATE TABLE `recreated_ref` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`parent_id` text NOT NULL,\n\tFOREIGN KEY (`parent_id`) REFERENCES `recreated`(`id`) ON UPDATE no action ON DELETE cascade\n);'
    ])
    applyMigrations(db, staged)

    sqlite.exec("INSERT INTO `recreated` VALUES ('p1'); INSERT INTO `recreated_ref` VALUES ('c1', 'p1');")

    // Verbatim shape of what drizzle-kit emits for any constraint / column-type
    // change, own `PRAGMA foreign_keys` guards included.
    appendMigration(staged, '0002_recreate_table', [
      'PRAGMA foreign_keys=OFF;',
      'CREATE TABLE `__new_recreated` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`label` text\n);',
      'INSERT INTO `__new_recreated`("id", "label") SELECT "id", NULL FROM `recreated`;',
      'DROP TABLE `recreated`;',
      'ALTER TABLE `__new_recreated` RENAME TO `recreated`;',
      'PRAGMA foreign_keys=ON;'
    ])
    applyMigrations(db, staged)

    expect(sqlite.prepare('SELECT id, parent_id FROM `recreated_ref`').all()).toEqual([{ id: 'c1', parent_id: 'p1' }])
    expect(sqlite.pragma('foreign_key_check')).toEqual([])
  })

  it.each([
    ['ON', 1],
    ['OFF', 0]
  ])("restores the caller's foreign_keys = %s after migrating", (setting, expected) => {
    sqlite.pragma(`foreign_keys = ${setting}`)

    applyMigrations(db, resolveMigrationsPath())

    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(expected)
  })
})
