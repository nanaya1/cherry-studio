import { eq } from 'drizzle-orm'

import { agentTable } from '@data/db/schemas/agent'
import { migrateLegacyMeacoworkToolRuntimeNames } from '@shared/ai/meacoworkTools'

import type { DbType, ISeeder } from '../../types'

export class MeacoworkToolsProtocolUpgradeSeeder implements ISeeder {
  readonly name = 'meacoworkToolsProtocolUpgrade'
  readonly description = 'Migrate persisted meacowork-tools names to meacowork-tools'
  readonly version = '1'

  run(db: DbType): void {
    db.transaction((tx) => {
      for (const agent of tx.select().from(agentTable).all()) {
        const disabledTools = migrateLegacyMeacoworkToolRuntimeNames(agent.disabledTools)
        if (
          disabledTools.length === agent.disabledTools.length &&
          disabledTools.every((name, i) => name === agent.disabledTools[i])
        ) {
          continue
        }
        tx.update(agentTable).set({ disabledTools }).where(eq(agentTable.id, agent.id)).run()
      }
    })
  }
}
