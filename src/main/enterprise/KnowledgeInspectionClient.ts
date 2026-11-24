import * as z from 'zod'

import { t } from '@main/i18n'
import { encodeOrgId } from '@shared/data/types/enterpriseKnowledge'
import { InspectionContentSchema, InspectionRelationSchema } from '@shared/data/types/knowledgeInspection'

import { JavaKnowledgeClient } from './JavaKnowledgeClient'

const uuid = z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
const hex = z.string().regex(/^[0-9a-f]{32}$/)
const text = z
  .string()
  .nullish()
  .transform((value) => value ?? null)
const userId = z
  .number()
  .int()
  .positive()
  .safe()
  .nullish()
  .transform((value) => value ?? null)
function serverPage<T extends z.ZodType>(item: T) {
  return z
    .object({
      items: z.array(item),
      total: z.number().int().nonnegative(),
      current: z.number().int().positive(),
      size: z.number().int().positive()
    })
    .transform((row) => ({ items: row.items, total: row.total, page: row.current, pageSize: row.size }))
}
const spaceSchema = z
  .object({
    id: uuid,
    name: z.string(),
    description: text,
    ownerName: text,
    ownerId: z
      .number()
      .int()
      .nonnegative()
      .safe()
      .nullish()
      .transform((value) => value || null),
    updateTime: text,
    qaAuthorized: z.boolean(),
    inspectionView: z.literal(true),
    manageable: z.literal(false),
    editable: z.literal(false),
    canDownload: z.literal(false)
  })
  .transform((row) => ({
    id: encodeOrgId(row.id),
    name: row.name,
    description: row.description,
    ownerName: row.ownerName,
    ownerId: row.ownerId,
    updateTime: row.updateTime,
    qaAuthorized: row.qaAuthorized
  }))
const relationSchema = z
  .object({
    id: hex,
    sharerId: userId,
    sharerName: text,
    recipientId: userId,
    recipientName: text,
    status: z.string(),
    receiptCount: z.number().int().nonnegative().nullish(),
    maxViews: z.number().int().nonnegative().nullish(),
    viewCount: z.number().int().nonnegative().nullish(),
    createTime: text,
    updateTime: text,
    expiresAt: text
  })
  .transform((row) =>
    InspectionRelationSchema.parse({
      ...row,
      id: encodeOrgId(row.id),
      receiptCount: row.receiptCount ?? null,
      maxViews: row.maxViews ?? null,
      viewCount: row.viewCount ?? null
    })
  )

/** 仅能访问固定只读路由，不提供原件、检索或写入方法。 */
export class KnowledgeInspectionClient extends JavaKnowledgeClient {
  private async get(path: string, params: Record<string, unknown>, beforeSend: () => void) {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params))
      if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
    return this.json(`/api/v1/client/knowledge/inspection/${path}?${search}`, undefined, beforeSend)
  }

  async spaces(params: { page: number; keyword?: string }, guard: () => void) {
    return serverPage(spaceSchema).parse(await this.get('page', { ...params, pageSize: 20 }, guard))
  }
  async detail(id: string, guard: () => void) {
    const result = spaceSchema.parse(await this.get('detail', { id: uuid.parse(id) }, guard))
    if (result.id !== encodeOrgId(id)) throw new Error(t('enterprise.knowledge.web.invalid_target'))
    return result
  }
  async files(id: string, page: number, parentId: string | undefined, guard: () => void) {
    const schema = z
      .object({
        knowledgeId: z.literal(id),
        fileId: hex,
        name: z.string(),
        directory: z.boolean(),
        parseStatus: text,
        updateTime: text
      })
      .transform((row) => ({
        id: encodeOrgId(row.fileId),
        name: row.name,
        directory: row.directory,
        parseStatus: row.parseStatus,
        updateTime: row.updateTime
      }))
    return serverPage(schema).parse(
      await this.get(
        'file/page',
        {
          knowledgeId: uuid.parse(id),
          page,
          pageSize: 20,
          rootOnly: true,
          parentId: parentId ? hex.parse(parentId) : undefined
        },
        guard
      )
    )
  }
  async content(id: string, fileId: string, guard: () => void) {
    const result = z
      .object({
        knowledgeId: z.literal(id),
        fileId: z.literal(fileId),
        content: z.string(),
        totalChars: z.number().int().nonnegative().nullable(),
        truncated: z.boolean()
      })
      .parse(await this.get('content', { id: uuid.parse(id), fileId: hex.parse(fileId) }, guard))
    return InspectionContentSchema.parse({
      content: result.content,
      totalChars: result.totalChars,
      truncated: result.truncated
    })
  }
  async chunks(id: string, fileId: string, page: number, guard: () => void) {
    const schema = z
      .object({
        knowledgeId: z.literal(id),
        fileId: z.literal(fileId),
        chunkId: hex,
        content: z.string(),
        chunkIndex: z.number().int().nonnegative()
      })
      .transform(({ chunkId, content, chunkIndex }) => ({ id: encodeOrgId(chunkId), content, chunkIndex }))
    return serverPage(schema).parse(
      await this.get(
        'chunk/page',
        { knowledgeId: uuid.parse(id), fileId: hex.parse(fileId), page, pageSize: 20 },
        guard
      )
    )
  }
  async relations(
    kind: 'invitation/page' | 'share/page' | 'share/receipt/page',
    id: string,
    page: number,
    shareId: string | undefined,
    guard: () => void
  ) {
    return serverPage(relationSchema).parse(
      await this.get(
        kind,
        { knowledgeId: uuid.parse(id), page, pageSize: 20, shareId: shareId ? hex.parse(shareId) : undefined },
        guard
      )
    )
  }
}
