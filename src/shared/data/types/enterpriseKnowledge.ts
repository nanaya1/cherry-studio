import * as z from 'zod'

/**
 * [enterprise] 组织知识库（orgkb）跨进程数据类型与 ID 编解码。
 *
 * 所有面向渲染进程的 ID 均为 `orgkb:` 前缀的不透明编码；服务端原始 id 不暴露给渲染进程，
 * 渲染进程只回传编码后的 id，主进程解码后用于 HTTP 请求。编解码独立于 `remote:` 方案。
 */

const ORG_KB_PREFIX = 'orgkb:'

// base64url 编码：逐段编码整个不透明字符串，禁止对未经校验的 ':' 做 split 截断。
function toBase64Url(raw: string): string {
  const bytes = new TextEncoder().encode(raw)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(encoded: string): string {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

/**
 * 将服务端不透明 id 编码为渲染进程安全的 `orgkb:` 字符串。
 * 空串会被拒绝（服务端 id 不应为空）。
 */
export function encodeOrgId(raw: string): string {
  if (raw.length === 0) throw new Error('orgkb: 不能编码空 id')
  return `${ORG_KB_PREFIX}${toBase64Url(raw)}`
}

/** 是否为 orgkb 编码 id（仅看前缀，不校验内容）。 */
export function isOrgId(id: string): boolean {
  return typeof id === 'string' && id.startsWith(ORG_KB_PREFIX)
}

/**
 * 解码 orgkb id 为服务端原始 id；非法前缀或非法 base64url 返回 null（调用方应 fail closed）。
 */
export function parseOrgId(id: string): string | null {
  if (!isOrgId(id)) return null
  const raw = id.slice(ORG_KB_PREFIX.length)
  if (raw.length === 0) return null
  try {
    return fromBase64Url(raw)
  } catch {
    return null
  }
}

/**
 * 解码 orgkb id，非法时抛出协议错误（用于 IPC 入口处的输入校验）。
 */
export function requireOrgId(id: string, what = 'id'): string {
  const raw = parseOrgId(id)
  if (raw === null) throw new Error(`非法的组织知识库${what}: ${id}`)
  return raw
}

// ============================================================================
// 渲染进程契约（IPC 输出形态，camelCase）
// ============================================================================

export const OrgKnowledgeBaseSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  updatedAt: z.string().optional(),
  documentCount: z.number().int().nonnegative().optional(),
  localBaseId: z.string().optional(),
  shareCompleted: z.boolean().optional(),
  hasShareEvidence: z.boolean().optional(),
  allowLocalFileUpload: z.boolean().optional(),
  canDownload: z.boolean().optional()
})
export type OrgKnowledgeBase = z.infer<typeof OrgKnowledgeBaseSchema>

export const OrgKnowledgeCatalogSchema = z.strictObject({
  public: z.array(OrgKnowledgeBaseSchema),
  shared: z.array(OrgKnowledgeBaseSchema),
  owned: z.array(OrgKnowledgeBaseSchema)
})
export type OrgKnowledgeCatalog = z.infer<typeof OrgKnowledgeCatalogSchema>

