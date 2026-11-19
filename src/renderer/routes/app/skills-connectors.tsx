import { createFileRoute } from '@tanstack/react-router'
import * as z from 'zod'

import McpCatalog from '@renderer/pages/settings/McpSettings/McpCatalog'
import SkillsConnectorsPage from '@renderer/pages/workspace/SkillsConnectorsPage'

// MEA: 智能/助手编辑弹窗等场景需要直接落到「技能」或「连接器」二级 tab，
// 通过 tab search 参数定位；无参数时保持原默认（技能 tab）。
export const skillsConnectorsSearchSchema = z.object({
  tab: z.enum(['skill', 'connector']).optional()
})

export type SkillsConnectorsSearch = z.infer<typeof skillsConnectorsSearchSchema>

export const Route = createFileRoute('/app/skills-connectors')({
  validateSearch: (search) => skillsConnectorsSearchSchema.parse(search),
  component: SkillsConnectorsRouteComponent
})

function SkillsConnectorsRouteComponent() {
  // MEA: 从路由 search 读取 tab 定位参数，传给页面做初始二级 tab。
  // key 按 tab 取值：页面实例复用（KeepAlive / 重复跳转换参数）时也能落到目标 tab。
  const { tab } = Route.useSearch()
  return <SkillsConnectorsPage key={tab ?? 'skill'} connectorView={<McpCatalog />} initialTab={tab} />
}
