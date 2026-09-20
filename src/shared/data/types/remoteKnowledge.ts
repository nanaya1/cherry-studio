/**
 * Remote knowledge base service — shared contracts.
 *
 * This module is the single shared source of truth for talking to external
 * "remote" knowledge services. It owns two concerns:
 *
 * 1. **baseId tooling** — how a remote base is encoded into, and recovered
 *    from, the single `knowledgeBaseId` string the app already uses in its
 *    local schema. The format is `remote:<serviceId>:<remoteBaseId>`, where
 *    `<remoteBaseId>` is carried verbatim (no encoding) so arbitrary provider
 *    identifiers survive round-tripping.
 *
 * 2. **wire + domain schemas** — the data contracts for service metadata and
 *    the search/read HTTP protocol. Wire (on-the-wire) fields are `snake_case`
 *    per external API convention; internal/DTO usage stays `camelCase`.
 */

import * as z from 'zod'

export const REMOTE_KNOWLEDGE_BASE_ID_PREFIX = 'remote:'

// ============================================================================
// baseId utilities
// ============================================================================

/**
 * Encodes a remote knowledge base id as `remote:<serviceId>:<remoteBaseId>`.
 * The remote base id is concatenated verbatim — no encoding or filtering.
 */
export function buildRemoteKnowledgeBaseId(serviceId: string, remoteBaseId: string): string {
  return `${REMOTE_KNOWLEDGE_BASE_ID_PREFIX}${serviceId}:${remoteBaseId}`
}

/**
 * Decodes a remote knowledge base id into `{serviceId, remoteBaseId}` or null.
 * Splits only on the first colon after the prefix; both segments must be
 * non-empty. The prefix must be exactly lowercase `remote:`.
 */
export function parseRemoteKnowledgeBaseId(
  id: string
): { serviceId: string; remoteBaseId: string } | null {
  const prefix = REMOTE_KNOWLEDGE_BASE_ID_PREFIX
  if (!id.startsWith(prefix)) return null
  const rest = id.slice(prefix.length)
  const colonIndex = rest.indexOf(':')
  if (colonIndex < 0) return null
  const serviceId = rest.slice(0, colonIndex)
  const remoteBaseId = rest.slice(colonIndex + 1)
  if (serviceId.length === 0 || remoteBaseId.length === 0) return null
  return { serviceId, remoteBaseId }
}

/** Returns true when `id` is a well-formed remote knowledge base id. */
export function isRemoteKnowledgeBaseId(id: string): boolean {
  return parseRemoteKnowledgeBaseId(id) !== null
}

// ============================================================================
// Auth + service info schemas
// ============================================================================

export const RemoteAuthTypeSchema = z.enum(['bearer', 'api_key', 'oauth2'])
export type RemoteAuthType = z.infer<typeof RemoteAuthTypeSchema>

export const RemoteKnowledgeServiceInfoSchema = z.strictObject({
  id: z.string(),
  name: z.string().trim().min(1),
  baseUrl: z.string().url(),
  authType: RemoteAuthTypeSchema,
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.int().min(1000).max(300_000),
  enabled: z.boolean(),
  hasApiKey: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
})
export type RemoteKnowledgeServiceInfo = z.infer<typeof RemoteKnowledgeServiceInfoSchema>

// ============================================================================
// Wire schemas (snake_case)
// ============================================================================

/**
 * Inbound wire schemas use lenient objects on purpose: external services may add
 * forward-compatible fields at any time, and a strict parse would drop whole
 * chunks (or error envelopes) over keys we simply don't know. Only the request
 * schemas WE send are strict.
 */
export const RemoteWireChunkSchema = z.object({
  chunk_id: z.string().min(1),
  base_id: z.string().min(1),
  document_id: z.string().min(1),
  title: z.string(),
  content: z.string(),
  score: z.number().min(0).max(1),
  source: z
    .object({
      url: z.string().optional(),
      path: z.string().optional()
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
})
export type RemoteWireChunk = z.infer<typeof RemoteWireChunkSchema>

export const RemoteSearchRequestSchema = z.strictObject({
  query: z.string().trim().min(1).max(1000),
  base_ids: z.array(z.string().min(1)).min(1).max(32),
  top_k: z.int().min(1).max(50).optional(),
  rerank: z.boolean().optional(),
  filters: z.record(z.string(), z.unknown()).optional()
})
export type RemoteSearchRequest = z.infer<typeof RemoteSearchRequestSchema>

export const RemoteReadRequestSchema = z.strictObject({
  base_id: z.string().min(1),
  document_id: z.string().min(1),
  chunk_id: z.string().min(1).optional()
})
export type RemoteReadRequest = z.infer<typeof RemoteReadRequestSchema>

export const RemoteWireErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string()
  })
})
export type RemoteWireError = z.infer<typeof RemoteWireErrorSchema>

// ============================================================================
// Service config DTOs (settings UI → service → DB)
// ============================================================================

/**
 * Draft config for creating a service or testing an unsaved one. `apiKey` is
 * plaintext exactly once, at this boundary — the service encrypts it before
 * persistence and never returns it. Update reuses this shape with every field
 * optional; an omitted apiKey keeps the stored one.
 */
export const RemoteServiceDraftSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  baseUrl: z.string().url(),
  authType: RemoteAuthTypeSchema,
  apiKey: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.int().min(1000).max(300_000).optional(),
  enabled: z.boolean().optional()
})
export type RemoteServiceDraft = z.infer<typeof RemoteServiceDraftSchema>

export const CreateRemoteKnowledgeServiceSchema = RemoteServiceDraftSchema
export type CreateRemoteKnowledgeServiceDto = RemoteServiceDraft

export const UpdateRemoteKnowledgeServiceSchema = RemoteServiceDraftSchema.partial()
export type UpdateRemoteKnowledgeServiceDto = z.infer<typeof UpdateRemoteKnowledgeServiceSchema>

/** One remote base discovered from a service, with the composite id filled in. */
export const RemoteKnowledgeBaseInfoSchema = z.object({
  /** Full `remote:{serviceId}:{remoteBaseId}` identifier. */
  id: z.string(),
  serviceId: z.string(),
  serviceName: z.string(),
  remoteBaseId: z.string(),
  name: z.string().min(1),
  description: z.string().optional()
})
export type RemoteKnowledgeBaseInfo = z.infer<typeof RemoteKnowledgeBaseInfoSchema>

/** Connectivity-test result. Expected failures come back as data, not throws. */
export const RemoteTestConnectionResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.int().nonnegative().optional(),
  error: z.string().optional()
})
export type RemoteTestConnectionResult = z.infer<typeof RemoteTestConnectionResultSchema>
