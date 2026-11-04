// MEA:chatbi-builtin-mcp 旧测试 MCP 安装器已退役，源码保留供回滚。
// import { setupTestDatabase } from '@test-helpers/db'
// import { describe, expect, it } from 'vitest'
//
// import { mcpServerTable } from '@data/db/schemas/mcpServer'
// import { HufuMcpSeeder } from '@data/db/seeding/seeders/hufuMcpSeeder'
// import { SeedRunner } from '@data/db/seeding/SeedRunner'
//
// const name = '数据中台查询分析助手'
// const baseUrl = 'http://10.88.36.168:8765/mcp'
//
// describe('HufuMcpSeeder', () => {
//   const dbh = setupTestDatabase()
//
//   it.each([false, true])('installs the enabled service when bootstrap completed is %s', (upgraded) => {
//     const runner = new SeedRunner(dbh.db)
//     if (upgraded) {
//       runner.runAll([{ name: 'previousRelease', version: '1', description: 'Previous release', run: () => {} }])
//     }
//     runner.runAll([new HufuMcpSeeder()])
//     const rows = dbh.db.select().from(mcpServerTable).all()
//     expect(rows).toHaveLength(1)
//     expect(rows[0]).toMatchObject({ name, baseUrl, type: 'streamableHttp', installSource: 'builtin', isActive: true })
//     expect(rows[0].description).toContain('跨业务域的智能问数')
//   })
//
//   it.each([
//     { name, baseUrl: 'http://custom.example/mcp' },
//     { name: 'hufu-mcp-server', baseUrl: 'http://custom.example/mcp' },
//     { name: 'My data assistant', baseUrl }
//   ])('preserves existing configuration: %s', (existing) => {
//     dbh.db
//       .insert(mcpServerTable)
//       .values({ ...existing, isActive: false, installSource: 'manual' })
//       .run()
//     const before = dbh.db.select().from(mcpServerTable).all()
//     new HufuMcpSeeder().run(dbh.db)
//     expect(dbh.db.select().from(mcpServerTable).all()).toEqual(before)
//   })
//
//   it('does not duplicate or undo disabling and deletion on subsequent startups', () => {
//     const seeder = new HufuMcpSeeder()
//     const runner = new SeedRunner(dbh.db)
//     runner.runAll([seeder])
//     seeder.run(dbh.db)
//     expect(dbh.db.select().from(mcpServerTable).all()).toHaveLength(1)
//     dbh.db.update(mcpServerTable).set({ isActive: false }).run()
//     runner.runAll([seeder])
//     expect(dbh.db.select().from(mcpServerTable).get()?.isActive).toBe(false)
//     dbh.db.delete(mcpServerTable).run()
//     runner.runAll([seeder])
//     expect(dbh.db.select().from(mcpServerTable).all()).toEqual([])
//   })
// })

import { it } from 'vitest'

it.skip('hufuMcpSeeder 已退役，升级清理由 testMcpRetirementSeeder 覆盖', () => {})
