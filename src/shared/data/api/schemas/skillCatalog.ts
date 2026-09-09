import { CatalogLocaleSchema, IndustryScopeSchema } from '@shared/types/skillCatalog'
import * as z from 'zod'

export const SkillCatalogQuerySchema = z.strictObject({
  locale: CatalogLocaleSchema.default('zh-CN')
})
export type SkillCatalogQuery = z.output<typeof SkillCatalogQuerySchema>

export const SkillCatalogFacetSchema = z.strictObject({
  code: z.string(),
  name: z.string()
})
export type SkillCatalogFacet = z.infer<typeof SkillCatalogFacetSchema>

export const SkillCatalogItemSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  industryScope: IndustryScopeSchema,
  industries: z.array(SkillCatalogFacetSchema),
  professionalDimensions: z.array(SkillCatalogFacetSchema),
  logoUrl: z.string().nullable(),
  installState: z.enum(['not-installed', 'installed', 'update-available']),
  installedSkillId: z.string().nullable()
})
export type SkillCatalogItem = z.infer<typeof SkillCatalogItemSchema>

export const SkillCatalogResponseSchema = z.strictObject({
  industries: z.array(SkillCatalogFacetSchema),
  professionalDimensions: z.array(SkillCatalogFacetSchema),
  skills: z.array(SkillCatalogItemSchema)
})
export type SkillCatalogResponse = z.infer<typeof SkillCatalogResponseSchema>

export type SkillCatalogSchemas = {
  '/skill-catalog': {
    GET: {
      query?: z.input<typeof SkillCatalogQuerySchema>
      response: SkillCatalogResponse
    }
  }
  '/skill-catalog/:catalogSkillId/install': {
    POST: {
      params: { catalogSkillId: string }
      response: { installedSkillId: string }
    }
  }
}
