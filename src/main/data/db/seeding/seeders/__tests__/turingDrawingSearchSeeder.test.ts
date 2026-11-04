// MEA:chatbi-builtin-mcp 旧测试 MCP 安装器已退役，源码保留供回滚。
// import { setupTestDatabase } from '@test-helpers/db'
// import { describe, expect, it } from 'vitest'
//
// import { mcpServerTable } from '@data/db/schemas/mcpServer'
// import { TuringDrawingSearchSeeder } from '@data/db/seeding/seeders/turingDrawingSearchSeeder'
// import { SeedRunner } from '@data/db/seeding/SeedRunner'
//
// const name = '雪浪图零·工程图纸智能检索连接服务'
// const baseUrl = 'http://10.88.40.140/api/mcp'
//
// describe('TuringDrawingSearchSeeder', () => {
//   const dbh = setupTestDatabase()
//
//   it.each([false, true])('installs the enabled drawing service when bootstrap completed is %s', (upgraded) => {
//     const runner = new SeedRunner(dbh.db)
//     if (upgraded) {
//       runner.runAll([{ name: 'previousRelease', version: '1', description: 'Previous release', run: () => {} }])
//     }
//
//     runner.runAll([new TuringDrawingSearchSeeder()])
//
//     const rows = dbh.db.select().from(mcpServerTable).all()
//     expect(rows).toHaveLength(1)
//     expect(rows[0]).toMatchObject({
//       name,
//       baseUrl,
//       type: 'streamableHttp',
//       installSource: 'builtin',
//       isActive: true,
//       shouldConfig: false,
//       provider: '雪浪图零'
//     })
//     expect(rows[0].description).toContain('历史图纸查找')
//   })
//
//   it.each([
//     { name, baseUrl: 'http://custom.example/mcp' },
//     { name: 'turing-drawing-search', baseUrl: 'http://custom.example/mcp' },
//     { name: 'My drawing search', baseUrl }
//   ])('preserves an existing configuration: %s', (existing) => {
//     dbh.db
//       .insert(mcpServerTable)
//       .values({ ...existing, isActive: false, installSource: 'manual' })
//       .run()
//     const before = dbh.db.select().from(mcpServerTable).all()
//
//     new TuringDrawingSearchSeeder().run(dbh.db)
//
//     expect(dbh.db.select().from(mcpServerTable).all()).toEqual(before)
//   })
//
//   it('does not duplicate on retries or undo disabling and deletion on subsequent startups', () => {
//     const seeder = new TuringDrawingSearchSeeder()
//     const runner = new SeedRunner(dbh.db)
//     runner.runAll([seeder])
//     seeder.run(dbh.db)
//     expect(dbh.db.select().from(mcpServerTable).all()).toHaveLength(1)
//
//     dbh.db.update(mcpServerTable).set({ isActive: false }).run()
//     runner.runAll([seeder])
//     expect(dbh.db.select().from(mcpServerTable).get()?.isActive).toBe(false)
//
//     dbh.db.delete(mcpServerTable).run()
//     runner.runAll([seeder])
//     expect(dbh.db.select().from(mcpServerTable).all()).toEqual([])
//   })
// })

import { it } from 'vitest'

it.skip('turingDrawingSearchSeeder 已退役，升级清理由 testMcpRetirementSeeder 覆盖', () => {})
