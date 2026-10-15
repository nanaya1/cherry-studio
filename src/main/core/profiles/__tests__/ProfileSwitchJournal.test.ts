import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ProfileControlStore, ProfileSwitchJournal, ProfileSwitchJournalV1Schema } from '..'

const OPERATION_ID = '550e8400-e29b-41d4-a716-446655440000'
const OTHER_OPERATION_ID = 'b3d57d89-8ca3-4c5b-8f1e-a8ee94db7607'
const TARGET_PROFILE_ID = '0123456789abcdef0123456789abcdef'
const TARGET_DIGEST = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const temporaryDirectories: string[] = []

async function createJournalPath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'profile-switch-journal-'))
  temporaryDirectories.push(directory)
  return path.join(directory, 'switch-journal.json')
}

const request = {
  operationId: OPERATION_ID,
  fromProfileId: 'signed-out',
  targetProfileId: TARGET_PROFILE_ID,
  targetIdentityDigest: TARGET_DIGEST
} as const

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('ProfileSwitchJournal', () => {
  it('returns the prepared value with unknown durability when confirmation fails', async () => {
    const filePath = await createJournalPath()
    const store = new ProfileControlStore(filePath, ProfileSwitchJournalV1Schema, async () => {
      throw new Error('directory sync failed')
    })

    const result = await new ProfileSwitchJournal(store).prepare(request)

    expect(result.value).toMatchObject({ phase: 'prepared', ...request })
    expect(result.durability).toEqual({
      kind: 'committed-durability-unknown',
      reason: 'error',
      error: 'directory sync failed'
    })
    await expect(new ProfileSwitchJournal(filePath).read()).resolves.toEqual({ kind: 'ok', value: result.value })
  })

  it('prepare creates only a prepared journal', async () => {
    const journal = new ProfileSwitchJournal(await createJournalPath())

    const prepared = (await journal.prepare(request)).value

    expect(prepared).toMatchObject({ version: 1, phase: 'prepared', ...request })
    expect(prepared).not.toHaveProperty('committedAt')
  })

  it('makes a matching prepared retry idempotent', async () => {
    const journal = new ProfileSwitchJournal(await createJournalPath())

    const first = await journal.prepare(request)
    const second = await journal.prepare(request)

    expect(second.value).toEqual(first.value)
    expect(second.durability).toEqual({ kind: 'not-written' })
  })

  it('rejects a different operation while a prepared journal exists', async () => {
    const journal = new ProfileSwitchJournal(await createJournalPath())
    await journal.prepare(request)

    await expect(journal.prepare({ ...request, operationId: OTHER_OPERATION_ID })).rejects.toThrow(/operation/i)
  })

  it('rejects a matching operation with a different target while prepared', async () => {
    const journal = new ProfileSwitchJournal(await createJournalPath())
    await journal.prepare(request)

    await expect(journal.prepare({ ...request, targetIdentityDigest: 'f'.repeat(64) })).rejects.toThrow(/target/i)
  })

  it('cancels only a matching prepared operation and preserves an audit copy', async () => {
    const filePath = await createJournalPath()
    const journal = new ProfileSwitchJournal(filePath)
    const prepared = (await journal.prepare(request)).value

    await expect(journal.cancel(OTHER_OPERATION_ID)).rejects.toThrow(/operation/i)
    await expect(journal.cancel(OPERATION_ID)).resolves.toEqual({
      value: prepared,
      durability: { kind: 'committed-confirmed' }
    })

    await expect(journal.read()).resolves.toEqual({ kind: 'none' })
    await expect(readFile(`${filePath}.cancelled`, 'utf8')).resolves.toContain(OPERATION_ID)
  })

  it('commits only a matching prepared journal', async () => {
    const journal = new ProfileSwitchJournal(await createJournalPath())
    const prepared = (await journal.prepare(request)).value

    const committed = (
      await journal.commit({
        operationId: prepared.operationId,
        targetProfileId: prepared.targetProfileId,
        targetIdentityDigest: prepared.targetIdentityDigest
      })
    ).value

    expect(committed).toMatchObject({ phase: 'committed', ...request, committedAt: expect.any(String) })
  })

  it.each([
    ['operationId', { operationId: OTHER_OPERATION_ID }],
    ['targetProfileId', { targetProfileId: 'abcdef0123456789abcdef0123456789' }],
    ['targetIdentityDigest', { targetIdentityDigest: 'f'.repeat(64) }]
  ])('rejects commit when %s does not match prepared state', async (_field, override) => {
    const journal = new ProfileSwitchJournal(await createJournalPath())
    await journal.prepare(request)

    await expect(journal.commit({ ...request, ...override })).rejects.toThrow(/match/i)
  })

  it('fails closed for corrupt journal without changing it', async () => {
    const filePath = await createJournalPath()
    const content = '{not-json'
    await writeFile(filePath, content, 'utf8')
    const journal = new ProfileSwitchJournal(filePath)

    await expect(journal.prepare(request)).rejects.toThrow(/corrupt/i)
    await expect(readFile(filePath, 'utf8')).resolves.toBe(content)
  })

  it('keeps the latest committed journal readable until the next operation starts', async () => {
    const filePath = await createJournalPath()
    const journal = new ProfileSwitchJournal(filePath)
    await journal.prepare(request)
    const committed = (await journal.commit(request)).value

    await expect(journal.read()).resolves.toEqual({ kind: 'ok', value: committed })
    await expect(readFile(filePath, 'utf8')).resolves.toContain('"phase": "committed"')
  })

  it('archives a committed operation before preparing the next operation', async () => {
    const filePath = await createJournalPath()
    const journal = new ProfileSwitchJournal(filePath)
    const committed = (await journal.prepare(request).then(() => journal.commit(request))).value
    const next = {
      ...request,
      operationId: OTHER_OPERATION_ID,
      fromProfileId: request.targetProfileId,
      targetProfileId: 'abcdef0123456789abcdef0123456789',
      targetIdentityDigest: 'f'.repeat(64)
    }

    await expect(journal.prepare(next)).resolves.toMatchObject({ value: { phase: 'prepared', ...next } })
    await expect(journal.readLatestCommitted()).resolves.toEqual({ kind: 'ok', value: committed })
    await expect(journal.read()).resolves.toMatchObject({ kind: 'ok', value: { phase: 'prepared', ...next } })
  })

  it('does not report committed when persistence fails', async () => {
    const parentFile = await createJournalPath()
    await writeFile(parentFile, 'not-a-directory', 'utf8')
    const journal = new ProfileSwitchJournal(path.join(parentFile, 'switch-journal.json'))

    await expect(journal.prepare(request)).rejects.toMatchObject({ code: 'ENOTDIR' })
  })

  it.each([
    ['dot segment', (directory: string) => `${directory}/./switch-journal.json`],
    ['symlink parent', (directory: string) => path.join(`${directory}-link`, 'switch-journal.json')]
  ])('allows only one concurrent prepare across equivalent %s paths', async (_case, equivalentPath) => {
    const filePath = await createJournalPath()
    const directory = path.dirname(filePath)
    const linkPath = `${directory}-link`

    if (_case === 'symlink parent') {
      await symlink(directory, linkPath, 'dir')
    }
    let results: PromiseSettledResult<unknown>[]
    try {
      results = await Promise.allSettled([
        new ProfileSwitchJournal(filePath).prepare(request),
        new ProfileSwitchJournal(equivalentPath(directory)).prepare({ ...request, operationId: OTHER_OPERATION_ID })
      ])
    } finally {
      if (_case === 'symlink parent') {
        await unlink(linkPath)
      }
    }

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })

  it('allows only one of two different concurrent prepares across instances', async () => {
    const filePath = await createJournalPath()
    const results = await Promise.allSettled([
      new ProfileSwitchJournal(filePath).prepare(request),
      new ProfileSwitchJournal(filePath).prepare({ ...request, operationId: OTHER_OPERATION_ID })
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  })

  it('does not let a concurrent prepare overwrite a committed journal', async () => {
    const filePath = await createJournalPath()
    const journal = new ProfileSwitchJournal(filePath)
    await journal.prepare(request)

    await Promise.allSettled([journal.prepare(request), new ProfileSwitchJournal(filePath).commit(request)])

    await expect(journal.read()).resolves.toMatchObject({ kind: 'ok', value: { phase: 'committed' } })
  })
})
