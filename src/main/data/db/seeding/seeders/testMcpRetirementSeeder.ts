import { and, eq, inArray, or } from 'drizzle-orm'

import { mcpServerTable } from '@data/db/schemas/mcpServer'

import type { DbType, ISeeder } from '../../types'

export class TestMcpRetirementSeeder implements ISeeder {
  readonly name = 'testMcpRetirement'
  readonly description = '退役 chatbi、turing 和 hufu 测试内置 MCP 并级联清理绑定'
  readonly executionPolicy = 'run-on-change' as const
  // MEA:chatbi-builtin-mcp 独立固定退役版本，不受历史安装日志或预设变化影响。
  readonly version = '1'

  run(db: DbType): void {
    db.transaction((tx) => {
      tx.delete(mcpServerTable)
        .where(
          and(
            eq(mcpServerTable.installSource, 'builtin'),
            or(
              inArray(mcpServerTable.name, [
                '企业业务数据连接助手',
                'chatbi-mcp-server',
                '雪浪图零·工程图纸智能检索连接服务',
                'turing-drawing-search',
                '数据中台查询分析助手',
                'hufu-mcp-server'
              ]),
              inArray(mcpServerTable.baseUrl, [
                'http://10.88.40.147:23010/meta-data/api/v2/mcp',
                'http://10.88.40.140/api/mcp',
                'http://10.88.36.168:8765/mcp'
              ])
            )
          )
        )
        .run()
    })
  }
}
