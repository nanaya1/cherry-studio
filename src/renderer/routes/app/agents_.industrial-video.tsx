/* eslint-disable naming/path-case -- TanStack 尾随下划线声明非嵌套路由，避免挂载 AgentPage。 */
import { createFileRoute, redirect } from '@tanstack/react-router'

// import { dataApiService } from '@data/DataApiService'
// import IndustrialVideoPage from '@renderer/pages/industrialVideo/IndustrialVideoPage'

// MEA:industrial-video 非嵌套页面，不挂载 AgentPage 或普通对话运行时。
export const Route = createFileRoute('/app/agents_/industrial-video')({
  validateSearch: (search): { sessionId?: string } => ({
    sessionId: typeof search.sessionId === 'string' ? search.sessionId : undefined
  }),
  beforeLoad: async ({ search }) => {
    if (!search.sessionId) throw redirect({ to: '/app/agents', replace: true })
    // const session = await dataApiService.get(`/agent-sessions/${search.sessionId}`)
    // if (session.featureKind !== 'industrial-video') {
    //   throw redirect({ to: '/app/agents', search: { sessionId: session.id }, replace: true })
    // }
    // return { session }
    // MEA:industrial-video 旧链接单向迁移到普通详情，分类不再触发反向重定向。
    throw redirect({ to: '/app/agents', search: { sessionId: search.sessionId }, replace: true })
  },
  component: IndustrialVideoRoute
})

function IndustrialVideoRoute() {
  // const { session } = Route.useRouteContext()
  // return <IndustrialVideoPage session={session} />
  return null
}
