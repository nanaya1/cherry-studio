import * as z from 'zod'

// MEA:enterprise-knowledge-page 管理查看数据使用独立契约，不进入普通目录或聊天授权。
export const InspectionSpaceSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  ownerName: z.string().nullable(),
  ownerId: z.number().int().safe().nullable(),
  updateTime: z.string().nullable(),
  qaAuthorized: z.boolean()
})
export type InspectionSpace = z.infer<typeof InspectionSpaceSchema>

export const InspectionFileSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  directory: z.boolean(),
  parseStatus: z.string().nullable(),
  updateTime: z.string().nullable()
})
export type InspectionFile = z.infer<typeof InspectionFileSchema>

export const InspectionRelationSchema = z.strictObject({
  id: z.string(),
  sharerId: z.number().int().safe().nullable(),
  sharerName: z.string().nullable(),
  recipientId: z.number().int().safe().nullable(),
  recipientName: z.string().nullable(),
  status: z.string(),
  receiptCount: z.number().int().nonnegative().nullable(),
  maxViews: z.number().int().nonnegative().nullable(),
  viewCount: z.number().int().nonnegative().nullable(),
  createTime: z.string().nullable(),
  updateTime: z.string().nullable(),
  expiresAt: z.string().nullable()
})
export type InspectionRelation = z.infer<typeof InspectionRelationSchema>

export function inspectionPageSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({
    items: z.array(item),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive()
  })
}
export type InspectionPage<T> = { items: T[]; total: number; page: number; pageSize: number }

export const InspectionChunkSchema = z.strictObject({
  id: z.string(),
  content: z.string(),
  chunkIndex: z.number().int().nonnegative()
})
export type InspectionChunk = z.infer<typeof InspectionChunkSchema>
export const InspectionContentSchema = z.strictObject({
  content: z.string(),
  totalChars: z.number().int().nonnegative().nullable(),
  truncated: z.boolean()
})
export type InspectionContent = z.infer<typeof InspectionContentSchema>
