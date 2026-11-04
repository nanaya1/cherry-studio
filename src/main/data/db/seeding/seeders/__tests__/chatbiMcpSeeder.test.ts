// MEA:chatbi-builtin-mcp 旧测试 MCP 安装器已退役，源码保留供回滚。
// import { setupTestDatabase } from '@test-helpers/db'
// import { eq } from 'drizzle-orm'
// import { describe, expect, it, vi } from 'vitest'
//
// import { agentTable } from '@data/db/schemas/agent'
// import { appStateTable } from '@data/db/schemas/appState'
// import { agentMcpServerTable } from '@data/db/schemas/assistantRelations'
// import { mcpServerTable } from '@data/db/schemas/mcpServer'
// import { seeders } from '@data/db/seeding/seederRegistry'
// import { BuiltinAssistantMcpBindingSeeder } from '@data/db/seeding/seeders/builtinAssistantMcpBindingSeeder'
// import { ChatbiMcpSeeder } from '@data/db/seeding/seeders/chatbiMcpSeeder'
// import { CherryAssistantSeeder } from '@data/db/seeding/seeders/cherryAssistantSeeder'
// import { HufuMcpSeeder } from '@data/db/seeding/seeders/hufuMcpSeeder'
// import { TuringDrawingSearchSeeder } from '@data/db/seeding/seeders/turingDrawingSearchSeeder'
// import { SeedRunner } from '@data/db/seeding/SeedRunner'
// import { agentService } from '@data/services/AgentService'
// import { PRESET_MCP_SERVERS, VISIBLE_PRESET_MCP_SERVERS } from '@shared/data/presets/mcpServers'
//
// const name = '企业业务数据连接助手'
// const baseUrl = 'http://10.88.40.147:23010/meta-data/api/v2/mcp'
// const currentSeeders = () => [
//   new CherryAssistantSeeder(),
//   new ChatbiMcpSeeder(),
//   new BuiltinAssistantMcpBindingSeeder()
// ]
//
// const retiredServers = [
//   { name: '雪浪图零·工程图纸智能检索连接服务', baseUrl: 'http://custom.example/turing' },
//   { name: 'turing-drawing-search', baseUrl: 'http://custom.example/turing-alias' },
//   { name: 'Renamed turing', baseUrl: 'http://10.88.40.140/api/mcp' },
//   { name: '数据中台查询分析助手', baseUrl: 'http://custom.example/hufu' },
//   { name: 'hufu-mcp-server', baseUrl: 'http://custom.example/hufu-alias' },
//   { name: 'Renamed hufu', baseUrl: 'http://10.88.36.168:8765/mcp' }
// ]
//
// describe('ChatbiMcpSeeder', () => {
//   const dbh = setupTestDatabase()
//
//   it.each([false, true])('新装或已记录旧安装和绑定日志时安装并绑定 chatbi：%s', (upgraded) => {
//     const runner = new SeedRunner(dbh.db)
//     if (upgraded) {
//       runner.runAll([
//         new CherryAssistantSeeder(),
//         new TuringDrawingSearchSeeder(),
//         new HufuMcpSeeder(),
//         new BuiltinAssistantMcpBindingSeeder()
//       ])
//       expect(dbh.db.select().from(agentMcpServerTable).all()).toHaveLength(2)
//     }
//
//     runner.runAll(currentSeeders())
//     const servers = dbh.db.select().from(mcpServerTable).all()
//     expect(servers).toHaveLength(1)
//     expect(servers[0]).toMatchObject({
//       name,
//       baseUrl,
//       type: 'streamableHttp',
//       installSource: 'builtin',
//       isActive: true
//     })
//     expect(servers[0].description).toBe(
//       '将企业业务数据融入日常办公，按用户权限自动定位相关业务域、数据范围和统计口径，支持用自然语言查询和分析生产、销售、质量、库存、项目等业务数据，快速返回可核对的结果摘要与明细，减少系统切换和重复操作，帮助业务人员及时获取数据支持工作判断。'
//     )
//     const assistant = dbh.db.select().from(agentTable).get()!
//     expect(dbh.db.select().from(agentMcpServerTable).all()).toEqual([
//       expect.objectContaining({ agentId: assistant.id, mcpServerId: servers[0].id })
//     ])
//     expect(dbh.db.select().from(appStateTable).where(eq(appStateTable.key, 'seed:chatbiMcp')).get()?.value).toEqual({
//       version: '1'
//     })
//   })
//
//   it('严格按内置来源清理旧名称、别名或 URL，保留手动配置与无关内置项', () => {
//     new CherryAssistantSeeder().run(dbh.db)
//     const assistant = dbh.db.select().from(agentTable).get()!
//     dbh.db
//       .insert(mcpServerTable)
//       .values([
//         ...retiredServers.map((server, index) => ({
//           ...server,
//           id: `old-${index}`,
//           installSource: 'builtin' as const
//         })),
//         ...retiredServers.map((server, index) => ({
//           ...server,
//           id: `manual-${index}`,
//           installSource: 'manual' as const
//         })),
//         { id: 'unrelated', name: 'Unrelated builtin', baseUrl: `${baseUrl}/other`, installSource: 'builtin' },
//         { id: 'similar-name', name: 'hufu-mcp-server-custom', installSource: 'builtin' },
//         { id: 'unknown-source', ...retiredServers[0] }
//       ])
//       .run()
//     dbh.db
//       .insert(agentMcpServerTable)
//       .values(retiredServers.map((_, index) => ({ agentId: assistant.id, mcpServerId: `old-${index}` })))
//       .run()
//     const preserved = dbh.db
//       .select()
//       .from(mcpServerTable)
//       .all()
//       .filter((server) => !server.id.startsWith('old-'))
//
//     new ChatbiMcpSeeder().run(dbh.db)
//
//     const servers = dbh.db.select().from(mcpServerTable).all()
//     expect(servers).toHaveLength(preserved.length + 1)
//     expect(servers).toEqual(expect.arrayContaining(preserved))
//     const chatbi = servers.find((server) => server.name === name)!
//     expect(dbh.db.select().from(agentMcpServerTable).all()).toEqual([
//       expect.objectContaining({ agentId: assistant.id, mcpServerId: chatbi.id })
//     ])
//   })
//
//   it.each([
//     { name, baseUrl: 'http://custom.example/chatbi' },
//     { name: 'chatbi-mcp-server', baseUrl: 'http://custom.example/chatbi' },
//     { name: 'My chatbi', baseUrl }
//   ])('按名称、别名或 URL 去重并保留禁用配置：%s', (existing) => {
//     new CherryAssistantSeeder().run(dbh.db)
//     dbh.db
//       .insert(mcpServerTable)
//       .values({ ...existing, id: 'existing', installSource: 'manual', isActive: false, headers: { Custom: 'keep' } })
//       .run()
//     const before = dbh.db.select().from(mcpServerTable).all()
//
//     new ChatbiMcpSeeder().run(dbh.db)
//
//     expect(dbh.db.select().from(mcpServerTable).all()).toEqual(before)
//     expect(dbh.db.select().from(agentMcpServerTable).all()).toEqual([])
//   })
//
//   it('旧绑定日志已执行时绑定已有启用配置，尊重显式排除', () => {
//     const runner = new SeedRunner(dbh.db)
//     runner.runAll([new CherryAssistantSeeder(), new BuiltinAssistantMcpBindingSeeder()])
//     dbh.db
//       .insert(mcpServerTable)
//       .values({ id: 'existing', name: 'chatbi-mcp-server', baseUrl, isActive: true, installSource: 'manual' })
//       .run()
//     const before = dbh.db.select().from(mcpServerTable).all()
//     const assistant = dbh.db.select().from(agentTable).get()!
//     dbh.db
//       .update(agentTable)
//       .set({ configuration: { ...assistant.configuration, excluded_mcp_server_ids: ['existing'] } })
//       .where(eq(agentTable.id, assistant.id))
//       .run()
//
//     new ChatbiMcpSeeder().run(dbh.db)
//     expect(dbh.db.select().from(mcpServerTable).all()).toEqual(before)
//     expect(dbh.db.select().from(agentMcpServerTable).all()).toEqual([])
//     expect(dbh.db.select().from(agentTable).get()?.configuration?.excluded_mcp_server_ids).toEqual(['existing'])
//
//     dbh.db
//       .update(agentTable)
//       .set({ configuration: { ...assistant.configuration, excluded_mcp_server_ids: [] } })
//       .where(eq(agentTable.id, assistant.id))
//       .run()
//     runner.runAll(currentSeeders())
//     expect(dbh.db.select().from(agentMcpServerTable).all()).toEqual([
//       expect.objectContaining({ agentId: assistant.id, mcpServerId: 'existing' })
//     ])
//   })
//
//   it('重复执行不重复安装或绑定，后续启动保留禁用且删除后不重装', () => {
//     const runner = new SeedRunner(dbh.db)
//     runner.runAll(currentSeeders())
//     const before = dbh.db.select().from(mcpServerTable).all()
//     const bindings = dbh.db.select().from(agentMcpServerTable).all()
//     new ChatbiMcpSeeder().run(dbh.db)
//     runner.runAll(currentSeeders())
//     expect(dbh.db.select().from(mcpServerTable).all()).toEqual(before)
//     expect(dbh.db.select().from(agentMcpServerTable).all()).toEqual(bindings)
//
//     dbh.db.update(mcpServerTable).set({ isActive: false }).run()
//     runner.runAll(currentSeeders())
//     expect(dbh.db.select().from(mcpServerTable).get()?.isActive).toBe(false)
//     dbh.db.delete(mcpServerTable).run()
//     runner.runAll(currentSeeders())
//     expect(dbh.db.select().from(mcpServerTable).all()).toEqual([])
//     expect(dbh.db.select().from(agentMcpServerTable).all()).toEqual([])
//   })
//
//   it('绑定失败时原子回滚旧服务清理与 chatbi 安装且不记录成功日志', () => {
//     dbh.db
//       .insert(mcpServerTable)
//       .values({ id: 'old', ...retiredServers[0], installSource: 'builtin' })
//       .run()
//     const before = dbh.db.select().from(mcpServerTable).all()
//     const sync = vi.spyOn(agentService, 'syncActiveMcpsToBuiltinAssistantTx').mockImplementation(() => {
//       throw new Error('同步失败')
//     })
//     try {
//       expect(() => new SeedRunner(dbh.db).runAll([new ChatbiMcpSeeder()])).toThrow('同步失败')
//       expect(dbh.db.select().from(mcpServerTable).all()).toEqual(before)
//       expect(dbh.db.select().from(appStateTable).where(eq(appStateTable.key, 'seed:chatbiMcp')).get()).toBeUndefined()
//     } finally {
//       sync.mockRestore()
//     }
//   })
//
//   it('历史安装实现保留但生产注册和目录不再安装测试服务', () => {
//     expect(seeders.some((seeder) => ['chatbiMcp', 'turingDrawingSearch', 'hufuMcp'].includes(seeder.name))).toBe(false)
//     for (const presets of [PRESET_MCP_SERVERS, VISIBLE_PRESET_MCP_SERVERS]) {
//       expect(presets.some((preset) => preset.name === name || preset.baseUrl === baseUrl)).toBe(false)
//       expect(presets.some((preset) => retiredServers.some((server) => server.name === preset.name))).toBe(false)
//     }
//   })
// })

import { it } from 'vitest'

it.skip('chatbiMcpSeeder 已退役，升级清理由 testMcpRetirementSeeder 覆盖', () => {})
