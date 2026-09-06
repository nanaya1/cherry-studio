import '@data/services/AgentSessionMessageService'

import { agentTable } from '@data/db/schemas/agent'
import { agentSessionTable } from '@data/db/schemas/agentSession'
import { agentWorkspaceTable } from '@data/db/schemas/agentWorkspace'
import { CherrySupportSeeder } from '@data/db/seeding/seeders/cherrySupportSeeder'
import { CHERRY_SUPPORT_AGENT_ID } from '@shared/ai/builtinAgent'
import { setupTestDatabase } from '@test-helpers/db'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

describe('CherrySupportSeeder', () => {
  const dbh = setupTestDatabase()

  function insertSupportAgent(overrides: Partial<typeof agentTable.$inferInsert> = {}) {
    dbh.db
      .insert(agentTable)
      .values({
        id: CHERRY_SUPPORT_AGENT_ID,
        type: 'claude-code',
        name: '产品反馈',
        instructions: '',
        model: null,
        orderKey: 'a1',
        configuration: { avatar: '🧰', builtin_role: 'support' },
        ...overrides
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

  it('removes an existing Cherry Support agent together with its sessions', () => {
    insertSupportAgent()
    insertSupportSession('support-session-1')

    new CherrySupportSeeder().run(dbh.db)

    expect(dbh.db.select().from(agentTable).where(eq(agentTable.id, CHERRY_SUPPORT_AGENT_ID)).all()).toHaveLength(0)
    expect(dbh.db.select().from(agentSessionTable).all()).toHaveLength(0)
  })

  it('is a no-op when the library has no Cherry Support agent', () => {
    new CherrySupportSeeder().run(dbh.db)

    expect(dbh.db.select().from(agentTable).all()).toHaveLength(0)
    expect(dbh.db.select().from(agentSessionTable).all()).toHaveLength(0)
  })

  it('hard-deletes a soft-deleted Cherry Support row', () => {
    insertSupportAgent({ deletedAt: Date.UTC(2026, 0, 1) })

    new CherrySupportSeeder().run(dbh.db)

    expect(dbh.db.select().from(agentTable).where(eq(agentTable.id, CHERRY_SUPPORT_AGENT_ID)).all()).toHaveLength(0)
  })

  it('leaves an ordinary agent that merely carries a forged support role untouched', () => {
    dbh.db
      .insert(agentTable)
      .values({
        id: 'ordinary-agent',
        type: 'claude-code',
        name: 'My Agent',
        instructions: 'Keep my instructions',
        model: null,
        orderKey: 'a0',
        configuration: { avatar: 'U', builtin_role: 'support' }
      })
      .run()

    new CherrySupportSeeder().run(dbh.db)

    const [ordinary] = dbh.db.select().from(agentTable).where(eq(agentTable.id, 'ordinary-agent')).all()
    expect(ordinary).toMatchObject({ name: 'My Agent', instructions: 'Keep my instructions' })
    expect(ordinary.configuration).toEqual({ avatar: 'U', builtin_role: 'support' })
  })
})
