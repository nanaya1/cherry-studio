import { agentService } from '@data/services/AgentService'

import type { DbType, ISeeder } from '../../types'

/** 在 MCP 安装完成后补齐绑定，覆盖安装已记入日志的升级用户。 */
export class BuiltinAssistantMcpBindingSeeder implements ISeeder {
  readonly name = 'builtinAssistantMcpBinding'
  readonly description = 'Backfill active MCP bindings on the builtin default assistant'
  readonly executionPolicy = 'run-on-change' as const
  readonly version = '1'

  run(db: DbType): void {
    db.transaction((tx) => {
      agentService.syncActiveMcpsToBuiltinAssistantTx(tx)
    })
  }
}
