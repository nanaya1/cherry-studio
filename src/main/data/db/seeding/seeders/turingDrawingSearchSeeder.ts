// MEA:chatbi-builtin-mcp 旧测试 MCP 安装器已退役，源码保留供回滚。
// import { eq, or } from 'drizzle-orm'
//
// import { mcpServerTable } from '@data/db/schemas/mcpServer'
// import { TURING_DRAWING_SEARCH_PRESET } from '@shared/data/presets/mcpServers'
//
// import type { DbType, ISeeder } from '../../types'
//
// export class TuringDrawingSearchSeeder implements ISeeder {
//   readonly name = 'turingDrawingSearch'
//   readonly description = 'Install the default Xuelang drawing search MCP for new and existing users'
//   // Keep this installation version stable so deleting the server remains a user choice.
//   readonly version = '1'
//
//   run(db: DbType): void {
//     db.transaction((tx) => {
//       const preset = TURING_DRAWING_SEARCH_PRESET
//       const existing = tx
//         .select({ id: mcpServerTable.id })
//         .from(mcpServerTable)
//         .where(
//           or(
//             eq(mcpServerTable.name, preset.name),
//             eq(mcpServerTable.name, 'turing-drawing-search'),
//             eq(mcpServerTable.baseUrl, preset.baseUrl)
//           )
//         )
//         .get()
//       if (existing) return
//
//       tx.insert(mcpServerTable).values(preset).run()
//     })
//   }
// }
