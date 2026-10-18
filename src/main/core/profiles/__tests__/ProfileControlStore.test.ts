import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import * as z from 'zod'

import { isUnsupportedParentDirectoryDurabilityError, ProfileControlStore } from '..'

const TestRecordSchema = z.strictObject({
  version: z.literal(1),
  name: z.string()
})

type TestRecord = z.infer<typeof TestRecordSchema>

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'profile-control-store-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('ProfileControlStore', () => {
  it.each(['EPERM', 'EACCES'])('treats Windows %s from parent-directory sync as unsupported', (code) => {
    expect(isUnsupportedParentDirectoryDurabilityError(code, 'win32')).toBe(true)
    expect(isUnsupportedParentDirectoryDurabilityError(code, 'linux')).toBe(false)
  })

  it.each(['EINVAL', 'EISDIR', 'ENOTSUP'])('treats %s as unsupported on every platform', (code) => {
    expect(isUnsupportedParentDirectoryDurabilityError(code, 'win32')).toBe(true)
    expect(isUnsupportedParentDirectoryDurabilityError(code, 'linux')).toBe(true)
  })

  it('returns none only when the file does not exist', async () => {
    const directory = await createTemporaryDirectory()
    const store = new ProfileControlStore(path.join(directory, 'missing.json'), TestRecordSchema)

    await expect(store.read()).resolves.toEqual({ kind: 'none' })
  })

  it('does not treat non-ENOENT read errors as missing', async () => {
    const directory = await createTemporaryDirectory()
    const store = new ProfileControlStore(directory, TestRecordSchema)

    await expect(store.read()).rejects.toMatchObject({ code: expect.not.stringMatching(/^ENOENT$/) })
  })

  it.each([
    ['invalid JSON', '{not-json'],
    ['schema mismatch', JSON.stringify({ version: 1, name: 42 })],
    ['unknown fields', JSON.stringify({ version: 1, name: 'valid', extra: true })]
  ])('returns corrupt for %s without changing the file', async (_case, content) => {
    const directory = await createTemporaryDirectory()
    const filePath = path.join(directory, 'record.json')
    await writeFile(filePath, content, 'utf8')
    const store = new ProfileControlStore(filePath, TestRecordSchema)

    const result = await store.read()

    expect(result).toMatchObject({ kind: 'corrupt', filePath, error: expect.any(String) })
    await expect(readFile(filePath, 'utf8')).resolves.toBe(content)
  })

  it('returns a validated value for a valid document', async () => {
    const directory = await createTemporaryDirectory()
    const filePath = path.join(directory, 'record.json')
    await writeFile(filePath, '{"version":1,"name":"valid"}\n', 'utf8')
    const store = new ProfileControlStore(filePath, TestRecordSchema)

    await expect(store.read()).resolves.toEqual({ kind: 'ok', value: { version: 1, name: 'valid' } })
  })

  it('validates before writing and leaves an existing document unchanged on failure', async () => {
    const directory = await createTemporaryDirectory()
    const filePath = path.join(directory, 'record.json')
    const original = '{"version":1,"name":"original"}\n'
    await writeFile(filePath, original, 'utf8')
    const store = new ProfileControlStore(filePath, TestRecordSchema)

    await expect(store.write({ version: 1, name: 'invalid', extra: true } as TestRecord)).rejects.toThrow()
    await expect(readFile(filePath, 'utf8')).resolves.toBe(original)
  })

  it('atomically writes JSON with a trailing newline and mode 0o600', async () => {
    const directory = await createTemporaryDirectory()
    const filePath = path.join(directory, 'record.json')
    const store = new ProfileControlStore(filePath, TestRecordSchema)

    const result = await store.write({ version: 1, name: 'saved' })

    expect(result).toMatchObject(
      process.platform === 'win32'
        ? { kind: 'committed-durability-unknown', reason: 'unsupported' }
        : { kind: 'committed-confirmed' }
    )
    await expect(readFile(filePath, 'utf8')).resolves.toBe('{\n  "version": 1,\n  "name": "saved"\n}\n')
    if (process.platform !== 'win32') expect((await stat(filePath)).mode & 0o777).toBe(0o600)
  })

  it.each([
    ['unsupported', Object.assign(new Error('unsupported'), { code: 'EINVAL' }), 'unsupported'],
    ['error', Object.assign(new Error('I/O failure'), { code: 'EIO' }), 'error']
  ] as const)('reports committed durability unknown for %s confirmation failures', async (_case, error, reason) => {
    const directory = await createTemporaryDirectory()
    const filePath = path.join(directory, 'record.json')
    const store = new ProfileControlStore(filePath, TestRecordSchema, async () => {
      throw error
    })

    await expect(store.write({ version: 1, name: 'saved' })).resolves.toMatchObject({
      kind: 'committed-durability-unknown',
      reason
    })
    await expect(readFile(filePath, 'utf8')).resolves.toContain('"name": "saved"')
  })

  it('propagates atomic write failures', async () => {
    const directory = await createTemporaryDirectory()
    const filePath = path.join(directory, 'missing-parent', 'record.json')
    const store = new ProfileControlStore(filePath, TestRecordSchema)

    await expect(store.write({ version: 1, name: 'saved' })).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
