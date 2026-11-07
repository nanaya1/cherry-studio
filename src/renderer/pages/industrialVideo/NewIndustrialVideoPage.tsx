import { useNavigate } from '@tanstack/react-router'
import { useCallback, useMemo } from 'react'

import { cacheService } from '@data/CacheService'
import { useQuery } from '@renderer/data/hooks/useDataApi'
// import { useAgentSessionsSource } from '@renderer/hooks/resourceViewSources'
import { ipcApi } from '@renderer/ipc'
import { BUILTIN_AGENT_ROLE } from '@shared/ai/builtinAgent'
import { AGENTS_MAX_LIMIT } from '@shared/data/api/schemas/agents'
import type { CacheIndustrialVideoDraft } from '@shared/data/cache/cacheValueTypes'

import IndustrialVideoPage from './IndustrialVideoPage'

export default function NewIndustrialVideoPage() {
  const navigate = useNavigate()
  // const { reuseOrCreateSession } = useAgentSessionsSource()
  const { data: agentsData, isLoading } = useQuery('/agents', { query: { limit: AGENTS_MAX_LIMIT } })
  const agentType = useMemo(
    () =>
      agentsData?.items.find((candidate) => candidate.configuration?.builtin_role === BUILTIN_AGENT_ROLE.ASSISTANT)
        ?.type ?? agentsData?.items[0]?.type,
    [agentsData]
  )
  const ensureSession = useCallback(
    async (draft: CacheIndustrialVideoDraft) => {
      if (!draft.modelId) throw new Error('industrial_video.select_model')
      if (!agentType || isLoading) throw new Error('industrial_video.session_unavailable')
      // const result = await reuseOrCreateSession(agentId, { type: AGENT_WORKSPACE_TYPE.SYSTEM }, undefined, 'industrial-video')
      // MEA:industrial-video 专用命令隔离创建内部 Agent；不修改、复用或覆盖普通 Agent。
      const result = await ipcApi.request('ai.agent.industrial_video_session.create', {
        modelId: draft.modelId,
        agentType
      })
      cacheService.setPersist(`industrial_video.session_draft.${result.sessionId}`, draft)
      return result.sessionId
    },
    [agentType, isLoading]
  )
  const openSession = useCallback(
    (sessionId: string) => {
      void navigate({
        // to: '/app/agents/industrial-video',
        to: '/app/agents',
        search: { sessionId },
        replace: true
      })
    },
    [navigate]
  )

  return (
    <IndustrialVideoPage
      ensureSession={!agentType || isLoading ? undefined : ensureSession}
      onSessionCreated={openSession}
    />
  )
}
