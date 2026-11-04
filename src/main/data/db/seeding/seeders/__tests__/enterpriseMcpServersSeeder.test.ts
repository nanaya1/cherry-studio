import { setupTestDatabase } from '@test-helpers/db'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'

import { agentTable } from '@data/db/schemas/agent'
import { appStateTable } from '@data/db/schemas/appState'
import { agentMcpServerTable } from '@data/db/schemas/assistantRelations'
import { mcpServerTable } from '@data/db/schemas/mcpServer'
import { seeders } from '@data/db/seeding/seederRegistry'
import { BuiltinAssistantMcpBindingSeeder } from '@data/db/seeding/seeders/builtinAssistantMcpBindingSeeder'
import { CherryAssistantSeeder } from '@data/db/seeding/seeders/cherryAssistantSeeder'
import { EnterpriseMcpServersSeeder } from '@data/db/seeding/seeders/enterpriseMcpServersSeeder'
import { TestMcpRetirementSeeder } from '@data/db/seeding/seeders/testMcpRetirementSeeder'
import { SeedRunner } from '@data/db/seeding/SeedRunner'
import { agentService } from '@data/services/AgentService'
import { ENTERPRISE_MCP_SERVERS, VISIBLE_PRESET_MCP_SERVERS } from '@shared/data/presets/mcpServers'

const expectedServers = [
  { name: '图零-质检助手', baseUrl: 'http://10.10.2.107/agent_bubble/mcp', longRunning: null, timeout: null },
  { name: '图零-图纸检索', baseUrl: 'http://10.10.2.107/api/mcp', longRunning: null, timeout: null },
  {
    name: '智能经营决策、质量分析改进',
    baseUrl: 'http://10.10.2.106/meta-data/api/v2/mcp',
    longRunning: true,
    timeout: 600
  },
  { name: '装备运维', baseUrl: 'https://mro.xuelangyun.com/api/v1/mcp', longRunning: true, timeout: 600 },
  { name: '生管管控', baseUrl: 'http://10.10.2.108:3000/control-agent/mcp', longRunning: true, timeout: 600 }
]
const currentSeeders = () => [
  new CherryAssistantSeeder(),
  ...seeders.filter((seeder) =>
    ['builtinMcpServer', 'testMcpRetirement', 'enterpriseMcpServers', 'builtinAssistantMcpBinding'].includes(
      seeder.name
    )
  )
]

