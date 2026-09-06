import { agentService } from '@data/services/AgentService'
import { agentSessionService } from '@data/services/AgentSessionService'
import { BUILTIN_AGENT_ROLE } from '@shared/ai/builtinAgent'

import type { DbType, ISeeder } from '../../types'

export class CherrySupportSeeder implements ISeeder {
  readonly name = 'cherrySupport'
  readonly description = 'Remove the builtin Cherry Support agent from agent libraries'
  readonly executionPolicy = 'run-on-change' as const
  readonly version = '4'

  run(db: DbType): void {
    db.transaction((tx) => {
      const existing = agentService.findBuiltinAgentByRoleTx(tx, BUILTIN_AGENT_ROLE.SUPPORT, {
        includeDeleted: true
      })
      if (!existing) return

      agentSessionService.prepareForAgentDeletionTx(tx, existing.id, { deleteSessions: true })
      agentService.deleteAgentTx(tx, existing.id)
    })
  }
}
