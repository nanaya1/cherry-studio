import { createFileRoute } from '@tanstack/react-router'

import NewIndustrialVideoPage from '@renderer/pages/industrialVideo/NewIndustrialVideoPage'

// MEA:industrial-video 新建页不依赖已有 session。
export const Route = createFileRoute('/app/industrial-video')({
  component: NewIndustrialVideoPage
})
