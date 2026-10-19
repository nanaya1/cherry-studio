import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { parseArgs, runMigration } from '../../../../../scripts/personal-to-enterprise-migration'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'personal-to-enterprise-'))
  roots.push(root)
  const source = path.join(root, 'personal-user-data')
  const target = path.join(root, 'enterprise-user-data')
  await mkdir(path.join(source, 'Data'), { recursive: true })
  await writeFile(path.join(source, 'Data', 'chat.json'), 'business')
  await mkdir(path.join(source, 'Config'), { recursive: true })
  await writeFile(path.join(source, 'Config', 'providers.json'), '{"apiKey":"secret"}')
  return { source, target }
}

describe('personal-to-enterprise-migration', () => {
  it('defaults to preview and does not write the target', async () => {
    const { source, target } = await fixture()

    expect(parseArgs(['--source', source, '--target', target])).toEqual({
      source,
      target,
      apply: false,
      allow: []
    })
    const result = await runMigration({ source, target, apply: false, allow: [] })

    expect(result.status).toBe('preview')
    await expect(readFile(path.join(target, 'Data', 'chat.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('requires explicit apply and keeps credentials excluded by default', async () => {
    const { source, target } = await fixture()

    const result = await runMigration({ source, target, apply: true, allow: [] })

    expect(result.status).toBe('applied')
    await expect(readFile(path.join(target, 'Data', 'chat.json'), 'utf8')).resolves.toBe('business')
    await expect(readFile(path.join(target, 'Config', 'providers.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('allows API keys only when explicitly requested', async () => {
    const { source, target } = await fixture()

    await runMigration({ source, target, apply: true, allow: ['api-keys'] })

    await expect(readFile(path.join(target, 'Config', 'providers.json'), 'utf8')).resolves.toContain('secret')
  })

  it('rejects missing required paths', () => {
    expect(() => parseArgs(['--source', '/missing'])).toThrow('--target is required')
    expect(() => parseArgs(['--target', '/target'])).toThrow('--source is required')
    expect(() => parseArgs(['--source', '/source', '--target', '/target', '--unknown'])).toThrow(
      'Unknown option: --unknown'
    )
  })
})