export const OrgKnowledgeItemSchema = z.strictObject({
  id: z.string(),
  baseId: z.string(),
  type: z.string(),
  title: z.string(),
  status: z.string(),
  /** Parent directory item ID; null means the base root. */
  parentId: z.string().nullable(),
  documentId: z.string().nullable(),
  fileId: z.string().nullable().optional(),
  hasOriginalFile: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type OrgKnowledgeItem = z.infer<typeof OrgKnowledgeItemSchema>

export const OrgKnowledgeItemPageSchema = z.strictObject({
  items: z.array(OrgKnowledgeItemSchema),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable()
})
export type OrgKnowledgeItemPage = z.infer<typeof OrgKnowledgeItemPageSchema>

export const OrgKnowledgeChunkSchema = z.strictObject({
  id: z.string(),
  itemId: z.string(),
  documentId: z.string(),
  content: z.string(),
  chunkIndex: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown())
})
export type OrgKnowledgeChunk = z.infer<typeof OrgKnowledgeChunkSchema>

export const OrgKnowledgeChunkPageSchema = z.strictObject({
  chunks: z.array(OrgKnowledgeChunkSchema),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable()
})
export type OrgKnowledgeChunkPage = z.infer<typeof OrgKnowledgeChunkPageSchema>

export const OrgKnowledgeSearchChunkSchema = z.strictObject({
  chunkId: z.string(),
  baseId: z.string(),
  documentId: z.string(),
  title: z.string(),
  content: z.string(),
  score: z.number()
})
export type OrgKnowledgeSearchChunk = z.infer<typeof OrgKnowledgeSearchChunkSchema>

export const OrgKnowledgeSearchResultSchema = z.strictObject({
  chunks: z.array(OrgKnowledgeSearchChunkSchema)
})
export type OrgKnowledgeSearchResult = z.infer<typeof OrgKnowledgeSearchResultSchema>

export const OrgKnowledgeReadResultSchema = z.strictObject({
  documentId: z.string(),
  title: z.string(),
  content: z.string(),
  totalChars: z.number().int().nonnegative().nullable(),
  truncated: z.boolean()
})
export type OrgKnowledgeReadResult = z.infer<typeof OrgKnowledgeReadResultSchema>

/**
 * 原文预览结果。主进程通过鉴权 preview 接口拉取解析正文后回传正文/元信息，
 * 内联 PDF/图片可返回服务端签发并校验的临时 URL，仅供当前预览使用，不持久化。
 */
export const OrgKnowledgePreviewSchema = z.strictObject({
  kind: z.string(),
  fileName: z.string(),
  mimeType: z.string().nullable(),
  content: z.string(),
  url: z.url().optional(),
  // base64: z.string().max(14 * 1024 * 1024).optional(),
  base64: z.string().optional()
})
export type OrgKnowledgePreview = z.infer<typeof OrgKnowledgePreviewSchema>

export const OrgKnowledgeMemberSchema = z.strictObject({
  userId: z.number().int(),
  username: z.string(),
  role: z.string(),
  joinedAt: z.string(),
  status: z.string().nullable(),
  expiresAt: z.string().nullable()
})
export type OrgKnowledgeMember = z.infer<typeof OrgKnowledgeMemberSchema>

/**
 * 可邀请协作者（仅含 id 与 username，无任何敏感字段）。来自 GET /api/collaborators，
 * 仅返回 `status = 'active'` 的全局用户。返回的 `total` 为服务端真实计数，主进程过滤本人后
 * 不对其做任何虚构/扣减。
 */
export const OrgKnowledgeCollaboratorSchema = z.strictObject({
  id: z.number().int(),
  username: z.string()
})
export type OrgKnowledgeCollaborator = z.infer<typeof OrgKnowledgeCollaboratorSchema>

export const OrgKnowledgeCollaboratorListSchema = z.strictObject({
  items: z.array(OrgKnowledgeCollaboratorSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive()
})
export type OrgKnowledgeCollaboratorList = z.infer<typeof OrgKnowledgeCollaboratorListSchema>

export const OrgKnowledgeMemberListSchema = z.strictObject({
  members: z.array(OrgKnowledgeMemberSchema)
})
export type OrgKnowledgeMemberList = z.infer<typeof OrgKnowledgeMemberListSchema>

export const OrgKnowledgeInvitationSchema = z.strictObject({
  id: z.string(),
  spaceId: z.string(),
  name: z.string(),
  inviter: z.string().nullable(),
  role: z.string(),
  expires: z.string().nullable()
})
export type OrgKnowledgeInvitation = z.infer<typeof OrgKnowledgeInvitationSchema>

export const OrgKnowledgeInvitationListSchema = z.strictObject({
  invitations: z.array(OrgKnowledgeInvitationSchema)
})
export type OrgKnowledgeInvitationList = z.infer<typeof OrgKnowledgeInvitationListSchema>

const shareOrgId = z.string().refine((id) => !!parseOrgId(id), '非法的组织知识库 ID')
export const OrgKnowledgeShareCodeSchema = z
  .string()
  .min(8)
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/)
export const OrgKnowledgeSharePasswordSchema = z.string().min(4).max(32)
export const OrgKnowledgeCreateShareInputSchema = z.strictObject({
  baseId: shareOrgId,
  password: OrgKnowledgeSharePasswordSchema.optional(),
  maxViews: z.number().int().positive().safe().optional(),
  expireDays: z.number().int().min(1).max(365).nullable()
})
export const OrgKnowledgeReceiveShareInputSchema = z.strictObject({
  shareCode: OrgKnowledgeShareCodeSchema,
  password: OrgKnowledgeSharePasswordSchema.optional()
})
export const OrgKnowledgeShareSchema = z.strictObject({
  id: shareOrgId,
  spaceId: shareOrgId,
  shareCode: OrgKnowledgeShareCodeSchema,
  shareType: z.number().int().min(1).max(3),
  hasPassword: z.boolean(),
  maxViews: z.number().int().positive().safe().nullable(),
  viewCount: z.number().int().nonnegative().safe(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  revokedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true })
})
export type OrgKnowledgeShare = z.infer<typeof OrgKnowledgeShareSchema>
export const OrgKnowledgeShareListSchema = z.strictObject({ shares: z.array(OrgKnowledgeShareSchema) })
export const OrgKnowledgeReceiveShareResultSchema = z.strictObject({ baseId: shareOrgId, name: z.string() })

