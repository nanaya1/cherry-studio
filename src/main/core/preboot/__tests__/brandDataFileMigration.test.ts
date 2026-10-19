import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

const sqlite = vi.hoisted(() => ({
  close: vi.fn(),
  pragma: vi.fn((statement: string, options?: { simple?: boolean }) => {
    if (statement === 'wal_checkpoint(TRUNCATE)') return [{ busy: 0, log: 1, checkpointed: 1 }]
    if (statement === 'integrity_check' && options?.simple) return 'ok'
    throw new Error(`Unexpected pragma: ${statement}`)
  })
}))

vi.mock('better-sqlite3', () => ({
  default: vi.fn(function MockDatabase() {
    return sqlite
  })
}))

import { migrateBrandDataFiles } from '../brandDataFileMigration'

const roots: string[] = []

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'brand-data-files-'))
  roots.push(root)
  mkdirSync(path.join(root, 'Data'), { recursive: true })
  mkdirSync(path.join(root, 'Credentials'), { recursive: true })
  return root
}

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('migrateBrandDataFiles', () => {
  it('moves the legacy database and credentials to meacowork names without losing data', async () => {
    const root = await createRoot()
    const legacyDatabase = path.join(root, 'Data', 'cherrystudio.sqlite')
    writeFileSync(legacyDatabase, 'preserved database')
    writeFileSync(`${legacyDatabase}-wal`, 'checkpointed wal')
    writeFileSync(`${legacyDatabase}-shm`, 'shared memory')
    writeFileSync(`${legacyDatabase}-journal`, 'rollback journal')
    writeFileSync(path.join(root, 'Credentials', 'cherry-account.json'), '{"device":"preserved"}\n')

    migrateBrandDataFiles(root)

    const brandedDatabase = path.join(root, 'Data', 'meacowork.sqlite')
    expect(readFileSync(brandedDatabase, 'utf8')).toBe('preserved database')
    expect(sqlite.pragma).toHaveBeenCalledWith('wal_checkpoint(TRUNCATE)')
    expect(sqlite.close).toHaveBeenCalledOnce()
    expect(existsSync(legacyDatabase)).toBe(false)
    expect(existsSync(`${legacyDatabase}-wal`)).toBe(false)
    expect(existsSync(`${legacyDatabase}-shm`)).toBe(false)
    expect(existsSync(`${legacyDatabase}-journal`)).toBe(false)
    expect(readFileSync(path.join(root, 'Credentials', 'meacowork-account.json'), 'utf8')).toContain('preserved')
    expect(existsSync(path.join(root, 'Credentials', 'cherry-account.json'))).toBe(false)
  })

  it('is idempotent after the legacy files have already been migrated', async () => {
    const root = await createRoot()
    writeFileSync(path.join(root, 'Data', 'meacowork.sqlite'), 'current')
    writeFileSync(path.join(root, 'Credentials', 'meacowork-account.json'), 'current')

    expect(() => migrateBrandDataFiles(root)).not.toThrow()
    expect(sqlite.pragma).not.toHaveBeenCalled()
  })

  it('does not overwrite either file when old and new database names coexist', async () => {
    const root = await createRoot()
    writeFileSync(path.join(root, 'Data', 'cherrystudio.sqlite'), 'legacy')
    writeFileSync(path.join(root, 'Data', 'meacowork.sqlite'), 'current')

    expect(() => migrateBrandDataFiles(root)).toThrow(/both legacy and branded database files exist/i)
    expect(readFileSync(path.join(root, 'Data', 'cherrystudio.sqlite'), 'utf8')).toBe('legacy')
    expect(readFileSync(path.join(root, 'Data', 'meacowork.sqlite'), 'utf8')).toBe('current')
  })

  it('does not overwrite either file when old and new credential names coexist', async () => {
    const root = await createRoot()
    writeFileSync(path.join(root, 'Credentials', 'cherry-account.json'), 'legacy')
    writeFileSync(path.join(root, 'Credentials', 'meacowork-account.json'), 'current')

    expect(() => migrateBrandDataFiles(root)).toThrow(/both legacy and branded credential files exist/i)
    expect(readFileSync(path.join(root, 'Credentials', 'cherry-account.json'), 'utf8')).toBe('legacy')
    expect(readFileSync(path.join(root, 'Credentials', 'meacowork-account.json'), 'utf8')).toBe('current')
  })
})
