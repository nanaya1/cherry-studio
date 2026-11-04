// MEA:chatbi-builtin-mcp 旧测试 MCP 安装器已退役，源码保留供回滚。
// import { and, eq, inArray, or } from 'drizzle-orm'
//
// import { mcpServerTable } from '@data/db/schemas/mcpServer'
// import { agentService } from '@data/services/AgentService'
// import { CHATBI_MCP_PRESET, HUFU_MCP_PRESET, TURING_DRAWING_SEARCH_PRESET } from '@shared/data/presets/mcpServers'
//
// import type { DbType, ISeeder } from '../../types'
//
// export class ChatbiMcpSeeder implements ISeeder {
//   readonly name = 'chatbiMcp'
//   readonly description = '将旧测试内置 MCP 替换为企业业务数据连接助手并同步默认助手绑定'
//   readonly executionPolicy = 'run-on-change' as const
//   // MEA:chatbi-builtin-mcp 独立且固定的安装版本，使旧日志不阻止升级、删除后不自动重装。
//   readonly version = '1'
//
//   run(db: DbType): void {
//     db.transaction((tx) => {
//       tx.delete(mcpServerTable)
//         .where(
//           and(
//             eq(mcpServerTable.installSource, 'builtin'),
//             or(
//               inArray(mcpServerTable.name, [
//                 TURING_DRAWING_SEARCH_PRESET.name,
//                 'turing-drawing-search',
//                 HUFU_MCP_PRESET.name,
//                 'hufu-mcp-server'
//               ]),
//               inArray(mcpServerTable.baseUrl, [TURING_DRAWING_SEARCH_PRESET.baseUrl!, HUFU_MCP_PRESET.baseUrl!])
//             )
//           )
//         )
//         .run()
//
//       const preset = CHATBI_MCP_PRESET
//       const existing = tx
//         .select({ id: mcpServerTable.id })
//         .from(mcpServerTable)
//         .where(
//           or(
//             eq(mcpServerTable.name, preset.name),
//             eq(mcpServerTable.name, 'chatbi-mcp-server'),
//             eq(mcpServerTable.baseUrl, preset.baseUrl)
//           )
//         )
//         .get()
//       const target = existing ?? tx.insert(mcpServerTable).values(preset).returning({ id: mcpServerTable.id }).get()
//       agentService.syncActiveMcpsToBuiltinAssistantTx(tx, [target.id])
//     })
//   }
// }
