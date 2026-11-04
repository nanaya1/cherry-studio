import { setupTestDatabase } from '@test-helpers/db'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

import { agentTable } from '@data/db/schemas/agent'
import { appStateTable } from '@data/db/schemas/appState'
import { assistantTable } from '@data/db/schemas/assistant'
import { agentMcpServerTable, assistantMcpServerTable } from '@data/db/schemas/assistantRelations'
import { mcpServerTable } from '@data/db/schemas/mcpServer'
import { seeders } from '@data/db/seeding/seederRegistry'
import { BuiltinAssistantMcpBindingSeeder } from '@data/db/seeding/seeders/builtinAssistantMcpBindingSeeder'
import { BuiltinMcpServerSeeder } from '@data/db/seeding/seeders/builtinMcpServerSeeder'
// import { ChatbiMcpSeeder } from '@data/db/seeding/seeders/chatbiMcpSeeder'
import { CherryAssistantSeeder } from '@data/db/seeding/seeders/cherryAssistantSeeder'
// import { HufuMcpSeeder } from '@data/db/seeding/seeders/hufuMcpSeeder'
import { TestMcpRetirementSeeder } from '@data/db/seeding/seeders/testMcpRetirementSeeder'
// import { TuringDrawingSearchSeeder } from '@data/db/seeding/seeders/turingDrawingSearchSeeder'
import { SeedRunner } from '@data/db/seeding/SeedRunner'
import { PRESET_MCP_SERVERS, VISIBLE_PRESET_MCP_SERVERS } from '@shared/data/presets/mcpServers'
import { DEFAULT_ASSISTANT_SETTINGS } from '@shared/data/types/assistant'

const retiredServers = [
  { name: '企业业务数据连接助手', baseUrl: 'http://custom.example/chatbi' },
  { name: 'chatbi-mcp-server', baseUrl: 'http://custom.example/chatbi-alias' },
  { name: 'Renamed chatbi', baseUrl: 'http://10.88.40.147:23010/meta-data/api/v2/mcp' },
  { name: '雪浪图零·工程图纸智能检索连接服务', baseUrl: 'http://custom.example/turing' },
  { name: 'turing-drawing-search', baseUrl: 'http://custom.example/turing-alias' },
  { name: 'Renamed turing', baseUrl: 'http://10.88.40.140/api/mcp' },
  { name: '数据中台查询分析助手', baseUrl: 'http://custom.example/hufu' },
  { name: 'hufu-mcp-server', baseUrl: 'http://custom.example/hufu-alias' },
  { name: 'Renamed hufu', baseUrl: 'http://10.88.36.168:8765/mcp' }
]
const currentMcpSeeders = seeders.filter((seeder) =>
  ['builtinMcpServer', 'testMcpRetirement', 'builtinAssistantMcpBinding'].includes(seeder.name)
)

