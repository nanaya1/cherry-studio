import * as z from 'zod'

export const skillHubId = z
  .string()
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
export const skillHubVersion = z.string().min(1).max(100)
export const skillHubItem = z.object({
  id: skillHubId,
  version: skillHubVersion,
  name: z.string(),
  description: z.string().nullish(),
  iconUrl: z.string().optional(),
  industry: z.string(),
  domain: z.string(),
  author: z.string().nullish(),
  guide: z.string().nullish(),
  dependencies: z.array(skillHubId)
})
const facet = z.object({ id: z.string().regex(/^\d+$/), name: z.string() })
export const skillHubFilters = z.object({ industries: z.array(facet), domains: z.array(facet) })
export const skillHubPage = z.object({ records: z.array(skillHubItem), pages: z.number().int().nonnegative() })
export const skillHubQuery = z.object({
  pageNum: z.number().int().min(1).max(100000),
  keyword: z.string().max(200),
  industryId: z.string().regex(/^\d*$/),
  domainId: z.string().regex(/^\d*$/)
})
export const skillHubSelection = z.object({ id: skillHubId, version: skillHubVersion })

export function skillHubSource(id: string, version: string): string {
  return `skillhub:${id}@${encodeURIComponent(version)}`
}
