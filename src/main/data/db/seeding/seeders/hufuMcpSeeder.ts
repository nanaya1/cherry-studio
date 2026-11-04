// MEA:chatbi-builtin-mcp 旧测试 MCP 安装器已退役，源码保留供回滚。
// import { eq, or } from 'drizzle-orm'
//
// import { mcpServerTable } from '@data/db/schemas/mcpServer'
// import { HUFU_MCP_PRESET } from '@shared/data/presets/mcpServers'
//
// import type { DbType, ISeeder } from '../../types'
//
// export class HufuMcpSeeder implements ISeeder {
//   readonly name = 'hufuMcp'
//   readonly description = 'Install the default enterprise data analysis MCP for new and existing users'
//   // Keep this installation version stable so deleting the server remains a user choice.
//   readonly version = '1'
//
//   run(db: DbType): void {
//     db.transaction((tx) => {
//       const preset = HUFU_MCP_PRESET
//       const existing = tx
//         .select({ id: mcpServerTable.id })
//         .from(mcpServerTable)
//         .where(
//           or(
//             eq(mcpServerTable.name, preset.name),
//             eq(mcpServerTable.name, 'hufu-mcp-server'),
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
