/**
 * [enterprise] 组织知识库 HTTP 适配器。
 * 薄封装 OrgApiClient 的会话/Cookie/Bearer 与 401 刷新逻辑，仅访问约定的组织知识库端点
 * （`/api/kb/catalog?scope=client` 与 `/api/kb/v1/*?scope=client`），对服务端响应做运行时
 * 协议校验（失败视为协议错误，fail closed）。所有 id 均为服务端原始形态，orgkb 编解码由
 * OrgKnowledgeService 负责。
 */
import * as z from 'zod'

import { loggerService } from '@logger'
import { OrgKnowledgeShareCodeSchema } from '@shared/data/types/enterpriseKnowledge'

import { ORG_SERVER_BASE_URL } from './OrgApiClient'
import type { OrgApiClient } from './OrgApiClient'
import type { OrgSession } from './types'

const logger = loggerService.withContext('OrgKnowledgeClient')

// 管理端提供 /api/kb 代理；官网直连模式直接使用知识服务 OpenAPI 的 /api/v1。
const localShareApiPrefix = ORG_SERVER_BASE_URL ? '/api/kb/v1/local-share' : '/api/v1/local-share'

export function getKnowledgeSpacePath(spaceId: string, useManagementProxy = Boolean(ORG_SERVER_BASE_URL)): string {
  const pathPrefix = useManagementProxy ? '/api/kb/v1/spaces' : '/api/v1/spaces'
  return `${pathPrefix}/${encodeURIComponent(spaceId)}`
}

/** 服务端返回 2xx 但结构不符合契约时抛出。 */
export class OrgKnowledgeProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrgKnowledgeProtocolError'
  }
}

// 服务端响应契约（宽松 object：容忍额外字段，仅校验业务必需字段）。
const serverBaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  updated_at: z.iso.datetime({ offset: true }).optional(),
  owner_id: z.number().int().safe().optional(),
  allow_local_file_upload: z.boolean().optional(),
  can_download: z.boolean().optional(),
  my_role: z.string().nullable().optional(),
  // SpaceOut 不含计数；兼容带摘要的响应，缺失计数保持未知。
  document_count: z.number().int().nonnegative().optional()
})
const serverItemSchema = z.object({
  id: z.string(),
  base_id: z.string(),
  group_id: z.string().nullable(),
  type: z.enum(['file', 'url', 'note', 'directory']),
  title: z.string(),
  status: z.enum(['idle', 'preparing', 'processing', 'reading', 'embedding', 'completed', 'failed', 'deleting']),
  error: z.string().nullable(),
  document_id: z.string().nullable(),
  has_original_file: z.boolean().optional(),
  data: z.record(z.string(), z.unknown()),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true })
})
const serverItemPageSchema = z.object({
  items: z.array(serverItemSchema),
  total: z.number().int().nonnegative(),
  next_cursor: z.union([z.string(), z.null()]).optional()
})
const serverChunkSchema = z.object({
  chunk_id: z.string(),
  item_id: z.string(),
  document_id: z.string(),
  content: z.string(),
  metadata: z.object({
    chunk_index: z.number().int().nonnegative(),
    token_count: z.number().int().nonnegative().nullable().optional(),
    source: z.string().nullable().optional(),
    item_type: z.enum(['file', 'url', 'note']).nullable().optional()
  })
})
const serverChunkPageSchema = z.object({
  chunks: z.array(serverChunkSchema),
  total: z.number().int().nonnegative(),
  next_cursor: z.union([z.string(), z.null()]).optional()
})
const serverSearchChunkSchema = z.object({
  chunk_id: z.string().min(1),
  base_id: z.string().min(1),
  document_id: z.string().min(1),
  title: z.string(),
  content: z.string(),
  score: z.number().min(0).max(1),
  source: z.record(z.string(), z.string()).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional()
})
const serverSearchSchema = z.object({ chunks: z.array(serverSearchChunkSchema) })
const serverReadSchema = z.object({
  document_id: z.string().min(1),
  title: z.string(),
  content: z.string(),
  total_chars: z.number().int().nonnegative().nullable().optional(),
  truncated: z.boolean().default(false)
})
const serverPreviewUrlSchema = z.object({
  kind: z.string(),
  url: z.string().nullable().optional(),
  file_name: z.string(),
  mime_type: z.string().nullable().optional()
})
const serverMemberSchema = z.object({
  user_id: z.number().int(),
  username: z.string().default(''),
  role: z.string(),
  joined_at: z.iso.datetime({ offset: true }),
  status: z.string().default('active'),
  expires_at: z.iso.datetime({ offset: true }).nullable().optional()
})
const serverCollaboratorListSchema = z.object({
  items: z.array(z.object({ id: z.number().int(), username: z.string() })),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive()
})
const serverInvitationSchema = z.object({
  id: z.uuid(),
  space_id: z.uuid(),
  name: z.string(),
  inviter: z.number().int().nullable(),
  role: z.string(),
  expires: z.iso.datetime({ offset: true }).nullable()
})
const serverShareCreateSchema = z.object({
  share_id: z.string(),
  knowledge_base_name: z.string().nullable().optional(),
  visibility: z.number().int().default(1),
  is_space: z.boolean().default(true),
  space_id: z.string().nullable().optional()
})
const serverShareFileSchema = z.object({
  share_id: z.string(),
  file_id: z.string(),
  chunk_count: z.number().int()
})

