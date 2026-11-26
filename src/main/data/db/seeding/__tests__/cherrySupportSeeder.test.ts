import { setupTestDatabase } from '@test-helpers/db'
import { describe, expect, it } from 'vitest'

import { agentTable } from '@data/db/schemas/agent'
import { agentSessionTable } from '@data/db/schemas/agentSession'
import { agentWorkspaceTable } from '@data/db/schemas/agentWorkspace'
import { seeders } from '@data/db/seeding/seederRegistry'
import { agentService } from '@data/services/AgentService'
import { agentSessionService } from '@data/services/AgentSessionService'
import { CHERRY_SUPPORT_AGENT_ID } from '@shared/ai/builtinAgent'

describe('legacy feedback history', () => {
  const dbh = setupTestDatabase()

  function insertSupportAgent() {
    dbh.db
      .insert(agentTable)
      .values({
        id: CHERRY_SUPPORT_AGENT_ID,
        type: 'claude-code',
        name: '产品反馈',
        instructions: '',
        model: null,
        orderKey: 'a1',
        configuration: { avatar: '🧰', builtin_role: 'support' }
      })
      .run()
  }

  function insertSupportSession(sessionId: string) {
    dbh.db
      .insert(agentWorkspaceTable)
      .values({ id: `ws-${sessionId}`, name: 'Workspace', path: `/tmp/${sessionId}`, orderKey: 'a0' })
      .run()
    dbh.db
      .insert(agentSessionTable)
      .values({
        id: sessionId,
        agentId: CHERRY_SUPPORT_AGENT_ID,
        name: 'Feedback session',
        workspaceId: `ws-${sessionId}`,
        orderKey: 'a0'
      })
      .run()
  }

  it('keeps legacy feedback data addressable while hiding its Agent from discovery', () => {
    insertSupportAgent()
    insertSupportSession('support-session-1')

    expect(seeders.some((seeder) => seeder.name === 'cherrySupport')).toBe(false)
    expect(agentService.listAgents().agents).toEqual([])
    expect(agentService.search({ q: '产品反馈', limit: 5 })).toEqual([])
    expect(agentSessionService.getConversationById('support-session-1')).toMatchObject({
      agentId: CHERRY_SUPPORT_AGENT_ID,
      name: 'Feedback session'
    })
    expect(agentService.getAgent(CHERRY_SUPPORT_AGENT_ID)?.name).toBe('产品反馈')
  })
})