describe('TestMcpRetirementSeeder', () => {
  const dbh = setupTestDatabase()

  it('chatbi 安装及绑定 journal 已存在时仍执行独立 v1 退役且后续启动不重装', () => {
    const runner = new SeedRunner(dbh.db)
    // runner.runAll([new CherryAssistantSeeder(), new ChatbiMcpSeeder(), new BuiltinAssistantMcpBindingSeeder()])
    // MEA:chatbi-builtin-mcp 历史数据库夹具不依赖已退役的安装实现。
    runner.runAll([new CherryAssistantSeeder()])
    dbh.db
      .insert(mcpServerTable)
      .values({
        name: '企业业务数据连接助手',
        baseUrl: 'http://10.88.40.147:23010/meta-data/api/v2/mcp',
        type: 'streamableHttp',
        installSource: 'builtin',
        isActive: true
      })
      .run()
    dbh.db
      .insert(appStateTable)
      .values({ key: 'seed:chatbiMcp', value: { version: '1' } })
      .run()
    runner.runAll([new BuiltinAssistantMcpBindingSeeder()])
    expect(dbh.db.select().from(mcpServerTable).all()).toHaveLength(1)
    expect(dbh.db.select().from(agentMcpServerTable).all()).toHaveLength(1)
    const agents = dbh.db.select().from(agentTable).all()
    const journal = dbh.db.select().from(appStateTable).where(eq(appStateTable.key, 'seed:chatbiMcp')).get()
    expect(journal?.value).toEqual({ version: '1' })

    runner.runAll(currentMcpSeeders)

    expect(dbh.db.select().from(mcpServerTable).all()).toEqual([])
    expect(dbh.db.select().from(agentMcpServerTable).all()).toEqual([])
    expect(dbh.db.select().from(agentTable).all()).toEqual(agents)
    expect(dbh.db.select().from(appStateTable).where(eq(appStateTable.key, 'seed:chatbiMcp')).get()).toEqual(journal)
    const retirementJournal = dbh.db
      .select()
      .from(appStateTable)
      .where(eq(appStateTable.key, 'seed:testMcpRetirement'))
      .get()
    expect(retirementJournal?.value).toEqual({ version: '1' })

    new TestMcpRetirementSeeder().run(dbh.db)
    runner.runAll(currentMcpSeeders)
    expect(dbh.db.select().from(mcpServerTable).all()).toEqual([])
    expect(dbh.db.select().from(appStateTable).where(eq(appStateTable.key, 'seed:testMcpRetirement')).get()).toEqual(
      retirementJournal
    )
  })

  it('未执行 chatbi 替换升级时清除旧 turing/hufu builtin', () => {
    const runner = new SeedRunner(dbh.db)
    // runner.runAll([
    //   new CherryAssistantSeeder(),
    //   new TuringDrawingSearchSeeder(),
    //   new HufuMcpSeeder(),
    //   new BuiltinAssistantMcpBindingSeeder()
    // ])
    // MEA:chatbi-builtin-mcp 直接模拟尚未替换升级的旧安装及其日志。
    runner.runAll([new CherryAssistantSeeder()])
    dbh.db
      .insert(mcpServerTable)
      .values([
        {
          name: '雪浪图零·工程图纸智能检索连接服务',
          baseUrl: 'http://10.88.40.140/api/mcp',
          type: 'streamableHttp',
          installSource: 'builtin',
          isActive: true
        },
        {
          name: '数据中台查询分析助手',
          baseUrl: 'http://10.88.36.168:8765/mcp',
          type: 'streamableHttp',
          installSource: 'builtin',
          isActive: true
        }
      ])
      .run()
    dbh.db
      .insert(appStateTable)
      .values([
        { key: 'seed:turingDrawingSearch', value: { version: '1' } },
        { key: 'seed:hufuMcp', value: { version: '1' } }
      ])
      .run()
    runner.runAll([new BuiltinAssistantMcpBindingSeeder()])
    expect(dbh.db.select().from(mcpServerTable).all()).toHaveLength(2)
    expect(dbh.db.select().from(agentMcpServerTable).all()).toHaveLength(2)

    runner.runAll(currentMcpSeeders)

    expect(dbh.db.select().from(mcpServerTable).all()).toEqual([])
    expect(dbh.db.select().from(agentMcpServerTable).all()).toEqual([])
    expect(dbh.db.select().from(appStateTable).where(eq(appStateTable.key, 'seed:chatbiMcp')).get()).toBeUndefined()
  })

  it('精确清理全套 builtin，保留其他来源及无关行，两类绑定级联且主体完整保留', () => {
    new CherryAssistantSeeder().run(dbh.db)
    const agent = dbh.db.select().from(agentTable).get()!
    dbh.db
      .insert(assistantTable)
      .values({
        id: 'assistant',
        name: '保留助手',
        emoji: '',
        settings: { ...DEFAULT_ASSISTANT_SETTINGS },
        orderKey: 'a0'
      })
      .run()
    dbh.db
      .insert(mcpServerTable)
      .values([
        ...retiredServers.map((server, index) => ({ ...server, id: `retired-${index}`, installSource: 'builtin' })),
        ...['manual', 'ai_assisted', 'protocol', 'unknown', 'org', null].flatMap((installSource, sourceIndex) =>
          retiredServers.map((server, index) => ({
            ...server,
            id: `keep-${sourceIndex}-${index}`,
            installSource,
            isActive: true,
            headers: { Custom: '保留' }
          }))
        ),
        { id: 'unrelated', name: 'fetch', installSource: 'builtin', isActive: true },
        ...retiredServers.map((server, index) => ({
          id: `similar-${index}`,
          name: `${server.name}-custom`,
          baseUrl: `${server.baseUrl}/other`,
          installSource: 'builtin'
        }))
      ])
      .run()
    const servers = dbh.db.select().from(mcpServerTable).all()
    dbh.db
      .insert(agentMcpServerTable)
      .values(servers.map((server) => ({ agentId: agent.id, mcpServerId: server.id })))
      .run()
    dbh.db
      .insert(assistantMcpServerTable)
      .values(servers.map((server) => ({ assistantId: 'assistant', mcpServerId: server.id })))
      .run()
    const preserved = servers.filter((server) => !server.id.startsWith('retired-'))
    const agentBindings = dbh.db
      .select()
      .from(agentMcpServerTable)
      .all()
      .filter((row) => !row.mcpServerId.startsWith('retired-'))
    const assistantBindings = dbh.db
      .select()
      .from(assistantMcpServerTable)
      .all()
      .filter((row) => !row.mcpServerId.startsWith('retired-'))
    const agents = dbh.db.select().from(agentTable).all()
    const assistants = dbh.db.select().from(assistantTable).all()

    const runner = new SeedRunner(dbh.db)
    runner.runAll([new TestMcpRetirementSeeder()])
    new TestMcpRetirementSeeder().run(dbh.db)
    runner.runAll([new TestMcpRetirementSeeder()])

    expect(dbh.db.select().from(mcpServerTable).all()).toEqual(preserved)
    expect(dbh.db.select().from(agentMcpServerTable).all()).toEqual(agentBindings)
    expect(dbh.db.select().from(assistantMcpServerTable).all()).toEqual(assistantBindings)
    expect(dbh.db.select().from(agentTable).all()).toEqual(agents)
    expect(dbh.db.select().from(assistantTable).all()).toEqual(assistants)
  })

  it('删除失败时事务回滚服务器及两类绑定且不记录退役成功 journal', () => {
    new CherryAssistantSeeder().run(dbh.db)
    const agent = dbh.db.select().from(agentTable).get()!
    dbh.db
      .insert(assistantTable)
      .values({
        id: 'assistant',
        name: '保留助手',
        emoji: '',
        settings: { ...DEFAULT_ASSISTANT_SETTINGS },
        orderKey: 'a0'
      })
      .run()
    dbh.db
      .insert(mcpServerTable)
      .values({ id: 'retired', ...retiredServers[0], installSource: 'builtin' })
      .run()
    dbh.db.insert(agentMcpServerTable).values({ agentId: agent.id, mcpServerId: 'retired' }).run()
    dbh.db.insert(assistantMcpServerTable).values({ assistantId: 'assistant', mcpServerId: 'retired' }).run()
    const servers = dbh.db.select().from(mcpServerTable).all()
    const agentBindings = dbh.db.select().from(agentMcpServerTable).all()
    const assistantBindings = dbh.db.select().from(assistantMcpServerTable).all()
    dbh.sqlite.exec(
      "CREATE TEMP TRIGGER reject_retirement AFTER DELETE ON mcp_server BEGIN SELECT RAISE(ABORT, '退役失败'); END"
    )
    try {
      expect(() => new SeedRunner(dbh.db).runAll([new TestMcpRetirementSeeder()])).toThrow()
      expect(dbh.db.select().from(mcpServerTable).all()).toEqual(servers)
      expect(dbh.db.select().from(agentMcpServerTable).all()).toEqual(agentBindings)
      expect(dbh.db.select().from(assistantMcpServerTable).all()).toEqual(assistantBindings)
      expect(
        dbh.db.select().from(appStateTable).where(eq(appStateTable.key, 'seed:testMcpRetirement')).get()
      ).toBeUndefined()
    } finally {
      dbh.sqlite.exec('DROP TRIGGER reject_retirement')
    }
  })

  it('fresh 当前目录和注册均不包含三项测试服务且不安装测试项', () => {
    expect(seeders.some((seeder) => ['chatbiMcp', 'turingDrawingSearch', 'hufuMcp'].includes(seeder.name))).toBe(false)
    expect(currentMcpSeeders.map((seeder) => seeder.name)).toEqual([
      'builtinMcpServer',
      'testMcpRetirement',
      'builtinAssistantMcpBinding'
    ])
    for (const presets of [PRESET_MCP_SERVERS, VISIBLE_PRESET_MCP_SERVERS]) {
      expect(
        presets.some((preset) =>
          retiredServers.some((server) => server.name === preset.name || server.baseUrl === preset.baseUrl)
        )
      ).toBe(false)
    }

    new SeedRunner(dbh.db).runAll([new CherryAssistantSeeder(), ...currentMcpSeeders])
    new BuiltinMcpServerSeeder().run(dbh.db)
    expect(dbh.db.select().from(mcpServerTable).all()).toEqual([])
    expect(dbh.db.select().from(agentMcpServerTable).all()).toEqual([])
  })
})
