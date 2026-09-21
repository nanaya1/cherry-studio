import { asc, eq, like } from 'drizzle-orm'
import { safeStorage } from 'electron'

import { application } from '@application'
import {
  agentRemoteKnowledgeBaseTable,
  assistantRemoteKnowledgeBaseTable,
  remoteKnowledgeServiceTable
} from '@data/db/schemas/remoteKnowledge'
import { loggerService } from '@logger'
import { BaseService, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import { DataApiErrorFactory, ErrorCode } from '@shared/data/api/errors'
import {
  buildRemoteKnowledgeBaseId,
  type CreateRemoteKnowledgeServiceDto,
  type RemoteKnowledgeBaseInfo,
  type RemoteKnowledgeServiceInfo,
  RemoteKnowledgeServiceInfoSchema,
  RemoteServiceDraftSchema,
  type RemoteTestConnectionResult,
  type UpdateRemoteKnowledgeServiceDto
} from '@shared/data/types/remoteKnowledge'

import { RemoteKnowledgeClient, type RemoteKnowledgeClientConfig } from './RemoteKnowledgeClient'

const logger = loggerService.withContext('RemoteKnowledgeService')

type RemoteKnowledgeServiceRow = typeof remoteKnowledgeServiceTable.$inferSelect

/** Rejects the v1-unsupported auth type early, before any persistence or I/O. */
function assertSupportedAuthType(authType: RemoteKnowledgeServiceInfo['authType']): void {
  if (authType === 'oauth2') {
    throw DataApiErrorFactory.create(ErrorCode.INVALID_OPERATION, 'oauth2 authentication is not supported yet')
  }
}

function encryptApiKey(plaintext: string): string {
  return safeStorage.encryptString(plaintext).toString('base64')
}

function decryptApiKey(ciphertext: string): string {
  // decryptString already returns the decoded utf8 string
  return safeStorage.decryptString(Buffer.from(ciphertext, 'base64'))
}

function rowToServiceInfo(row: RemoteKnowledgeServiceRow): RemoteKnowledgeServiceInfo {
  return RemoteKnowledgeServiceInfoSchema.parse({
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    authType: row.authType,
    headers: row.headers ?? undefined,
    timeoutMs: row.timeoutMs,
    enabled: row.enabled,
    hasApiKey: row.apiKeyEncrypted !== null && row.apiKeyEncrypted.length > 0,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString()
  })
}

function buildClientConfig(info: RemoteKnowledgeServiceInfo, apiKey?: string): RemoteKnowledgeClientConfig {
  return {
    id: info.id,
    name: info.name,
    baseUrl: info.baseUrl,
    authType: info.authType,
    ...(apiKey !== undefined ? { apiKey } : {}),
    hasApiKey: info.hasApiKey,
    headers: info.headers,
    timeoutMs: info.timeoutMs,
    enabled: info.enabled
  }
}

/**
 * Manages external knowledge service configuration (CRUD + connectivity test)
 * and hands decrypted, ready-to-use client configs to the lookup layer.
 *
 * The API key exists in plaintext only inside the main process: it is encrypted
 * with safeStorage before persistence and never leaves through list/getById —
 * those expose `hasApiKey` only. Deleting a service also deletes every
 * assistant/agent binding row whose composite id references it.
 */
@Injectable('RemoteKnowledgeService')
@ServicePhase(Phase.WhenReady)
export class RemoteKnowledgeService extends BaseService {
  private get db() {
    return application.get('DbService').getDb()
  }

  list(): RemoteKnowledgeServiceInfo[] {
    return this.db
      .select()
      .from(remoteKnowledgeServiceTable)
      .orderBy(asc(remoteKnowledgeServiceTable.createdAt))
      .all()
      .map(rowToServiceInfo)
  }

  getById(id: string): RemoteKnowledgeServiceInfo {
    const [row] = this.db
      .select()
      .from(remoteKnowledgeServiceTable)
      .where(eq(remoteKnowledgeServiceTable.id, id))
      .limit(1)
      .all()
    if (!row) {
      throw DataApiErrorFactory.notFound('RemoteKnowledgeService', id)
    }
    return rowToServiceInfo(row)
  }

  create(dto: CreateRemoteKnowledgeServiceDto): RemoteKnowledgeServiceInfo {
    assertSupportedAuthType(dto.authType)

    const parsed = RemoteServiceDraftSchema.safeParse(dto)
    if (!parsed.success) {
      throw DataApiErrorFactory.validation(
        Object.fromEntries(parsed.error.issues.map((issue) => [issue.path.join('.') || '_root', [issue.message]]))
      )
    }

    const [row] = application.get('DbService').withWriteTx((tx) =>
      tx
        .insert(remoteKnowledgeServiceTable)
        .values({
          name: dto.name,
          baseUrl: dto.baseUrl,
          authType: dto.authType,
          ...(dto.apiKey ? { apiKeyEncrypted: encryptApiKey(dto.apiKey) } : {}),
          headers: dto.headers,
          timeoutMs: dto.timeoutMs ?? 30_000,
          enabled: dto.enabled ?? true
        })
        .returning()
        .all()
    )

    logger.info('Created remote knowledge service', { id: row.id, name: row.name })
    return rowToServiceInfo(row)
  }

  update(id: string, dto: UpdateRemoteKnowledgeServiceDto): RemoteKnowledgeServiceInfo {
    const existingRow = this.getRawRow(id)
    if (dto.authType !== undefined) {
      assertSupportedAuthType(dto.authType)
    }

    const updates: Partial<typeof remoteKnowledgeServiceTable.$inferInsert> = {}
    if (dto.name !== undefined && dto.name !== existingRow.name) updates.name = dto.name
    if (dto.baseUrl !== undefined && dto.baseUrl !== existingRow.baseUrl) updates.baseUrl = dto.baseUrl
    if (dto.authType !== undefined && dto.authType !== existingRow.authType) updates.authType = dto.authType
    if (dto.headers !== undefined) updates.headers = dto.headers
    if (dto.timeoutMs !== undefined && dto.timeoutMs !== existingRow.timeoutMs) updates.timeoutMs = dto.timeoutMs
    if (dto.enabled !== undefined && dto.enabled !== existingRow.enabled) updates.enabled = dto.enabled
    // Empty string clears the key; omitted keeps the stored one.
    if (dto.apiKey !== undefined) {
      updates.apiKeyEncrypted = dto.apiKey ? encryptApiKey(dto.apiKey) : null
    }
    if (Object.keys(updates).length === 0) {
      return rowToServiceInfo(existingRow)
    }

    const [row] = application
      .get('DbService')
      .withWriteTx((tx) =>
        tx
          .update(remoteKnowledgeServiceTable)
          .set(updates)
          .where(eq(remoteKnowledgeServiceTable.id, id))
          .returning()
          .all()
      )

    logger.info('Updated remote knowledge service', { id, changes: Object.keys(dto) })
    return rowToServiceInfo(row)
  }

  delete(id: string): void {
    // Throws NOT_FOUND when absent.
    this.getById(id)

    application.get('DbService').withWriteTx((tx) => {
      tx.delete(remoteKnowledgeServiceTable).where(eq(remoteKnowledgeServiceTable.id, id)).run()
      // Composite ids embed the service id after the `remote:` prefix; a LIKE on
      // `remote:<id>:%` is the exact inverse of buildRemoteKnowledgeBaseId.
      const bindingFilter = like(agentRemoteKnowledgeBaseTable.remoteBaseId, `remote:${id}:%`)
      tx.delete(agentRemoteKnowledgeBaseTable).where(bindingFilter).run()
      tx.delete(assistantRemoteKnowledgeBaseTable)
        .where(like(assistantRemoteKnowledgeBaseTable.remoteBaseId, `remote:${id}:%`))
        .run()
    })

    logger.info('Deleted remote knowledge service and its bindings', { id })
  }

  /**
   * Connectivity probe for the settings page: pass a saved `id` XOR an unsaved
   * draft `config` (test-before-save). Expected failures — unreachable service,
   * bad credentials, unsupported auth type — come back as `{ok:false, error}`,
   * not thrown, so the UI can render them inline.
   */
  async testConnection(input: {
    id?: string
    config?: CreateRemoteKnowledgeServiceDto
  }): Promise<RemoteTestConnectionResult> {
    if (Boolean(input.id) === Boolean(input.config)) {
      throw DataApiErrorFactory.create(ErrorCode.VALIDATION_ERROR, 'Provide exactly one of id or config')
    }

    try {
      let client: RemoteKnowledgeClient
      if (input.id) {
        const info = this.getById(input.id)
        assertSupportedAuthType(info.authType)
        client = new RemoteKnowledgeClient(buildClientConfig(info, this.decryptStoredKey(info.id)))
      } else {
        const config = input.config!
        assertSupportedAuthType(config.authType)
        client = new RemoteKnowledgeClient({
          id: 'draft',
          baseUrl: config.baseUrl,
          authType: config.authType,
          ...(config.apiKey ? { apiKey: config.apiKey } : {}),
          headers: config.headers,
          timeoutMs: config.timeoutMs
        })
      }

      const startedAt = Date.now()
      await client.health()
      return { ok: true, latencyMs: Date.now() - startedAt }
    } catch (error) {
      // All probe failures — network, auth, unsupported auth type — surface as data
      // ({ok:false, error}) so the UI can render them inline instead of an error toast.
      logger.warn('Remote knowledge service connection test failed', {
        id: input.id,
        error: error instanceof Error ? error.message : String(error)
      })
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** True when at least one configured service is enabled — the kb-tools gate. */
  hasAnyEnabledService(): boolean {
    const [row] = this.db
      .select({ id: remoteKnowledgeServiceTable.id })
      .from(remoteKnowledgeServiceTable)
      .where(eq(remoteKnowledgeServiceTable.enabled, true))
      .limit(1)
      .all()
    return row !== undefined
  }

  /**
   * Lists remote bases from one service, or from every enabled service when
   * `serviceId` is omitted. A service that fails discovery is skipped with a
   * warning — kb_list must not lose local results over one dead remote.
   */
  async listRemoteBases(serviceId?: string): Promise<RemoteKnowledgeBaseInfo[]> {
    const services = (serviceId ? [this.getById(serviceId)] : this.list().filter((s) => s.enabled)).filter(
      (info) => info.enabled
    )

    const results = await Promise.all(
      services.map(async (info): Promise<RemoteKnowledgeBaseInfo[]> => {
        try {
          const client = new RemoteKnowledgeClient(buildClientConfig(info, this.decryptStoredKey(info.id)))
          const bases = await client.listBases()
          return bases.map((b) => ({
            id: buildRemoteKnowledgeBaseId(info.id, b.id),
            serviceId: info.id,
            serviceName: info.name,
            remoteBaseId: b.id,
            name: b.name,
            ...(b.description !== undefined ? { description: b.description } : {}),
            ...(b.documentCount !== undefined ? { documentCount: b.documentCount } : {})
          }))
        } catch (error) {
          logger.warn('Remote knowledge base discovery failed; skipping service', {
            serviceId: info.id,
            error: error instanceof Error ? error.message : String(error)
          })
          return []
        }
      })
    )
    return results.flat()
  }

  /** Decrypted client config for the lookup layer. Disabled/unknown → NOT_FOUND. */
  resolveClientConfig(serviceId: string): RemoteKnowledgeClientConfig {
    const info = this.getById(serviceId)
    if (!info.enabled) {
      throw DataApiErrorFactory.notFound('RemoteKnowledgeService', serviceId)
    }
    return buildClientConfig(info, this.decryptStoredKey(serviceId))
  }

  // ── internals ──

  private getRawRow(id: string): RemoteKnowledgeServiceRow {
    const [row] = this.db
      .select()
      .from(remoteKnowledgeServiceTable)
      .where(eq(remoteKnowledgeServiceTable.id, id))
      .limit(1)
      .all()
    if (!row) {
      throw DataApiErrorFactory.notFound('RemoteKnowledgeService', id)
    }
    return row
  }

  private decryptStoredKey(serviceId: string): string | undefined {
    const row = this.getRawRow(serviceId)
    return row.apiKeyEncrypted ? decryptApiKey(row.apiKeyEncrypted) : undefined
  }
}
