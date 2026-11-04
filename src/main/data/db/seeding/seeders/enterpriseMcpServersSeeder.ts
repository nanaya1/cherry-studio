import { eq, or } from 'drizzle-orm'

import { mcpServerTable } from '@data/db/schemas/mcpServer'
import { agentService } from '@data/services/AgentService'
import { ENTERPRISE_MCP_SERVERS } from '@shared/data/presets/mcpServers'

import type { DbType, ISeeder } from '../../types'

export class EnterpriseMcpServersSeeder implements ISeeder {
  readonly name = 'enterpriseMcpServers'
  readonly description = '安装五项企业内置 MCP 并同步默认助手绑定'
  readonly executionPolicy = 'run-on-change' as const
  // MEA:enterprise-builtin-mcp 固定独立版本，升级不依赖旧绑定日志，删除后不重装。
  readonly version = '1'

  run(db: DbType): void {
    db.transaction((tx) => {
      const targetIds: string[] = []
      for (const preset of ENTERPRISE_MCP_SERVERS) {
        const existing = tx
          .select({ id: mcpServerTable.id })
          .from(mcpServerTable)
          .where(or(eq(mcpServerTable.name, preset.name), eq(mcpServerTable.baseUrl, preset.baseUrl!)))
          .all()
        if (existing.length > 0) {
          targetIds.push(...existing.map((server) => server.id))
        } else {
          const target = tx.insert(mcpServerTable).values(preset).returning({ id: mcpServerTable.id }).get()
          targetIds.push(target.id)
        }
      }
      agentService.syncActiveMcpsToBuiltinAssistantTx(tx, targetIds)
    })
  }
}
