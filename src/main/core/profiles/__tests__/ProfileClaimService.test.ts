import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ProfileClaimService } from '..'

const roots: string[] = []

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-claim-'))
  roots.push(root)
  const localUserData = path.join(root, 'local', 'userData')
  const targetUserData = path.join(root, 'authenticated', 'userData')
  await mkdir(path.join(localUserData, 'Data'), { recursive: true })
  await writeFile(path.join(localUserData, 'Data', 'app.db'), 'business')
  await writeFile(path.join(localUserData, 'Preferences'), 'settings')
  await mkdir(path.join(localUserData, 'Credentials'), { recursive: true })
  await writeFile(path.join(localUserData, 'Credentials', 'login.json'), 'credential')
  await mkdir(path.join(localUserData, 'Session', 'Cookies'), { recursive: true })
  await writeFile(path.join(localUserData, 'Session', 'Cookies', 'db'), 'cookies')
  await mkdir(path.join(localUserData, 'Sensitive', 'Mcp', 'oauth'), { recursive: true })
  await writeFile(path.join(localUserData, 'Sensitive', 'Mcp', 'oauth', 'token'), 'oauth')
  await mkdir(path.join(localUserData, 'Sensitive', 'Copilot'), { recursive: true })
  await writeFile(path.join(localUserData, 'Sensitive', 'Copilot', 'token.enc'), 'copilot')
  await mkdir(path.join(localUserData, 'Data', 'enterprise'), { recursive: true })
  await writeFile(path.join(localUserData, 'Data', 'enterprise', 'catalog.json'), 'enterprise')
  await mkdir(path.join(localUserData, 'Config'), { recursive: true })
  await writeFile(path.join(localUserData, 'Config', 'providers.json'), '{"apiKey":"key"}')
  return { localUserData, targetUserData }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ProfileClaimService', () => {
  it('previews categories, sizes, and credential exclusions without writing the target', async () => {
    const { localUserData, targetUserData } = await fixture()
    const preview = await new ProfileClaimService({ localUserData, targetUserData }).preview()

    expect(preview.status).toBe('ready')
    if (preview.status !== 'ready') throw new Error('expected ready preview')
    expect(preview.included).toEqual(expect.arrayContaining([expect.objectContaining({ category: 'business-data' })]))
    expect(preview.excluded.map((item) => item.category)).toEqual(
      expect.arrayContaining(['credentials', 'session-cookies', 'mcp-oauth', 'copilot', 'enterprise-resource', 'api-key'])
    )
    expect(preview.totalBytes).toBeGreaterThan(0)
    await expect(access(targetUserData)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('copies only previewed business data after explicit confirmation and preserves local', async () => {
    const { localUserData, targetUserData } = await fixture()
    const service = new ProfileClaimService({ localUserData, targetUserData })
    const preview = await service.preview()
    if (preview.status !== 'ready') throw new Error('expected ready preview')

    const result = await service.confirm({ previewId: preview.previewId, allow: [] })

    expect(result.status).toBe('claimed')
    await expect(readFile(path.join(targetUserData, 'Data', 'app.db'), 'utf8')).resolves.toBe('business')
    await expect(readFile(path.join(localUserData, 'Data', 'app.db'), 'utf8')).resolves.toBe('business')
    await expect(access(path.join(targetUserData, 'Credentials'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(path.join(targetUserData, 'Sensitive'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(path.join(targetUserData, 'Config', 'providers.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('allows ordinary config/API key only with the matching explicit option', async () => {
    const { localUserData, targetUserData } = await fixture()
    const service = new ProfileClaimService({ localUserData, targetUserData })
    const preview = await service.preview()
    if (preview.status !== 'ready') throw new Error('expected ready preview')

    await service.confirm({ previewId: preview.previewId, allow: ['api-keys'] })

    await expect(readFile(path.join(targetUserData, 'Config', 'providers.json'), 'utf8')).resolves.toContain('apiKey')
    await expect(access(path.join(targetUserData, 'Credentials'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('atomically claims into an existing empty target directory', async () => {
    const { localUserData, targetUserData } = await fixture()
    await mkdir(targetUserData, { recursive: true })
    const service = new ProfileClaimService({ localUserData, targetUserData })
    const preview = await service.preview()
    if (preview.status !== 'ready') throw new Error('expected ready preview')

    await expect(service.confirm({ previewId: preview.previewId, allow: [] })).resolves.toEqual({ status: 'claimed' })
    await expect(readFile(path.join(targetUserData, 'Data', 'app.db'), 'utf8')).resolves.toBe('business')
  })

  it('recovers stale claim staging before a new preview', async () => {
    const { localUserData, targetUserData } = await fixture()
    const stagingRoot = path.join(path.dirname(targetUserData), '.claim-stale.staging')
    const journalPath = path.join(path.dirname(targetUserData), 'claim-journal.json')
    await mkdir(stagingRoot, { recursive: true })
    await writeFile(path.join(stagingRoot, 'partial'), 'partial')
    await writeFile(
      journalPath,
      JSON.stringify({
        version: 1,
        phase: 'copying',
        operationId: '550e8400-e29b-41d4-a716-446655440000',
        previewId: 'b3d57d89-8ca3-4c5b-8f1e-a8ee94db7607',
        sourceRoot: localUserData,
        targetRoot: targetUserData,
        stagingRoot
      })
    )

    await new ProfileClaimService({ localUserData, targetUserData, journalPath }).preview()

    await expect(access(stagingRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects non-empty targets as structured import unsupported without overwriting', async () => {
    const { localUserData, targetUserData } = await fixture()
    await mkdir(targetUserData, { recursive: true })
    await writeFile(path.join(targetUserData, 'existing'), 'keep')
    const service = new ProfileClaimService({ localUserData, targetUserData })

    await expect(service.preview()).resolves.toEqual({ status: 'unsupported', reason: 'target-not-empty' })
    await expect(readFile(path.join(targetUserData, 'existing'), 'utf8')).resolves.toBe('keep')
  })

  it('cancels before commit and leaves the target absent', async () => {
    const { localUserData, targetUserData } = await fixture()
    const service = new ProfileClaimService({ localUserData, targetUserData })
    const preview = await service.preview()
    if (preview.status !== 'ready') throw new Error('expected ready preview')
    const controller = new AbortController()
    controller.abort()

    await expect(service.confirm({ previewId: preview.previewId, allow: [], signal: controller.signal })).resolves.toEqual({
      status: 'cancelled'
    })
    await expect(access(targetUserData)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
