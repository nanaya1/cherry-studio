import { setupTestDatabase } from '@test-helpers/db'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { agentTable } from '@data/db/schemas/agent'
import { appStateTable } from '@data/db/schemas/appState'
import { agentMcpServerTable } from '@data/db/schemas/assistantRelations'
import { mcpServerTable } from '@data/db/schemas/mcpServer'
import { BuiltinAssistantMcpBindingSeeder } from '@data/db/seeding/seeders/builtinAssistantMcpBindingSeeder'
import { CherryAssistantSeeder } from '@data/db/seeding/seeders/cherryAssistantSeeder'
import { SeedRunner } from '@data/db/seeding/SeedRunner'
import type { ISeeder } from '@data/db/types'

const testMcpSeeder: ISeeder = {
  name: 'testMcpRows',
  description: '写入通用测试 MCP，复现默认助手先创建的顺序',
  executionPolicy: 'run-on-change',
  version: '1',
  run(db) {
    db.insert(mcpServerTable)
      .values([
        { id: 'active-a', name: '测试连接器 A', isActive: true },
        { id: 'active-b', name: '测试连接器 B', isActive: true }
      ])
      .run()
  }
}

const initialSeeders = () => [new CherryAssistantSeeder(), testMcpSeeder]

describe('BuiltinAssistantMcpBindingSeeder', () => {
  const dbh = setupTestDatabase()

  it.each([false, true])('补齐晚于默认助手写入的激活 MCP，已有安装日志：%s', (previouslyInstalled) => {
    const runner = new SeedRunner(dbh.db)
    if (previouslyInstalled) {
      runner.runAll(initialSeeders())
      expect(dbh.db.select().from(agentMcpServerTable).all()).toEqual([])
      expect(dbh.db.select().from(appStateTable).all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'seed:cherryAssistant', value: { version: '5' } }),
          expect.objectContaining({ key: 'seed:testMcpRows', value: { version: '1' } })
        ])
      )
    }

    runner.runAll([...initialSeeders(), new BuiltinAssistantMcpBindingSeeder()])
    const [agent] = dbh.db.select().from(agentTable).all()
    const bindings = dbh.db.select().from(agentMcpServerTable).all()
    expect(bindings).toHaveLength(2)
    expect(bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: agent.id, mcpServerId: 'active-a' }),
        expect.objectContaining({ agentId: agent.id, mcpServerId: 'active-b' })
      ])
    )
    new BuiltinAssistantMcpBindingSeeder().run(dbh.db)
    runner.runAll([...initialSeeders(), new BuiltinAssistantMcpBindingSeeder()])
    expect(dbh.db.select().from(agentMcpServerTable).all()).toEqual(bindings)
    expect(dbh.db.select().from(mcpServerTable).all()).toHaveLength(2)
  })

  it('保留显式排除、全局禁用以及普通 agent 的既有绑定', () => {
    dbh.db
      .insert(agentTable)
      .values([
        {
          id: 'default',
          type: 'claude-code',
          name: 'Default',
          instructions: '',
          description: '',
          orderKey: 'a0',
          configuration: { builtin_role: 'assistant', excluded_mcp_server_ids: ['excluded'] }
        },
        { id: 'ordinary', type: 'claude-code', name: 'Ordinary', instructions: '', description: '', orderKey: 'a1' }
      ])
      .run()
    dbh.db
      .insert(mcpServerTable)
      .values([
        { id: 'active', name: '测试激活项', isActive: true },
        { id: 'excluded', name: '测试排除项', isActive: true },
        { id: 'disabled', name: '测试禁用项', isActive: false }
      ])
      .run()
    dbh.db.insert(agentMcpServerTable).values({ agentId: 'ordinary', mcpServerId: 'excluded' }).run()
    const agentsBefore = dbh.db.select().from(agentTable).all()
    const serversBefore = dbh.db.select().from(mcpServerTable).all()

    new SeedRunner(dbh.db).runAll([new BuiltinAssistantMcpBindingSeeder()])

    const bindings = dbh.db.select().from(agentMcpServerTable).all()
    expect(bindings).toHaveLength(2)
    expect(bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: 'default', mcpServerId: 'active' }),
        expect.objectContaining({ agentId: 'ordinary', mcpServerId: 'excluded' })
      ])
    )
    expect(dbh.db.select().from(agentTable).all()).toEqual(agentsBefore)
    expect(dbh.db.select().from(mcpServerTable).all()).toEqual(serversBefore)
  })

  it('升级不重装已删除的 MCP，后续启动不恢复用户移除的绑定', () => {
    const runner = new SeedRunner(dbh.db)
    runner.runAll(initialSeeders())
    dbh.db.delete(mcpServerTable).where(eq(mcpServerTable.id, 'active-b')).run()

    runner.runAll([...initialSeeders(), new BuiltinAssistantMcpBindingSeeder()])
    expect(dbh.db.select().from(mcpServerTable).all()).toEqual([expect.objectContaining({ id: 'active-a' })])
    expect(dbh.db.select().from(agentMcpServerTable).all()).toEqual([
      expect.objectContaining({ mcpServerId: 'active-a' })
    ])

    dbh.db.delete(agentMcpServerTable).run()
    runner.runAll([...initialSeeders(), new BuiltinAssistantMcpBindingSeeder()])
    expect(dbh.db.select().from(agentMcpServerTable).all()).toEqual([])
  })

  it('不恢复已删除的默认助手，也不为其绑定仍激活的 MCP', () => {
    const runner = new SeedRunner(dbh.db)
    runner.runAll(initialSeeders())
    dbh.db.update(agentTable).set({ deletedAt: Date.now() }).run()
    const agentsBefore = dbh.db.select().from(agentTable).all()

    runner.runAll([...initialSeeders(), new BuiltinAssistantMcpBindingSeeder()])

    expect(dbh.db.select().from(mcpServerTable).all()).toHaveLength(2)
    expect(dbh.db.select().from(agentMcpServerTable).all()).toEqual([])
    expect(dbh.db.select().from(agentTable).all()).toEqual(agentsBefore)
  })
})
