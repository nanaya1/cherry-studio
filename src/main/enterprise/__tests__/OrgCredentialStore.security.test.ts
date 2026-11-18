import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { computeIdentityDigest } from '../../core/profiles/ProfileIdentity'
import { OrgCredentialStore, type OrgCredentialWriteResult, type OrgSession } from '../OrgCredentialStore'

const roots: string[] = []

// function session(overrides: Partial<OrgSession> = {}): OrgSession {
function session(overrides: Partial<Exclude<OrgSession, { authMode: 'management-java' }>> = {}): OrgSession {
  return {
    authMode: 'management-oauth',
    accountKind: 'management',
    issuerId: 'server-1',
    authOrigin: 'https://management.example',
    userId: 'user-1',
    officialUserId: '',
    groupId: 'group-1',
    displayName: 'User',
    phone: '',
    role: 'member',
    status: 'active',
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
    expiresAt: Date.now() + 60_000,
    ...overrides
  }
}

async function tempRoot(): Promise<string> {
  const root = path.join(process.cwd(), '.tmp-tests', `credential-${crypto.randomUUID()}`)
  roots.push(root)
  await mkdir(root, { recursive: true })
  return root
}

function cryptoProvider(backend = 'keychain') {
  return {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => backend),
    encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
    decryptString: vi.fn((value: Buffer) => value.toString().replace(/^encrypted:/, ''))
  }
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('OrgCredentialStore secure profile-scoped storage', () => {
  it('keeps both protocol credentials intact across Java login, quarantine, restore and logout', async () => {
    const root = await tempRoot()
    const legacy = new OrgCredentialStore(root, cryptoProvider())
    const java = OrgCredentialStore.forJava(root, cryptoProvider())
    const original = session()
    const javaSession: OrgSession = {
      authMode: 'management-java',
      accountKind: 'management',
      issuerId: 'server-1',
      authOrigin: 'https://management.example',
      userId: 'user-1',
      officialUserId: '',
      groupId: null,
      tenantId: 'tenant-1',
      displayName: 'User',
      phone: '',
      role: 'member',
      accessToken: 'java-secret',
      expiresAt: null
    }
    await legacy.save(original)
    const legacyBytes = await readFile(legacy.filePath, 'utf8')
    await java.save(javaSession)
    expect(java.filePath).not.toBe(legacy.filePath)
    expect(await readFile(legacy.filePath, 'utf8')).toBe(legacyBytes)
    await expect(java.load()).resolves.toEqual(javaSession)
    await java.quarantine()
    await expect(java.load()).resolves.toBeNull()
    await expect(legacy.load()).resolves.toEqual(original)
    await java.restoreQuarantined()
    await expect(java.load()).resolves.toEqual(javaSession)
    await java.clear()
    await expect(java.load()).resolves.toBeNull()
    expect(await readFile(legacy.filePath, 'utf8')).toBe(legacyBytes)
  })

  it('rejects credentials for the other protocol without overwriting either file', async () => {
    const root = await tempRoot()
    const java = OrgCredentialStore.forJava(root, cryptoProvider())
    await expect(java.save(session())).rejects.toThrow('凭据协议与当前存储不匹配')
    await expect(java.load()).resolves.toBeNull()
  })

  it('does not reuse another protocol or fall back to the shared legacy file', async () => {
    const root = await tempRoot()
    const legacy = new OrgCredentialStore(root, cryptoProvider())
    const java = OrgCredentialStore.forJava(root, cryptoProvider())
    await legacy.save(session())
    await expect(java.load()).resolves.toBeNull()
    const legacyBytes = await readFile(legacy.filePath, 'utf8')
    await writeFile(java.filePath, legacyBytes)
    await expect(java.load()).resolves.toBeNull()
    await expect(
      java.migrateLegacy({
        kind: 'authenticated',
        identityDigest: computeIdentityDigest({
          kind: 'authenticated',
          accountKind: 'management',
          issuerId: 'server-1',
          subjectId: 'user-1'
        })
      })
    ).resolves.toBeNull()
    expect(await readFile(legacy.filePath, 'utf8')).toBe(legacyBytes)
    expect(OrgCredentialStore.forJava(root, cryptoProvider()).filePath).toBe(java.filePath)
  })

  it('writes only an encrypted envelope under the explicit target profile root', async () => {
    const root = await tempRoot()
    const store = new OrgCredentialStore(root, cryptoProvider())

    await store.save(session())

    expect(store.filePath).toBe(path.join(root, 'userData', 'Sensitive', 'Enterprise', 'org-session.json'))
    const raw = await readFile(store.filePath, 'utf8')
    expect(raw).not.toContain('access-secret')
    expect(raw).not.toContain('refresh-secret')
    expect(JSON.parse(raw)).toMatchObject({ version: 1, encryption: 'safeStorage' })
    await expect(store.load()).resolves.toMatchObject({ userId: 'user-1', groupId: 'group-1' })
  })

  it('propagates unknown durability after the credential rename committed', async () => {
    const root = await tempRoot()
    const store = new OrgCredentialStore(root, cryptoProvider(), async () => {
      throw Object.assign(new Error('directory fsync failed'), { code: 'EIO' })
    })

    await expect(store.save(session())).resolves.toEqual<OrgCredentialWriteResult>({
      kind: 'committed-durability-unknown',
      reason: 'error',
      error: 'directory fsync failed'
    })
    await expect(store.load()).resolves.toMatchObject({ userId: 'user-1' })
  })

  it('can quarantine and restore credentials without deleting them first', async () => {
    const root = await tempRoot()
    const store = new OrgCredentialStore(root, cryptoProvider())
    await store.save(session())

    await expect(store.quarantine()).resolves.toMatchObject({ kind: 'committed-confirmed' })
    await expect(store.load()).resolves.toBeNull()
    await expect(store.restoreQuarantined()).resolves.toMatchObject({ kind: 'committed-confirmed' })
    await expect(store.load()).resolves.toMatchObject({ userId: 'user-1' })
  })

  it.each(['basic_text', ''])('fails closed when safeStorage backend is %j', async (backend) => {
    const root = await tempRoot()
    const store = new OrgCredentialStore(root, cryptoProvider(backend))

    await expect(store.save(session())).rejects.toThrow(/safeStorage/i)
  })

  it('fails closed when an encrypted envelope cannot be decrypted securely', async () => {
    const root = await tempRoot()
    const encrypted = new OrgCredentialStore(root, cryptoProvider())
    await encrypted.save(session())

    const unavailable = new OrgCredentialStore(root, cryptoProvider('basic_text'))
    await expect(unavailable.load()).rejects.toThrow(/safeStorage/i)
  })

  it('migrates a legacy plaintext session only when its identity matches the active profile', async () => {
    const root = await tempRoot()
    const store = new OrgCredentialStore(root, cryptoProvider())
    await mkdir(path.dirname(store.filePath), { recursive: true })
    await writeFile(store.filePath, JSON.stringify({ session: session() }))

    await expect(
      store.migrateLegacy({
        kind: 'authenticated',
        identityDigest: computeIdentityDigest({
          kind: 'authenticated',
          accountKind: 'management',
          issuerId: 'server-1',
          subjectId: 'other-user'
        })
      })
    ).resolves.toBeNull()
    expect(await readFile(store.filePath, 'utf8')).toContain('access-secret')

    await expect(
      store.migrateLegacy({
        kind: 'authenticated',
        identityDigest: computeIdentityDigest({
          kind: 'authenticated',
          accountKind: 'management',
          issuerId: 'server-1',
          subjectId: 'user-1'
        })
      })
    ).resolves.toMatchObject({ userId: 'user-1' })
    expect(await readFile(store.filePath, 'utf8')).not.toContain('access-secret')
  })
})
