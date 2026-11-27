import { createFileRoute, redirect } from '@tanstack/react-router'
import * as z from 'zod'

import MarketplacePage from '@renderer/pages/marketplace/MarketplacePage'
import { ENABLE_CHERRY_OFFICIAL_SERVICES } from '@shared/utils/constants'

export const Route = createFileRoute('/app/marketplace')({
  validateSearch: z.object({
    mcpView: z.enum(['curated', 'sources']).optional(),
    mcpProvider: z.enum(['bailian', 'modelscope']).optional()
  }),
  beforeLoad: () => {
    if (!ENABLE_CHERRY_OFFICIAL_SERVICES) throw redirect({ to: '/app/skills-connectors', replace: true })
  },
  component: MarketplacePage
})