describe('EnterpriseMcpServersSeeder', () => {
  const dbh = setupTestDatabase()

  it.each([false, true])('新装或旧安装及绑定日志已存在时安装五项且默认关闭、不绑定：%s', (upgraded) => {
    const runner = new SeedRunner(dbh.db)
    if (upgraded) {
      runner.runAll([
        new CherryAssistantSeeder(),
        {
          name: 'chatbiMcp',
          version: '1',
          description: 'Simulate a retired installation without depending on retired presets',
          run: (db) => {
            db.insert(mcpServerTable)
              .values({
                name: 'chatbi-mcp-server',
                type: 'streamableHttp',
                baseUrl: 'http://10.88.40.147:23010/meta-data/api/v2/mcp',
                installSource: 'builtin',
                isActive: true
              })
              .run()
          }
        },
        new BuiltinAssistantMcpBindingSeeder()
      ])
      expect(dbh.db.select().from(agentMcpServerTable).all()).toHaveLength(1)
    }
    runner.runAll(currentSeeders())
    const servers = dbh.db.select().from(mcpServerTable).all()
    expect(servers).toHaveLength(5)
    for (const expected of expectedServers) {
      expect(servers.find((server) => server.name === expected.name)).toMatchObject({
        ...expected,
        type: 'streamableHttp',
        installSource: 'builtin',
        shouldConfig: false,
        isActive: false,
        description: null,
        headers: null,
        env: null,
        provider: null
      })
    }
    expect(dbh.db.select().from(agentMcpServerTable).all()).toEqual([])
    expect(
      dbh.db.select().from(appStateTable).where(eq(appStateTable.key, 'seed:enterpriseMcpServers')).get()?.value
    ).toEqual({ version: '1' })
    expect(ENTERPRISE_MCP_SERVERS).toHaveLength(5)
    expect(VISIBLE_PRESET_MCP_SERVERS).toEqual(expect.arrayContaining([...ENTERPRISE_MCP_SERVERS]))
  })

  it.each(['name', 'baseUrl'] as const)('按 %s 去重，通用升级和新安装均保留全部已有配置', (match) => {
    dbh.db
      .insert(mcpServerTable)
      .values(
        expectedServers.map((server, index) => ({
          id: `existing-${index}`,
          name: match === 'name' ? server.name : `用户名称-${index}`,
          baseUrl: match === 'baseUrl' ? server.baseUrl : `http://custom.example/${index}`,
          type: 'inMemory',
          installSource: 'builtin',
          isActive: index !== 0,
          shouldConfig: true,
          headers: { APP: 'Cherry Studio', Authorization: '用户配置' },
          env: { CUSTOM: '保留' },
          args: ['用户参数'],
          command: 'custom',
          provider: 'CherryAI',
          description: '用户描述',
          longRunning: false,
          timeout: 42,
          disabledTools: ['工具'],
          disabledAutoApproveTools: ['确认工具'],
          isTrusted: false,
          sortOrder: index + 10
        }))
      )
      .run()
    const before = dbh.db.select().from(mcpServerTable).all()
    new SeedRunner(dbh.db).runAll(currentSeeders())
    expect(dbh.db.select().from(mcpServerTable).all()).toEqual(before)
    expect(
      dbh.db
        .select()
        .from(agentMcpServerTable)
        .all()
        .map((row) => row.mcpServerId)
        .sort()
    ).toEqual(['existing-1', 'existing-2', 'existing-3', 'existing-4'])
  })

  it('独立升级尊重全局禁用和默认助手显式排除，仅绑定目标且不影响普通智能体', () => {
    new SeedRunner(dbh.db).runAll([new CherryAssistantSeeder(), new BuiltinAssistantMcpBindingSeeder()])
    const assistant = dbh.db.select().from(agentTable).get()!
    dbh.db
      .update(agentTable)
      .set({ configuration: { ...assistant.configuration, excluded_mcp_server_ids: ['existing-1'] } })
      .run()
    dbh.db
      .insert(agentTable)
      .values({
        id: 'ordinary',
        type: 'claude-code',
        name: '普通智能体',
        instructions: '',
        description: '',
        orderKey: 'a1'
      })
      .run()
    dbh.db
      .insert(mcpServerTable)
      .values([
        ...expectedServers.map((server, index) => ({
          ...server,
          id: `existing-${index}`,
          installSource: 'manual',
          isActive: index !== 0
        })),
        { id: 'unrelated', name: '其他 MCP', isActive: true }
      ])
      .run()
    const before = dbh.db.select().from(mcpServerTable).all()
    new SeedRunner(dbh.db).runAll(currentSeeders())
    expect(dbh.db.select().from(mcpServerTable).all()).toEqual(before)
    expect(dbh.db.select().from(agentMcpServerTable).all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: assistant.id, mcpServerId: 'existing-2' }),
        expect.objectContaining({ agentId: assistant.id, mcpServerId: 'existing-3' }),
        expect.objectContaining({ agentId: assistant.id, mcpServerId: 'existing-4' })
      ])
    )
    expect(dbh.db.select().from(agentMcpServerTable).all()).toHaveLength(3)
    expect(
      dbh.db.select().from(agentTable).where(eq(agentTable.id, assistant.id)).get()?.configuration
        ?.excluded_mcp_server_ids
    ).toEqual(['existing-1'])
  })

  it('重复执行不重复安装绑定，后续启动不恢复禁用、移除的绑定或已删除项', () => {
    dbh.db
      .insert(mcpServerTable)
      .values(expectedServers.map((server) => ({ ...server, isActive: true })))
      .run()
    const runner = new SeedRunner(dbh.db)
    runner.runAll(currentSeeders())
    const servers = dbh.db.select().from(mcpServerTable).all()
    const bindings = dbh.db.select().from(agentMcpServerTable).all()
    new EnterpriseMcpServersSeeder().run(dbh.db)
    runner.runAll(currentSeeders())
    expect(dbh.db.select().from(mcpServerTable).all()).toEqual(servers)
    expect(dbh.db.select().from(agentMcpServerTable).all()).toEqual(bindings)
    dbh.db.update(mcpServerTable).set({ isActive: false }).where(eq(mcpServerTable.id, servers[0].id)).run()
    dbh.db.delete(agentMcpServerTable).where(eq(agentMcpServerTable.mcpServerId, servers[0].id)).run()
    dbh.db.delete(mcpServerTable).where(eq(mcpServerTable.id, servers[1].id)).run()
    const changed = dbh.db.select().from(mcpServerTable).all()
    const remainingBindings = dbh.db.select().from(agentMcpServerTable).all()
    runner.runAll(currentSeeders())
    expect(dbh.db.select().from(mcpServerTable).all()).toEqual(changed)
    expect(dbh.db.select().from(agentMcpServerTable).all()).toEqual(remainingBindings)
    expect(changed).toHaveLength(4)
    expect(changed.find((server) => server.id === servers[0].id)?.isActive).toBe(false)
    expect(remainingBindings).toHaveLength(3)
  })

  it('旧清理即使直接重跑也保留全部新项及其绑定，生产注册先清理后安装', () => {
    new SeedRunner(dbh.db).runAll(currentSeeders())
    const servers = dbh.db.select().from(mcpServerTable).all()
    const bindings = dbh.db.select().from(agentMcpServerTable).all()
    dbh.db.insert(mcpServerTable).values({ name: 'chatbi-mcp-server', installSource: 'builtin' }).run()
    new TestMcpRetirementSeeder().run(dbh.db)
    expect(dbh.db.select().from(mcpServerTable).all()).toEqual(servers)
    expect(dbh.db.select().from(agentMcpServerTable).all()).toEqual(bindings)
    const names = seeders.map((seeder) => seeder.name)
    expect(names.indexOf('cherryAssistant')).toBeLessThan(names.indexOf('enterpriseMcpServers'))
    expect(names.indexOf('testMcpRetirement')).toBeLessThan(names.indexOf('enterpriseMcpServers'))
    expect(names.indexOf('enterpriseMcpServers')).toBeLessThan(names.indexOf('builtinAssistantMcpBinding'))
  })

  it('绑定失败时五项安装原子回滚且不写成功日志', () => {
    const sync = vi.spyOn(agentService, 'syncActiveMcpsToBuiltinAssistantTx').mockImplementation(() => {
      throw new Error('同步失败')
    })
    try {
      expect(() => new SeedRunner(dbh.db).runAll([new EnterpriseMcpServersSeeder()])).toThrow('同步失败')
      expect(dbh.db.select().from(mcpServerTable).all()).toEqual([])
      expect(
        dbh.db.select().from(appStateTable).where(eq(appStateTable.key, 'seed:enterpriseMcpServers')).get()
      ).toBeUndefined()
    } finally {
      sync.mockRestore()
    }
  })
})
