import { agentTable } from '@data/db/schemas/agent'
import { agentGlobalSkillTable } from '@data/db/schemas/agentGlobalSkill'
import { agentSessionTable } from '@data/db/schemas/agentSession'
import { agentSkillTable } from '@data/db/schemas/agentSkill'
import { agentMcpServerTable } from '@data/db/schemas/assistantRelations'
import { mcpServerTable } from '@data/db/schemas/mcpServer'
import { agentWorkspaceTable } from '@data/db/schemas/agentWorkspace'
import { appStateTable } from '@data/db/schemas/appState'
import { userModelTable } from '@data/db/schemas/userModel'
import { CherryAiDefaultModelSeeder } from '@data/db/seeding/seeders/cherryaiDefaultModelSeeder'
import { CherryAssistantSeeder } from '@data/db/seeding/seeders/cherryAssistantSeeder'
import { SeedRunner } from '@data/db/seeding/SeedRunner'
import type { ISeeder } from '@data/db/types'
import { agentService } from '@data/services/AgentService'
import { generateOrderKeyBetween } from '@data/services/utils/orderKey'
import { AGENT_WORKSPACE_TYPE } from '@shared/data/api/schemas/agentWorkspaces'
import { CHERRYAI_DEFAULT_UNIQUE_MODEL_ID } from '@shared/data/presets/cherryai'
import { setupTestDatabase } from '@test-helpers/db'
import { eq, isNull, sql } from 'drizzle-orm'
import { app } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

function builtinAgents(db: ReturnType<typeof setupTestDatabase>['db']) {
  return db
    .select()
    .from(agentTable)
    .where(sql`json_extract(${agentTable.configuration}, '$.builtin_role') = 'assistant'`)
    .all()
}