export const OrgKnowledgeShareFileStatusSchema = z.enum(['success', 'failure', 'unknown'])
export type OrgKnowledgeShareFileStatus = z.infer<typeof OrgKnowledgeShareFileStatusSchema>

export const OrgKnowledgeShareFileResultSchema = z.strictObject({
  fileName: z.string(),
  status: OrgKnowledgeShareFileStatusSchema,
  fileId: z.string().nullable(),
  chunkCount: z.number().int().nonnegative().nullable(),
  error: z.string().nullable()
})
export type OrgKnowledgeShareFileResult = z.infer<typeof OrgKnowledgeShareFileResultSchema>

// MEA:enterprise-knowledge-page 同步日志先于远端写入持久化，未知结果与旧新映射不能丢失。
export const OrgKnowledgeSyncStateSchema = z.enum([
  'unshared',
  'incomplete',
  'shared',
  'pending',
  'syncing',
  'failed',
  'unknown',
  'unconfirmed'
])
export const OrgKnowledgeSyncChangeSchema = z.strictObject({
  itemId: z.string(),
  fileName: z.string(),
  kind: z.enum(['add', 'update', 'rename', 'delete']),
  remoteFileId: z.string().nullable()
})
export type OrgKnowledgeSyncChange = z.infer<typeof OrgKnowledgeSyncChangeSchema>
export const OrgKnowledgeSyncPreviewSchema = z.strictObject({
  planId: z.string(),
  baseId: z.string(),
  shareId: z.string(),
  status: OrgKnowledgeSyncStateSchema,
  changes: z.array(OrgKnowledgeSyncChangeSchema),
  warnings: z.array(z.string())
})
export type OrgKnowledgeSyncPreview = z.infer<typeof OrgKnowledgeSyncPreviewSchema>
export const OrgKnowledgeSyncApplySchema = z.strictObject({
  status: z.enum(['complete', 'partial', 'unknown']),
  files: z.array(
    OrgKnowledgeSyncChangeSchema.omit({ remoteFileId: true }).extend({
      status: OrgKnowledgeShareFileStatusSchema,
      error: z.string().nullable()
    })
  ),
  shareId: z.string()
})
export type OrgKnowledgeSyncApply = z.infer<typeof OrgKnowledgeSyncApplySchema>
export const OrgKnowledgeSyncStatusSchema = z.strictObject({
  state: OrgKnowledgeSyncStateSchema,
  lastSyncedAt: z.string().nullable()
})
export type OrgKnowledgeSyncStatus = z.infer<typeof OrgKnowledgeSyncStatusSchema>
export const OrgKnowledgeSyncManifestSchema = z.strictObject({
  entries: z.array(
    z.strictObject({ itemId: z.string(), fileId: z.string().nullable(), fileName: z.string(), hash: z.string() })
  ),
  state: OrgKnowledgeSyncStateSchema,
  lastSyncedAt: z.string().nullable(),
  operations: z.array(
    OrgKnowledgeSyncChangeSchema.extend({
      newFileId: z.string().nullable(),
      hash: z.string().nullable(),
      phase: z.enum(['writing', 'verifying', 'cleanup_pending', 'complete', 'failure']),
      error: z.string().nullable()
    })
  )
})
export type OrgKnowledgeSyncManifest = z.infer<typeof OrgKnowledgeSyncManifestSchema>

export const OrgKnowledgeUploadProgressSchema = z.strictObject({
  uploadOriginal: z.boolean().optional(),
  // phase: z.enum(['counting', 'uploading', 'confirming', 'paused', 'completed', 'cleanup_pending', 'cleanup_unknown']),
  phase: z.enum([
    'preparing',
    'counting',
    'uploading',
    'confirming',
    'paused',
    'completed',
    'cleanup_pending',
    'cleanup_unknown'
  ]),
  totalBytes: z.number().nonnegative(),
  uploadedBytes: z.number().nonnegative(),
  completedFiles: z.number().int().nonnegative(),
  totalFiles: z.number().int().nonnegative(),
  currentFile: z.string().nullable(),
  error: z.string().nullable()
})
export type OrgKnowledgeUploadProgress = z.infer<typeof OrgKnowledgeUploadProgressSchema>

export const OrgKnowledgeShareResultSchema = z.strictObject({
  error: z.string().optional(),
  shareId: z.string(),
  files: z.array(OrgKnowledgeShareFileResultSchema),
  completion: z.enum(['completed', 'incomplete', 'unconfirmed']).default('unconfirmed'),
  manifest: OrgKnowledgeSyncManifestSchema.optional(),
  pendingAddition: z.boolean().optional()
})
export type OrgKnowledgeShareResult = z.infer<typeof OrgKnowledgeShareResultSchema>
