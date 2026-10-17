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

import type { OrgApiClient } from './OrgApiClient'

const logger = loggerService.withContext('OrgKnowledgeClient')

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
  owner_id: z.number().int().safe().optional(),
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
  constructor(private readonly apiClient: OrgApiClient) {}

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
    return parseOrThrow(serverItemPageSchema, raw, 'items')
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
        parse_status: z.string().nullable().optional()
      }),
      // await this.apiClient['request'](`/api/kb/v1/files/${encodeURIComponent(fileId)}`),
      await this.apiClient['request'](`/api/kb/v1/files/${encodeURIComponent(fileId)}`, {
        signal: AbortSignal.timeout(30_000)
      }),
      'file'
    )
  }

  async deleteFile(fileId: string): Promise<void> {
    parseOrThrow(
      z.record(z.string(), z.unknown()),
      await this.apiClient['request'](`/api/kb/v1/files/${encodeURIComponent(fileId)}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(30_000)
      }),
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

  async createShareSpace(name: string): Promise<z.infer<typeof serverShareCreateSchema>> {
    const raw = await this.apiClient['request']('/api/kb/v1/local-share/spaces', {
      method: 'POST',
      body: JSON.stringify({ name, visibility: 1 }),
      signal: AbortSignal.timeout(30_000)
    })
    return parseOrThrow(serverShareCreateSchema, raw, 'local-share/spaces')
  }

  async createShareFolder(shareId: string, folder: { fileName: string }, parentId: string | null) {
    const raw = await this.apiClient['request'](
      `/api/kb/v1/local-share/spaces/${encodeURIComponent(shareId)}/folders`,
      {
        method: 'POST',
        body: JSON.stringify({ name: folder.fileName, parent_id: parentId }),
        signal: AbortSignal.timeout(30_000)
      }
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
      `/api/kb/v1/local-share/spaces/${encodeURIComponent(shareId)}/files`,
      form
    )
    return parseOrThrow(serverShareFileSchema, raw, 'local-share/files')
  }

  async uploadShareStream(
    shareId: string,
    // entry: { path: string; fileName: string; size: number; chunks: unknown[] },
    entry: { path: string; fileName: string; size: number; chunks: unknown[]; parentId?: string | null },
    progress: (bytes: number) => void
  ) {
    const raw = await this.apiClient.requestFileMultipart(
      `/api/kb/v1/local-share/spaces/${encodeURIComponent(shareId)}/files`,
      entry,
      progress
    )
    return parseOrThrow(serverShareFileSchema, raw, 'local-share/files')
  }

  async listShares(spaceId: string) {
    return parseShareResponse(
      z.array(serverShareSchema),
      await this.apiClient['request'](`/api/kb/v1/spaces/${encodeURIComponent(spaceId)}/shares`)
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
      { method: 'DELETE' }
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

  async listMembers(spaceId: string): Promise<z.infer<typeof serverMemberSchema>[]> {
    const raw = await this.apiClient['request'](`/api/kb/v1/spaces/${encodeURIComponent(spaceId)}/members`)
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
    await this.apiClient['request'](`/api/kb/v1/spaces/${encodeURIComponent(spaceId)}/members/${userId}`, {
      method: 'DELETE'
    })
  }

  /**
   * 取消分享：删除整个远端 space。沿用现有路由转换（scoped=client），不猜测新路由。
   * 204 无响应体由 request 返回 undefined 视为成功；403/404/超时抛错由上层保留本地绑定。
   * MEA:enterprise-knowledge-page 仅本人拥有的关联空间可删，本地副本保留。
   */
  async deleteShareSpace(spaceId: string): Promise<void> {
    await this.apiClient['request'](`/api/kb/v1/spaces/${encodeURIComponent(spaceId)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(30_000)
    })
  }
}

const catalogSchema = z.object({
  public: z.array(serverBaseSchema),
  shared: z.array(serverBaseSchema),
  owned: z.array(serverBaseSchema)
})
export type CatalogPayload = z.infer<typeof catalogSchema>
