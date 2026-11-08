import { application } from '@application'
import { agentSessionService } from '@data/services/AgentSessionService'
import { loggerService } from '@logger'
import {
  assertIndustrialVideoRuntime,
  INDUSTRIAL_VIDEO_PRODUCTION_PROMPT
} from '@main/features/industrialVideo/industrialVideoExecutionPolicy'
import type { AgentType } from '@shared/data/api/schemas/agents'
import { AGENT_WORKSPACE_TYPE } from '@shared/data/api/schemas/agentWorkspaces'
import type { UniqueModelId } from '@shared/data/types/model'

import { createAgent } from './createAgent'

const logger = loggerService.withContext('CreateIndustrialVideoSession')

export async function createIndustrialVideoSession(
  modelId: UniqueModelId,
  agentType: AgentType
): Promise<{ sessionId: string }> {
  assertIndustrialVideoRuntime('industrial-video', agentType)
  const agent = await createAgent(
    {
      type: agentType,
      name: 'Industrial Video',
      // instructions: 'You are an industrial video planning and production assistant.',
      instructions: INDUSTRIAL_VIDEO_PRODUCTION_PROMPT,
      model: modelId,
      configuration: { internal_kind: 'industrial-video' }
    },
    { allowIndustrialVideoInternal: true }
  )

  try {
    const session = agentSessionService.create({
      agentId: agent.id,
      featureKind: 'industrial-video',
      name: '',
      workspace: { type: AGENT_WORKSPACE_TYPE.SYSTEM }
    })
    return { sessionId: session.id }
  } catch (error) {
    try {
      await application.get('AgentLifecycleService').deleteActiveAgentPermanently(agent.id, true)
    } catch (cleanupError) {
      logger.warn('Failed to roll back industrial-video Agent after session creation failure', {
        agentId: agent.id,
        cleanupError
      })
    }
    throw error
  }
}
