import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ProfileSensitiveDataMigrator } from '../ProfileSensitiveDataMigrator'

const PROFILE_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const PROFILE_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const DIGEST_A = `${PROFILE_A}${PROFILE_A}`
const DIGEST_B = `${PROFILE_B}${PROFILE_B}`

const legacyItems = [
  ['mcp-oauth', 'config/mcp/oauth/server_oauth.json', 'Sensitive/Mcp/oauth/server_oauth.json'],
  ['mcp-memory', 'config/memory.json', 'Sensitive/Mcp/memory.json'],
  ['mcp-registry', 'config/mcp-registry.json', 'Sensitive/Mcp/registry.json'],
  ['mcp-settings', 'config/mcp-auto-install-settings.json', 'Sensitive/Mcp/auto-install-settings.json'],
  ['copilot-token', 'config/.copilot_token', 'Sensitive/Copilot/token.enc']
] as const

describe('ProfileSensitiveDataMigrator', () => {
  let root: string
  let cherryHome: string
  let profileA: string
  let profileB: string

  beforeEach(async () => {
    root = await import('node:fs/promises').then((fs) => fs.mkdtemp(path.join(os.tmpdir(), 'profile-sensitive-')))
    cherryHome = path.join(root, 'cherry-home')
    profileA = path.join(root, 'profiles', PROFILE_A, 'userData')
    profileB = path.join(root, 'profiles', PROFILE_B, 'userData')
    for (const [, source, ,] of legacyItems) {
      const file = path.join(cherryHome, source)
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, source)
    }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('automatically copies legacy single-user data only into the local profile and keeps sources', async () => {
    const migrator = new ProfileSensitiveDataMigrator({ cherryHome })

    const result = await migrator.migrate({
      mode: 'business',
      profile: { kind: 'local', profileId: PROFILE_A, identityDigest: DIGEST_A },
      userData: profileA
    })

    expect(result.status).toBe('migrated')
    for (const [, source, target] of legacyItems) {
      await expect(readFile(path.join(profileA, target), 'utf8')).resolves.toBe(source)
      await expect(readFile(path.join(cherryHome, source), 'utf8')).resolves.toBe(source)
      await expect(readFile(path.join(profileB, target), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('uses the real legacy userData root for enterprise files and retries an earlier source-missing item', async () => {
    const legacyUserData = path.join(root, 'legacy-user-data')
    const migrator = new ProfileSensitiveDataMigrator({ cherryHome, legacyUserData })
    const input = {
      mode: 'business' as const,
      profile: { kind: 'local' as const, profileId: PROFILE_A, identityDigest: DIGEST_A },
      userData: profileA
    }

    await migrator.migrate(input)
    const source = path.join(legacyUserData, 'Data', 'enterprise', 'org-state.json')
    await mkdir(path.dirname(source), { recursive: true })
    await writeFile(source, 'legacy-enterprise-state')

    await expect(migrator.migrate(input)).resolves.toMatchObject({ status: 'migrated', items: ['enterprise-state'] })
    await expect(readFile(path.join(profileA, 'Sensitive', 'Enterprise', 'org-state.json'), 'utf8')).resolves.toBe(
      'legacy-enterprise-state'
    )
  })

  it('never automatically copies legacy data into an authenticated profile', async () => {
    const migrator = new ProfileSensitiveDataMigrator({ cherryHome })

    const result = await migrator.migrate({
      mode: 'business',
      profile: { kind: 'authenticated', profileId: PROFILE_B, identityDigest: DIGEST_B },
      userData: profileB
    })

    expect(result).toEqual({ status: 'skipped', reason: 'authenticated-requires-claim' })
    await expect(readFile(path.join(profileB, legacyItems[0][2]), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('imports only explicitly claimed items into an authenticated profile after identity proof', async () => {
    const migrator = new ProfileSensitiveDataMigrator({ cherryHome })
    const input = {
      mode: 'business' as const,
      profile: { kind: 'authenticated' as const, profileId: PROFILE_B, identityDigest: DIGEST_B },
      userData: profileB
    }

    await expect(migrator.importClaimedItems(input, ['copilot-token'], DIGEST_A)).rejects.toThrow(/proven profile identity/i)
    await expect(migrator.importClaimedItems(input, ['copilot-token'], DIGEST_B)).resolves.toEqual({
      status: 'migrated',
      items: ['copilot-token']
    })

    await expect(readFile(path.join(profileB, 'Sensitive/Copilot/token.enc'), 'utf8')).resolves.toBe(
      'config/.copilot_token'
    )
    await expect(readFile(path.join(profileB, 'Sensitive/Mcp/oauth/server_oauth.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('keeps the one-time manifest outside resettable sensitive data to prevent legacy resurrection', async () => {
    const migrator = new ProfileSensitiveDataMigrator({ cherryHome })
    const input = {
      mode: 'business' as const,
      profile: { kind: 'local' as const, profileId: PROFILE_A, identityDigest: DIGEST_A },
      userData: profileA
    }

    await migrator.migrate(input)

    await expect(readFile(path.join(profileA, 'Runtime', 'ProfileMigration', 'legacy-sensitive-data.json'), 'utf8')).resolves.toContain(
      PROFILE_A
    )
    await expect(
      readFile(path.join(profileA, 'Sensitive', 'Migration', 'legacy-sensitive-data.json'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('is idempotent and never overwrites profile data on later runs', async () => {
    const migrator = new ProfileSensitiveDataMigrator({ cherryHome })
    const input = {
      mode: 'business' as const,
      profile: { kind: 'local' as const, profileId: PROFILE_A, identityDigest: DIGEST_A },
      userData: profileA
    }

    await migrator.migrate(input)
    await writeFile(path.join(profileA, legacyItems[1][2]), 'profile-newer')
    await writeFile(path.join(cherryHome, legacyItems[1][1]), 'legacy-changed')

    expect((await migrator.migrate(input)).status).toBe('already-complete')
    await expect(readFile(path.join(profileA, legacyItems[1][2]), 'utf8')).resolves.toBe('profile-newer')
  })

  it('rejects symlinks anywhere inside a legacy directory source', async () => {
    await symlink(path.join(cherryHome, 'config', 'memory.json'), path.join(cherryHome, 'config', 'mcp', 'oauth', 'linked'))
    const migrator = new ProfileSensitiveDataMigrator({ cherryHome })

    await expect(
      migrator.migrate({
        mode: 'business',
        profile: { kind: 'local', profileId: PROFILE_A, identityDigest: DIGEST_A },
        userData: profileA
      })
    ).rejects.toThrow(/symbolic link/i)
    await expect(readFile(path.join(profileA, legacyItems[0][2], 'linked'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves the previous target intact when staged commit fails and can retry', async () => {
    let failCommit = true
    const migrator = new ProfileSensitiveDataMigrator({
      cherryHome,
      beforeCommit: async (item) => {
        if (failCommit && item === 'mcp-memory') throw new Error('injected commit failure')
      }
    })
    await mkdir(path.dirname(path.join(profileA, legacyItems[1][2])), { recursive: true })
    await writeFile(path.join(profileA, legacyItems[1][2]), 'existing-profile-value')
    const input = {
      mode: 'business' as const,
      profile: { kind: 'local' as const, profileId: PROFILE_A, identityDigest: DIGEST_A },
      userData: profileA
    }

    await expect(migrator.migrate(input)).rejects.toThrow('injected commit failure')
    await expect(readFile(path.join(profileA, legacyItems[1][2]), 'utf8')).resolves.toBe('existing-profile-value')
    await expect(readFile(path.join(cherryHome, legacyItems[1][1]), 'utf8')).resolves.toBe(legacyItems[1][1])

    failCommit = false
    await expect(migrator.migrate(input)).resolves.toMatchObject({ status: 'migrated' })
    await expect(readFile(path.join(profileA, legacyItems[1][2]), 'utf8')).resolves.toBe('existing-profile-value')
  })
})
