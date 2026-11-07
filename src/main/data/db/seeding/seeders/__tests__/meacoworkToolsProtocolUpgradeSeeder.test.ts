import { setupTestDatabase } from '@test-helpers/db'
import { describe, expect, it } from 'vitest'

import { agentTable } from '@data/db/schemas/agent'

import { MeacoworkToolsProtocolUpgradeSeeder } from '../meacoworkToolsProtocolUpgradeSeeder'

describe('MEA Cowork tools protocol upgrade', () => {
  const dbh = setupTestDatabase()

  it('migrates legacy disabled tool names once while preserving unrelated tools', () => {
    const db = dbh.db
    db.insert(agentTable)
      .values({
        id: 'agent',
        type: 'pi',
        name: 'Agent',
        instructions: '',
        orderKey: 'a0',
        disabledTools: [
          'Bash',
          'mcp__cherry-tools',
          'mcp__cherry-tools__*',
          'mcp__cherry-tools__web_search',
          'mcp__meacowork-tools__web_search'
        ]
      })
      .run()

    const upgrade = new MeacoworkToolsProtocolUpgradeSeeder()
    upgrade.run(db)
    upgrade.run(db)

    expect(db.select().from(agentTable).get()?.disabledTools).toEqual([
      'Bash',
      'mcp__meacowork-tools',
      'mcp__meacowork-tools__*',
      'mcp__meacowork-tools__web_search'
    ])
  })
})
