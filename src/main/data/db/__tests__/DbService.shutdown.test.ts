import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('../DbService')

const sqlite = vi.hoisted(() => ({
  pragma: vi.fn(),
  close: vi.fn(),
  prepare: vi.fn(),
  exec: vi.fn()
}))

vi.mock('better-sqlite3', () => ({
  default: class MockDatabase {
    constructor() {
      return sqlite
    }
  }
}))
vi.mock('drizzle-orm/better-sqlite3', () => ({ drizzle: vi.fn(() => ({ transaction: vi.fn() })) }))
vi.mock('@application', () => ({
  application: { getPath: vi.fn(() => '/tmp/profile-switch-db.sqlite') }
}))
vi.mock('../applyMigrations', () => ({ applyMigrations: vi.fn() }))
vi.mock('../seeding/seederRegistry', () => ({ seeders: [] }))
vi.mock('../seeding/SeedRunner', () => ({
  SeedRunner: class {
    runAll() {}
  }
}))

import { BaseService } from '@main/core/lifecycle'

import { profileSwitchFence } from '@main/core/profiles'

import { DbService } from '../DbService'

describe('DbService shutdown', () => {
  beforeEach(() => {
    BaseService.resetInstances()
    vi.clearAllMocks()
    sqlite.pragma.mockReturnValue([{ busy: 0, log: 0, checkpointed: 0 }])
    profileSwitchFence.resetForTesting()
  })

  it('rejects new database access after profile switching begins', async () => {
    const service = new DbService()
    await service._doInit()
    profileSwitchFence.beginSwitch('550e8400-e29b-41d4-a716-446655440000')

    expect(() => service.getDb()).toThrow(/profile switch/i)
  })

  it('checkpoints WAL before explicitly closing the connection', async () => {
    const service = new DbService()

    service.checkpointAndClose()

    expect(sqlite.pragma).toHaveBeenCalledWith('wal_checkpoint(TRUNCATE)')
    expect(sqlite.close).toHaveBeenCalledOnce()
    expect(sqlite.pragma.mock.invocationCallOrder.at(-1)).toBeLessThan(sqlite.close.mock.invocationCallOrder[0])
  })

  it('propagates checkpoint failure and does not close an incompletely checkpointed database', () => {
    sqlite.pragma.mockReturnValue([{ busy: 1, log: 2, checkpointed: 1 }])
    const service = new DbService()

    expect(() => service.checkpointAndClose()).toThrow(/checkpoint/i)
    expect(sqlite.close).not.toHaveBeenCalled()
  })

  it('propagates close failure', () => {
    sqlite.close.mockImplementation(() => {
      throw new Error('close failed')
    })
    const service = new DbService()

    expect(() => service.checkpointAndClose()).toThrow('close failed')
  })
})
