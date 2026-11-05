/** [enterprise] Profile-scoped encrypted credential persistence. */
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { safeStorage } from 'electron'
import * as z from 'zod'

import { loggerService } from '@logger'
import { computeIdentityDigest, type ProfileRecordV1 } from '@main/core/profiles'
import { atomicWriteFile } from '@main/utils/file'
import { AbsoluteFilePathSchema } from '@shared/types/file'

const logger = loggerService.withContext('OrgCredentialStore')

// export const orgSessionSchema = z
const legacyOrgSessionSchema = z
  .strictObject({
    authMode: z.enum([
      'management-exchange',
      'management-oauth',
      'management-cookie',
      'official-direct'
      // [enterprise] Java Sa-Token 原生认证：token 头而非 Bearer，无 status/refresh/expires。
      // 'management-java'
    ]),
    accountKind: z.enum(['management', 'official']),
    issuerId: z.string().min(1),
    authOrigin: z.string().min(1),
    userId: z.string().min(1),
    officialUserId: z.string(),
    groupId: z.string().nullable(),
    // [enterprise] Java 路径必需的企业租户标识；旧会话可缺省（重登后写入真实上下文）。
    tenantId: z.string().optional(),
    displayName: z.string().nullable(),
    phone: z.string(),
    role: z.string(),
    // [enterprise] Java 路径不携带 status；以空字符串表达"由 Java 鉴权保证"，不写 active 占位。
    status: z.string(),
    // Cookie sessions (password login) carry no access token: the sid lives in
    // the isolated Electron session cookie jar, not in this encrypted file.
    accessToken: z.string(),
    refreshToken: z.string(),
    expiresAt: z.number()
  })
  .superRefine((session, ctx) => {
    if (session.authMode !== 'management-cookie' && session.accessToken.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accessToken is required for non-cookie sessions' })
    }
  })

// MEA:enterprise-java-auth 用独立分支表达无状态占位、无刷新和未知本地期限。
const javaOrgSessionSchema = z.strictObject({
  authMode: z.literal('management-java'),
  accountKind: z.literal('management'),
  issuerId: z.string().min(1),
  authOrigin: z.string().min(1),
  userId: z.string().min(1),
  officialUserId: z.string(),
  groupId: z.string().nullable(),
  tenantId: z.string().min(1),
  displayName: z.string().nullable(),
  phone: z.string(),
  role: z.string().min(1),
  accessToken: z.string().min(1),
  expiresAt: z.null()
})
export const orgSessionSchema = z.union([javaOrgSessionSchema, legacyOrgSessionSchema])
export type OrgSession = z.infer<typeof orgSessionSchema>

const legacyFileSchema = z.strictObject({ session: orgSessionSchema })
const encryptedFileSchema = z.strictObject({
  version: z.literal(1),
  encryption: z.literal('safeStorage'),
  payload: z.string().min(1)
})

export type OrgCredentialWriteResult =
  | { kind: 'committed-confirmed' }
  | { kind: 'committed-durability-unknown'; reason: 'unsupported' | 'error'; error: string }

export type OrgCredentialDurabilityConfirmer = (filePath: string) => Promise<void>

const unsupportedCodes = new Set(['EINVAL', 'EISDIR', 'ENOTSUP'])

async function confirmParentDirectoryDurability(filePath: string): Promise<void> {
  const directory = await open(dirname(filePath), 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

export interface OrgCredentialCrypto {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export class OrgCredentialStore {
  readonly filePath: string
  readonly quarantinePath: string

  constructor(
    profileRoot: string,
    private readonly crypto: OrgCredentialCrypto = safeStorage,
    private readonly confirmDurability: OrgCredentialDurabilityConfirmer = confirmParentDirectoryDurability
  ) {
    if (!profileRoot) throw new Error('OrgCredentialStore requires an explicit profileRoot')
    this.filePath = join(profileRoot, 'userData', 'Sensitive', 'Enterprise', 'org-session.json')
    this.quarantinePath = `${this.filePath}.quarantine`
  }

  async load(): Promise<OrgSession | null> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (this.isMissing(error)) return null
      throw error
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(raw)
    } catch {
      return null
    }
    const envelope = encryptedFileSchema.safeParse(decoded)
    if (!envelope.success) return null
    this.assertEncryptionAvailable()
    return orgSessionSchema.parse(JSON.parse(this.crypto.decryptString(Buffer.from(envelope.data.payload, 'base64'))))
  }

  async save(session: OrgSession): Promise<OrgCredentialWriteResult> {
    this.assertEncryptionAvailable()
    const parsed = orgSessionSchema.parse(session)
    const payload = this.crypto.encryptString(JSON.stringify(parsed)).toString('base64')
    await mkdir(dirname(this.filePath), { recursive: true })
    await atomicWriteFile(
      AbsoluteFilePathSchema.parse(this.filePath),
      JSON.stringify({ version: 1, encryption: 'safeStorage', payload }),
      { mode: 0o600 }
    )
    return this.durability(this.filePath)
  }

  async quarantine(): Promise<OrgCredentialWriteResult> {
    await rm(this.quarantinePath, { force: true })
    try {
      await rename(this.filePath, this.quarantinePath)
    } catch (error) {
      if (this.isMissing(error)) return { kind: 'committed-confirmed' }
      throw error
    }
    return this.durability(this.filePath)
  }

  async restoreQuarantined(): Promise<OrgCredentialWriteResult> {
    try {
      await rename(this.quarantinePath, this.filePath)
    } catch (error) {
      if (this.isMissing(error)) return { kind: 'committed-confirmed' }
      throw error
    }
    return this.durability(this.filePath)
  }

  async discardQuarantined(): Promise<void> {
    await rm(this.quarantinePath, { force: true })
  }

  async clear(): Promise<void> {
    try {
      await rm(this.filePath, { force: true })
    } catch (error) {
      logger.warn('failed to remove org session file', { error: String(error) })
      throw error
    }
  }

  async migrateLegacy(profile: Pick<ProfileRecordV1, 'kind' | 'identityDigest'>): Promise<OrgSession | null> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (this.isMissing(error)) return null
      throw error
    }
    const decoded = JSON.parse(raw)
    if (encryptedFileSchema.safeParse(decoded).success) return this.load()
    const legacy = legacyFileSchema.safeParse(decoded)
    if (!legacy.success) return null
    const session = legacy.data.session
    if (profile.kind !== 'authenticated') return null
    const identityDigest = computeIdentityDigest({
      kind: 'authenticated',
      accountKind: session.accountKind,
      issuerId: session.issuerId,
      subjectId: session.userId
    })
    if (identityDigest !== profile.identityDigest) return null
    await this.save(session)
    return session
  }

  private assertEncryptionAvailable(): void {
    const backend = this.crypto.getSelectedStorageBackend?.()
    if (!this.crypto.isEncryptionAvailable() || backend === 'basic_text' || backend === '') {
      throw new Error('safeStorage encryption is unavailable')
    }
  }

  private async durability(filePath: string): Promise<OrgCredentialWriteResult> {
    try {
      await this.confirmDurability(filePath)
      return { kind: 'committed-confirmed' }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const unsupported =
        (code !== undefined && unsupportedCodes.has(code)) ||
        (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES'))
      return {
        kind: 'committed-durability-unknown',
        reason: unsupported ? 'unsupported' : 'error',
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private isMissing(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
  }
}
