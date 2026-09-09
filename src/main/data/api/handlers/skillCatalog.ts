import { application } from '@application'
import { DataApiErrorFactory, toDataApiError } from '@shared/data/api/errors'
import { SkillCatalogQuerySchema, type SkillCatalogSchemas } from '@shared/data/api/schemas/skillCatalog'
import type { HandlersFor } from '@shared/data/api/types'

export const skillCatalogHandlers: HandlersFor<SkillCatalogSchemas> = {
  '/skill-catalog': {
    GET: async ({ query }) => {
      const parsed = SkillCatalogQuerySchema.safeParse(query ?? {})
      if (!parsed.success) throw toDataApiError(parsed.error)
      return application.get('SkillCatalogService').list(parsed.data.locale)
    }
  },
  '/skill-catalog/:catalogSkillId/install': {
    POST: async ({ params }) => {
      try {
        const installedSkillId = await application.get('SkillCatalogService').install(params.catalogSkillId)
        return { installedSkillId }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Catalog skill is unavailable:')) {
          throw DataApiErrorFactory.notFound('Catalog skill', params.catalogSkillId)
        }
        throw error
      }
    }
  }
}