const serverShareSchema = z.object({
  id: z.uuid(),
  space_id: z.uuid(),
  share_code: OrgKnowledgeShareCodeSchema,
  share_type: z.number().int().min(1).max(3),
  has_password: z.boolean().default(false),
  max_views: z.number().int().positive().safe().nullable(),
  view_count: z.number().int().nonnegative().safe(),
  expires_at: z.iso.datetime({ offset: true }).nullable(),
  revoked_at: z.iso.datetime({ offset: true }).nullable(),
  created_at: z.iso.datetime({ offset: true })
})

function parseShareResponse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data)
  // 分享响应可能含凭据，校验错误不可携带原始字段值或路径。
  if (!result.success) throw new OrgKnowledgeProtocolError('分享响应结构不符合契约')
  return result.data
}

function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, where: string): T {
  const result = schema.safeParse(data)
  if (!result.success) {
    logger.warn('org knowledge protocol mismatch', { where, error: result.error.message })
    throw new OrgKnowledgeProtocolError(`${where} 响应结构不符合契约: ${result.error.message}`)
  }
  return result.data
}

export class OrgKnowledgeClient {
  // constructor(private readonly apiClient: OrgApiClient) {}
  constructor(
    private readonly apiClient: OrgApiClient,
    private readonly acquireWriteGuard?: () => (session?: OrgSession) => void
  ) {}