describe('CherryAssistantSeeder', () => {
  const dbh = setupTestDatabase()

  beforeEach(() => {
    vi.mocked(app.getPreferredSystemLanguages).mockReturnValue(['en-US'])
  })

  it('uses a new rollout version after the version 2 library-wide rollout', () => {
    expect(new CherryAssistantSeeder().version).toBe('5')
  })

  function insertOrdinaryAgent(): string {
    const id = 'ordinary-agent'
    dbh.db
      .insert(agentTable)
      .values({
        id,
        type: 'claude-code',
        name: 'Ordinary Agent',
        description: '',
        instructions: 'Ordinary instructions',
        orderKey: generateOrderKeyBetween(null, null)
      })
      .run()
    return id
  }

  it('creates the builtin agent without any seeded session in a fresh library', () => {
    new CherryAssistantSeeder().run(dbh.db)

    const [agent] = builtinAgents(dbh.db)
    expect(agent).toMatchObject({
      type: 'claude-code',
      name: 'MEA Cowork',
      description: '',
      instructions: '',
      model: null
    })
    expect(agent.configuration).toMatchObject({
      avatar: '🍒',
      permission_mode: 'acceptEdits',
      bootstrap_completed: true,
      env_vars: {},
      builtin_role: 'assistant'
    })
    expect(dbh.db.select().from(agentSessionTable).all()).toHaveLength(0)
  })

  it('backfills enabled resources without overriding explicit exclusions', () => {
    dbh.db
      .insert(mcpServerTable)
      .values([
        { id: 'mcp-enabled', name: 'Enabled MCP', isActive: true },
        { id: 'mcp-excluded', name: 'Excluded MCP', isActive: true }
      ])
      .run()
    dbh.db
      .insert(agentGlobalSkillTable)
      .values([
        {
          id: 'skill-enabled',
          name: 'Enabled Skill',
          folderName: 'enabled-skill',
          source: 'user',
          contentHash: 'a',
          isEnabled: true
        },
        {
          id: 'skill-excluded',
          name: 'Excluded Skill',
          folderName: 'excluded-skill',
          source: 'user',
          contentHash: 'b',
          isEnabled: true
        }
      ])
      .run()
    dbh.db
      .insert(agentTable)
      .values({
        id: 'builtin-existing',
        type: 'claude-code',
        name: 'MEA Cowork',
        description: '',
        instructions: '',
        configuration: { builtin_role: 'assistant', excluded_mcp_server_ids: ['mcp-excluded'] },
        orderKey: generateOrderKeyBetween(null, null)
      })
      .run()
    dbh.db
      .insert(agentSkillTable)
      .values({ agentId: 'builtin-existing', skillId: 'skill-excluded', isEnabled: false })
      .run()

    new CherryAssistantSeeder().run(dbh.db)

    expect(dbh.db.select().from(agentMcpServerTable).all()).toEqual([
      expect.objectContaining({ agentId: 'builtin-existing', mcpServerId: 'mcp-enabled' })
    ])
    expect(dbh.db.select().from(agentSkillTable).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: 'builtin-existing', skillId: 'skill-enabled', isEnabled: true }),
        expect.objectContaining({ agentId: 'builtin-existing', skillId: 'skill-excluded', isEnabled: false })
      ])
    )
  })

  it('creates the builtin agent as MEA Cowork for Chinese systems', () => {
    vi.mocked(app.getPreferredSystemLanguages).mockReturnValue(['zh-CN'])

    new CherryAssistantSeeder().run(dbh.db)

    const [agent] = builtinAgents(dbh.db)
    expect(agent.name).toBe('MEA Cowork')
  })

  it.each(['默认小助手', 'Cherry 小助手', '工匠智能体', 'Cherry Assistant'])(
    'renames the stock builtin agent named %s to MEA Cowork',
    (stockName) => {
      dbh.db
        .insert(agentTable)
        .values({
          id: 'builtin-old-name',
          type: 'claude-code',
          name: stockName,
          description: '',
          instructions: '',
          model: null,
          configuration: { builtin_role: 'assistant' },
          orderKey: generateOrderKeyBetween(null, null)
        })
        .run()

      new CherryAssistantSeeder().run(dbh.db)

      const [agent] = dbh.db.select().from(agentTable).where(eq(agentTable.id, 'builtin-old-name')).all()
      expect(agent.name).toBe('MEA Cowork')
      expect(builtinAgents(dbh.db)).toHaveLength(1)
    }
  )

  it('preserves a user-renamed builtin agent', () => {
    dbh.db
      .insert(agentTable)
      .values({
        id: 'builtin-renamed',
        type: 'claude-code',
        name: '我的智能体',
        description: '',
        instructions: '',
        model: null,
        configuration: { builtin_role: 'assistant' },
        orderKey: generateOrderKeyBetween(null, null)
      })
      .run()

    new CherryAssistantSeeder().run(dbh.db)

    const [agent] = dbh.db.select().from(agentTable).where(eq(agentTable.id, 'builtin-renamed')).all()
    expect(agent.name).toBe('我的智能体')
  })

  it('does not rename ordinary agents that happen to carry a stock name', () => {
    insertOrdinaryAgent()
    dbh.db.update(agentTable).set({ name: '默认小助手' }).where(eq(agentTable.id, 'ordinary-agent')).run()

    new CherryAssistantSeeder().run(dbh.db)

    const [agent] = dbh.db.select().from(agentTable).where(eq(agentTable.id, 'ordinary-agent')).all()
    expect(agent.name).toBe('默认小助手')
  })

  it('falls back to the English name when preferred system languages are unavailable', () => {
    vi.mocked(app.getPreferredSystemLanguages).mockImplementation(() => {
      throw new Error('preferred languages unavailable')
    })

    expect(() => new CherryAssistantSeeder().run(dbh.db)).not.toThrow()

    const [agent] = builtinAgents(dbh.db)
    expect(agent.name).toBe('MEA Cowork')
  })

  it('preserves an existing permission mode when the seeder reruns', () => {
    new CherryAssistantSeeder().run(dbh.db)
    const [assistant] = builtinAgents(dbh.db)
    dbh.db
      .update(agentTable)
      .set({ configuration: { ...assistant.configuration, permission_mode: 'default' } })
      .where(eq(agentTable.id, assistant.id))
      .run()
    dbh.db
      .insert(appStateTable)
      .values({ key: 'seed:cherryAssistant', value: { version: '1' } })
      .run()

    new SeedRunner(dbh.db).runAll([new CherryAssistantSeeder()])

    expect(builtinAgents(dbh.db)).toHaveLength(1)
    const [updated] = builtinAgents(dbh.db)
    expect(updated.configuration).toMatchObject({ permission_mode: 'default' })
    const [journal] = dbh.db.select().from(appStateTable).where(eq(appStateTable.key, 'seed:cherryAssistant')).all()
    expect(journal?.value).toMatchObject({ version: '5' })
  })

  it('adds Cherry Assistant after a version 1 skip in an existing library and journals the rollout', () => {
    insertOrdinaryAgent()
    dbh.db
      .insert(appStateTable)
      .values({ key: 'seed:cherryAssistant', value: { version: '1' } })
      .run()

    new SeedRunner(dbh.db).runAll([new CherryAssistantSeeder()])

    expect(dbh.db.select().from(agentTable).where(isNull(agentTable.deletedAt)).all()).toHaveLength(2)
    expect(builtinAgents(dbh.db)).toHaveLength(1)
    const [journal] = dbh.db.select().from(appStateTable).where(eq(appStateTable.key, 'seed:cherryAssistant')).all()
    expect(journal?.value).toMatchObject({ version: new CherryAssistantSeeder().version })
  })

  it('adds Cherry Assistant when only soft-deleted ordinary agents exist', () => {
    const ordinaryAgentId = insertOrdinaryAgent()
    dbh.db
      .update(agentTable)
      .set({ deletedAt: Date.UTC(2026, 0, 1) })
      .where(eq(agentTable.id, ordinaryAgentId))
      .run()

    new CherryAssistantSeeder().run(dbh.db)

    expect(dbh.db.select().from(agentTable).where(isNull(agentTable.deletedAt)).all()).toHaveLength(1)
    expect(builtinAgents(dbh.db)).toHaveLength(1)
  })

  it('adds Cherry Assistant when orphan sessions record prior library history', () => {
    const agentId = 'historical-agent'
    const sessionId = 'historical-session'

    dbh.db.transaction((tx) => {
      agentService.createAgentTx(tx, agentId, {
        id: agentId,
        type: 'claude-code',
        name: 'Historical Agent',
        description: '',
        instructions: 'Historical instructions',
        model: null,
        configuration: {}
      })
      const [workspace] = tx
        .insert(agentWorkspaceTable)
        .values({
          id: `${sessionId}-workspace`,
          name: 'system',
          path: '/system',
          type: AGENT_WORKSPACE_TYPE.SYSTEM,
          orderKey: generateOrderKeyBetween(null, null)
        })
        .returning()
        .all()
      tx.insert(agentSessionTable)
        .values({
          id: sessionId,
          agentId,
          name: '',
          workspaceId: workspace.id,
          orderKey: generateOrderKeyBetween(null, null)
        })
        .run()
      agentService.deleteAgentTx(tx, agentId)
    })

    const [orphan] = dbh.db.select().from(agentSessionTable).where(eq(agentSessionTable.id, sessionId)).all()
    expect(orphan?.agentId).toBeNull()

    new SeedRunner(dbh.db).runAll([new CherryAssistantSeeder()])

    expect(builtinAgents(dbh.db)).toHaveLength(1)
    expect(dbh.db.select().from(appStateTable).where(eq(appStateTable.key, 'seed:cherryAssistant')).all()).toHaveLength(
      1
    )
  })

  it('seeds after an unrelated seeder closes bootstrap with no prior library history', () => {
    const unrelatedSeeder: ISeeder = {
      name: 'unrelated',
      version: '1',
      description: 'Close the bootstrap window without creating agent history',
      run: vi.fn()
    }
    const runner = new SeedRunner(dbh.db)

    runner.runAll([unrelatedSeeder])
    runner.runAll([new CherryAssistantSeeder()])

    expect(builtinAgents(dbh.db)).toHaveLength(1)
    const [journal] = dbh.db.select().from(appStateTable).where(eq(appStateTable.key, 'seed:cherryAssistant')).all()
    expect(journal?.value).toMatchObject({ version: new CherryAssistantSeeder().version })
  })

  it('does not recreate a soft-deleted Cherry Assistant during the library-wide rollout', () => {
    const runner = new SeedRunner(dbh.db)
    new CherryAssistantSeeder().run(dbh.db)
    const [assistant] = builtinAgents(dbh.db)
    dbh.db
      .update(agentTable)
      .set({ deletedAt: Date.UTC(2026, 0, 1) })
      .where(eq(agentTable.id, assistant.id))
      .run()
    dbh.db
      .insert(appStateTable)
      .values({ key: 'seed:cherryAssistant', value: { version: '1' } })
      .run()

    runner.runAll([new CherryAssistantSeeder()])

    expect(dbh.db.select().from(agentTable).where(isNull(agentTable.deletedAt)).all()).toHaveLength(0)
    expect(builtinAgents(dbh.db)).toHaveLength(1)
    const [journal] = dbh.db.select().from(appStateTable).where(eq(appStateTable.key, 'seed:cherryAssistant')).all()
    expect(journal?.value).toMatchObject({ version: '5' })
  })

  it('falls back to a null model when the CherryAI default model is absent', () => {
    new CherryAssistantSeeder().run(dbh.db)

    const [agent] = builtinAgents(dbh.db)
    expect(agent.model).toBeNull()
  })

  it('leaves the model unconfigured when the CherryAI default is the only available model', () => {
    new SeedRunner(dbh.db).runAll([new CherryAiDefaultModelSeeder(), new CherryAssistantSeeder()])

    const [model] = dbh.db
      .select()
      .from(userModelTable)
      .where(eq(userModelTable.id, CHERRYAI_DEFAULT_UNIQUE_MODEL_ID))
      .all()
    const [agent] = builtinAgents(dbh.db)
    expect(model).toBeDefined()
    expect(agent.model).toBeNull()
  })
})
