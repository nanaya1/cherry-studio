import { createFileRoute, redirect } from '@tanstack/react-router'

// import { dataApiService } from '@data/DataApiService'
import AgentPage from '@renderer/pages/agents/AgentPage'
import { parseAgentRouteSearch } from '@renderer/pages/agents/routeSearch'
import { resolveAgentEntrySessionId, resolveAgentEntrySessionIdForAgent } from '@renderer/utils/conversationEntry'

export const Route = createFileRoute('/app/agents')({
  validateSearch: (search) => parseAgentRouteSearch(search),
  // Resolving before mount renders the final conversation in one pass. A sidebar
  // `?agentId=` entry must resume that agent, not the globally last-focused session.
  beforeLoad: async ({ search }) => {
    // MEA:industrial-video 原入口仅按 sessionId 跳转；挂载前读取分类，避免进入普通 Agent 循环。
    // if (search.sessionId || search.intent) return
    // if (search.agentId) {
    //   const sessionId = await resolveAgentEntrySessionIdForAgent(search.agentId)
    //   if (sessionId) throw redirect({ to: '/app/agents', search: { sessionId }, replace: true })
    //   return
    // }
    // const sessionId = await resolveAgentEntrySessionId()
    if (search.intent && !search.sessionId) return
    const sessionId =
      search.sessionId ??
      (search.agentId ? await resolveAgentEntrySessionIdForAgent(search.agentId) : await resolveAgentEntrySessionId())
    if (!sessionId) return
    // const session = await dataApiService.get(`/agent-sessions/${sessionId}`)
    // if (session.featureKind === 'industrial-video') {
    //   throw redirect({ to: '/app/agents/industrial-video', search: { sessionId }, replace: true })
    // }
    // MEA:industrial-video 视频分类保留工具授权，详情统一交给普通 Agent 运行时。
    // if (sessionId) throw redirect({ to: '/app/agents', search: { sessionId }, replace: true })
    if (!search.sessionId) throw redirect({ to: '/app/agents', search: { sessionId }, replace: true })
  },
  component: AgentPage
})