  private url(path: string, query?: Record<string, string | number | undefined | null>): string {
    if (!query) return path
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
    }
    const qs = params.toString()
    return qs ? `${path}?${qs}` : path
  }

  async getCatalog(): Promise<CatalogPayload> {
    const raw = await this.apiClient['request']('/api/kb/catalog?scope=client')
    return parseOrThrow(catalogSchema, raw, 'catalog')
  }

  async listItems(baseId: string, cursor?: string | null): Promise<z.infer<typeof serverItemPageSchema>> {
    const path = this.url(`/api/kb/v1/knowledge/bases/${encodeURIComponent(baseId)}/items`, {
      cursor: cursor ?? undefined
    })
    // [enterprise] 目录与授权结果不作为永久离线授权缓存：每次实时拉取。
    // const raw = await this.apiClient['request'](path)
    // MEA:enterprise-knowledge-page 首次分享核对沿用普通HTTP的30秒超时。
    const raw = await this.apiClient['request'](path, { signal: AbortSignal.timeout(30_000) })
    // return parseOrThrow(serverItemPageSchema, raw, 'items')
    // MEA:enterprise-knowledge-page 列表整体校验归属，禁止标题新库却显示其他库文件。
    const page = parseOrThrow(serverItemPageSchema, raw, 'items')
    if (page.items.some((item) => item.base_id !== baseId)) throw new OrgKnowledgeProtocolError('items.base_id')
    return page
  }

  async listChunks(
    baseId: string,
    itemId: string,
    cursor?: string | null
  ): Promise<z.infer<typeof serverChunkPageSchema>> {
    const path = this.url(
      `/api/kb/v1/knowledge/bases/${encodeURIComponent(baseId)}/items/${encodeURIComponent(itemId)}/chunks`,
      { cursor: cursor ?? undefined }
    )
    // const raw = await this.apiClient['request'](path)
    const raw = await this.apiClient['request'](path, { signal: AbortSignal.timeout(30_000) })
    return parseOrThrow(serverChunkPageSchema, raw, 'chunks')
  }

  async search(params: {
    baseIds: string[]
    query: string
    topK?: number
    rerank?: boolean
  }): Promise<z.infer<typeof serverSearchSchema>> {
    const raw = await this.apiClient['request']('/api/kb/v1/knowledge/search', {
      method: 'POST',
      body: JSON.stringify({
        query: params.query,
        base_ids: params.baseIds,
        top_k: params.topK,
        rerank: params.rerank,
        filters: {}
      })
    })
    return parseOrThrow(serverSearchSchema, raw, 'search')
  }

  async read(params: {
    baseId: string
    documentId: string
    chunkId?: string | null
  }): Promise<z.infer<typeof serverReadSchema>> {
    const raw = await this.apiClient['request']('/api/kb/v1/knowledge/read', {
      method: 'POST',
      body: JSON.stringify({
        base_id: params.baseId,
        document_id: params.documentId,
        chunk_id: params.chunkId ?? null
      })
    })
    return parseOrThrow(serverReadSchema, raw, 'read')
  }

  async getPreviewUrl(fileId: string): Promise<z.infer<typeof serverPreviewUrlSchema>> {
    const raw = await this.apiClient['request'](`/api/kb/v1/files/${encodeURIComponent(fileId)}/preview-url`)
    return parseOrThrow(serverPreviewUrlSchema, raw, 'preview-url')
  }

  async fetchPreviewContent(fileId: string): Promise<string> {
    return this.apiClient.requestText(`/api/kb/v1/files/${encodeURIComponent(fileId)}/preview`)
  }

  async fetchPreviewBytes(fileId: string): Promise<Buffer> {
    // return this.apiClient.requestBytes(`/api/kb/v1/files/${encodeURIComponent(fileId)}/preview`, 10 * 1024 * 1024)
    return this.apiClient.requestBytes(`/api/kb/v1/files/${encodeURIComponent(fileId)}/preview`)
  }

  async fetchPresignedPreviewBytes(url: string, maxBytes: number): Promise<Buffer> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('预签名预览地址无效')
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
      throw new Error('预签名预览地址无效')
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('预签名预览大小上限无效')

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await fetch(parsed.href, { credentials: 'omit', signal: controller.signal })
      if (!response.ok) throw new Error(`预签名预览请求失败 (HTTP ${response.status})`)
      const contentLength = response.headers.get('content-length')
      if (contentLength !== null) {
        const declaredSize = Number(contentLength)
        if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) throw new Error('预签名预览响应大小无效')
        if (declaredSize > maxBytes) throw new Error('预签名预览响应过大')
      }
      if (!response.body) {
        const bytes = Buffer.from(await response.arrayBuffer())
        if (bytes.length > maxBytes) throw new Error('预签名预览响应过大')
        return bytes
      }

      reader = response.body.getReader()
      const chunks: Buffer[] = []
      let total = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = Buffer.from(value)
        total += chunk.length
        if (total > maxBytes) throw new Error('预签名预览响应过大')
        chunks.push(chunk)
      }
      return Buffer.concat(chunks, total)
    } catch (error) {
      controller.abort()
      if (reader) await reader.cancel().catch(() => undefined)
      throw error
    } finally {
      reader?.releaseLock()
      clearTimeout(timeout)
    }
  }

  async resolveFileId(documentId: string): Promise<string | null> {
    const raw = await this.apiClient['request'](`/api/kb/v1/files/${encodeURIComponent(documentId)}`)
    const file = parseOrThrow(z.object({ id: z.string(), is_dir: z.boolean() }), raw, 'file')
    return file.id === documentId && !file.is_dir ? file.id : null
  }

  async getFile(fileId: string) {
    return parseOrThrow(
      z.object({
        id: z.string(),
        space_id: z.string(),
        name: z.string(),
        is_dir: z.boolean(),
        parent_id: z.string().nullable().optional(),
        file_hash: z.string().nullable().optional(),
        parse_status: z.string().nullable().optional(),
        has_original_file: z.boolean().optional()
      }),
      // await this.apiClient['request'](`/api/kb/v1/files/${encodeURIComponent(fileId)}`),
      await this.apiClient['request'](`/api/kb/v1/files/${encodeURIComponent(fileId)}`, {
        signal: AbortSignal.timeout(30_000)
      }),
      'file'
    )
  }

  async listRecoveryFiles(spaceId: string, parentId: string | null, page: number) {
    const { recoveryFileSchema } = await import('./CloudKnowledgeRecovery')
    return parseOrThrow(
      z.object({
        folders: z.array(recoveryFileSchema),
        files: z.array(recoveryFileSchema),
        total: z.number().int().nonnegative()
      }),
      await this.apiClient['request'](
        this.url(`${getKnowledgeSpacePath(spaceId)}/files`, {
          parent_id: parentId ?? undefined,
          page,
          page_size: 100
        }),
        { signal: AbortSignal.timeout(30_000) }
      ),
      'recovery-files'
    )
  }

  async listSpaceFiles(spaceId: string, parentId: string | null, page: number) {
    return parseOrThrow(
      z.object({
        folders: z.array(z.object({
          id: z.string().min(1),
          space_id: z.string().min(1),
          parent_id: z.string().nullable(),
          name: z.string(),
          is_dir: z.literal(true),
          has_original_file: z.boolean().default(false),
          updated_at: z.string()
        })),
        files: z.array(z.object({
          id: z.string().min(1),
          space_id: z.string().min(1),
          parent_id: z.string().nullable(),
          name: z.string(),
          is_dir: z.literal(false),
          has_original_file: z.boolean().default(false),
          updated_at: z.string()
        })),
        total: z.number().int().nonnegative(),
        page: z.number().int().positive(),
        page_size: z.number().int().positive()
      }),
      await this.apiClient['request'](
        this.url(`${getKnowledgeSpacePath(spaceId)}/files`, {
          parent_id: parentId ?? undefined,
          page,
          page_size: 100
        }),
        { signal: AbortSignal.timeout(30_000) }
      ),
      'space-files'
    )
  }

  downloadOriginal(fileId: string, destination: string): Promise<void> {
    return this.apiClient.downloadKnowledgeFile(fileId, destination)
  }

  async deleteFile(fileId: string): Promise<void> {
    parseOrThrow(
      z.record(z.string(), z.unknown()),
      await this.apiClient['request'](
        `/api/kb/v1/files/${encodeURIComponent(fileId)}`,
        {
          method: 'DELETE',
          signal: AbortSignal.timeout(30_000)
        },
        this.acquireWriteGuard?.()
      ),
      'delete-file'
    )
  }

  async renameFile(fileId: string, name: string) {
    return parseOrThrow(
      z.object({ id: z.string(), space_id: z.string(), name: z.string(), is_dir: z.boolean() }),
      await this.apiClient['request'](`/api/kb/v1/files/${encodeURIComponent(fileId)}`, {
        method: 'PUT',
        body: JSON.stringify({ name }),
        signal: AbortSignal.timeout(30_000)
      }),
      'rename-file'
    )
  }

  async getItem(baseId: string, itemId: string) {
    return parseOrThrow(
      serverItemSchema,
      await this.apiClient['request'](
        // `/api/kb/v1/knowledge/bases/${encodeURIComponent(baseId)}/items/${encodeURIComponent(itemId)}`
        `/api/kb/v1/knowledge/bases/${encodeURIComponent(baseId)}/items/${encodeURIComponent(itemId)}`,
        { signal: AbortSignal.timeout(30_000) }
      ),
      'item'
    )
  }

  async getSpace(spaceId: string) {
    return parseOrThrow(
      serverBaseSchema,
      // await this.apiClient['request'](`/api/v1/spaces/${encodeURIComponent(spaceId)}`, {
      await this.apiClient['request'](getKnowledgeSpacePath(spaceId), {
        signal: AbortSignal.timeout(30_000)
      }),
      'space'
    )
  }

  async createShareSpace(name: string, uploadOriginal = true): Promise<z.infer<typeof serverShareCreateSchema>> {
    const raw = await this.apiClient['request'](
      `${localShareApiPrefix}/spaces`,
      {
        method: 'POST',
        // body: JSON.stringify({ name, visibility: 1 }),
        body: JSON.stringify({ name, allow_local_file_upload: uploadOriginal }),
        signal: AbortSignal.timeout(30_000)
      },
      this.acquireWriteGuard?.()
    )
    return parseOrThrow(serverShareCreateSchema, raw, 'local-share/spaces')
  }

  async createShareFolder(shareId: string, folder: { fileName: string }, parentId: string | null) {
    const raw = await this.apiClient['request'](
      `${localShareApiPrefix}/spaces/${encodeURIComponent(shareId)}/folders`,
      {
        method: 'POST',
        body: JSON.stringify({ name: folder.fileName, parent_id: parentId }),
        signal: AbortSignal.timeout(30_000)
      },
      this.acquireWriteGuard?.()
    )
    return parseOrThrow(
      z.object({
        folder_id: z.string().min(1),
        name: z.string(),
        space_id: z.string(),
        parent_id: z.string().nullable().optional()
      }),
      raw,
      'local-share/folders'
    )
  }

  async uploadShareFile(shareId: string, form: FormData): Promise<z.infer<typeof serverShareFileSchema>> {
    // [enterprise] FormData 不设置 application/json：boundary 由 fetch 自行决定。
    const raw = await this.apiClient.requestMultipart(
      `${localShareApiPrefix}/spaces/${encodeURIComponent(shareId)}/files`,
      form
    )
    return parseOrThrow(serverShareFileSchema, raw, 'local-share/files')
  }

  async uploadShareStream(
    shareId: string,
    // entry: { path: string; fileName: string; size: number; chunks: unknown[] },
    entry: {
      path: string
      fileName: string
      size: number
      chunks: unknown[]
      parentId?: string | null
      uploadOriginal?: boolean
    },
    progress: (bytes: number) => void,
    beforeStop?: (error: unknown) => void,
    signal?: AbortSignal
  ) {
    const raw = await this.apiClient.requestFileMultipart(
      `${localShareApiPrefix}/spaces/${encodeURIComponent(shareId)}/files`,
      entry,
      progress,
      this.acquireWriteGuard?.(),
      beforeStop,
      signal
    )
    return parseOrThrow(serverShareFileSchema, raw, 'local-share/files')
  }

  async listShares(spaceId: string, signal?: AbortSignal) {
    return parseShareResponse(
      z.array(serverShareSchema),
      await this.apiClient['request'](
        `/api/kb/v1/spaces/${encodeURIComponent(spaceId)}/shares`,
        ...(signal ? [{ signal }] : [])
      )
    )
  }

  async createShareCode(spaceId: string, params: { password?: string; maxViews?: number; expireDays: number | null }) {
    const raw = await this.apiClient['request'](`/api/kb/v1/spaces/${encodeURIComponent(spaceId)}/shares`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        share_type: 1,
        password: params.password,
        max_views: params.maxViews,
        expire_days: params.expireDays
      })
    })
    return parseShareResponse(serverShareSchema, raw)
  }

  async revokeShare(spaceId: string, shareId: string): Promise<void> {
    await this.apiClient['request'](
      `/api/kb/v1/spaces/${encodeURIComponent(spaceId)}/shares/${encodeURIComponent(shareId)}`,
      { method: 'DELETE' },
      this.acquireWriteGuard?.()
    )
  }

  async receiveShare(params: { shareCode: string; password?: string }) {
    const raw = await this.apiClient['request'](`/api/kb/v1/shares/${encodeURIComponent(params.shareCode)}/receive`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ password: params.password })
    })
    return parseShareResponse(z.object({ id: z.uuid(), name: z.string() }), raw)
  }

  async listMembers(spaceId: string, signal?: AbortSignal): Promise<z.infer<typeof serverMemberSchema>[]> {
    const raw = await this.apiClient['request'](`/api/kb/v1/spaces/${encodeURIComponent(spaceId)}/members`, { signal })
    return parseOrThrow(z.array(serverMemberSchema), raw, 'members')
  }

  /**
   * 可邀请协作者（GET /api/collaborators）：仅返回 `status = 'active'` 的全局用户，分页与
   * 关键字过滤全部由服务端完成。注意该端点不在 `/api/kb/v1/` 下，不附加 `scope=client`。
   */
  async listCollaborators(params: {
    keyword?: string
    page?: number
    pageSize?: number
  }): Promise<z.infer<typeof serverCollaboratorListSchema>> {
    const path = this.url('/api/collaborators', {
      keyword: params.keyword?.trim() ? params.keyword.trim() : undefined,
      page: params.page,
      pageSize: params.pageSize
    })
    const raw = await this.apiClient['request'](path)
    return parseOrThrow(serverCollaboratorListSchema, raw, 'collaborators')
  }

  async addMember(spaceId: string, userId: number, expireDays?: number): Promise<z.infer<typeof serverMemberSchema>> {
    const raw = await this.apiClient['request'](`/api/kb/v1/spaces/${encodeURIComponent(spaceId)}/members`, {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, role: 'viewer', expire_days: expireDays })
    })
    return parseOrThrow(serverMemberSchema, raw, 'add-member')
  }

  async listInvitations(): Promise<z.infer<typeof serverInvitationSchema>[]> {
    const raw = await this.apiClient['request']('/api/kb/v1/invitations')
    return parseOrThrow(z.array(serverInvitationSchema), raw, 'invitations')
  }

  async acceptInvitation(invitationId: string): Promise<z.infer<typeof serverMemberSchema>> {
    const raw = await this.apiClient['request'](`/api/kb/v1/invitations/${encodeURIComponent(invitationId)}/accept`, {
      method: 'POST'
    })
    return parseOrThrow(serverMemberSchema, raw, 'accept-invitation')
  }

  async declineInvitation(invitationId: string): Promise<z.infer<typeof serverMemberSchema>> {
    const raw = await this.apiClient['request'](`/api/kb/v1/invitations/${encodeURIComponent(invitationId)}/decline`, {
      method: 'POST'
    })
    return parseOrThrow(serverMemberSchema, raw, 'decline-invitation')
  }

  async removeMember(spaceId: string, userId: number): Promise<void> {
    // DELETE 可能返回 204 无响应体；request 对空响应体返回 undefined 即视为成功。
    await this.apiClient['request'](
      `/api/kb/v1/spaces/${encodeURIComponent(spaceId)}/members/${userId}`,
      {
        method: 'DELETE'
      },
      this.acquireWriteGuard?.()
    )
  }

  /**
   * 取消分享：删除整个远端 space。沿用现有路由转换（scoped=client），不猜测新路由。
   * 204 无响应体由 request 返回 undefined 视为成功；403/404/超时抛错由上层保留本地绑定。
   * MEA:enterprise-knowledge-page 仅本人拥有的关联空间可删，本地副本保留。
   */
  async deleteShareSpace(spaceId: string): Promise<void> {
    await this.apiClient['request'](
      `/api/kb/v1/spaces/${encodeURIComponent(spaceId)}`,
      {
        method: 'DELETE',
        signal: AbortSignal.timeout(30_000)
      },
      this.acquireWriteGuard?.()
    )
  }

  /**
   * 重命名已分享云端空间。管理端经 /api/kb/v1 代理，官网直连使用上游 /api/v1。
   * 仅按传入的 spaceId 提交改名，不按名称认领/查找云端空间。
   */
  async renameSpace(spaceId: string, name: string) {
    return parseOrThrow(
      z.object({ id: z.string(), name: z.string() }),
      await this.apiClient['request'](
        getKnowledgeSpacePath(spaceId),
        {
          method: 'PUT',
          body: JSON.stringify({ name }),
          signal: AbortSignal.timeout(30_000)
        },
        this.acquireWriteGuard?.()
      ),
      'rename-space'
    )
  }
}

const catalogSchema = z.object({
  public: z.array(serverBaseSchema),
  shared: z.array(serverBaseSchema),
  owned: z.array(serverBaseSchema)
})
export type CatalogPayload = z.infer<typeof catalogSchema>
