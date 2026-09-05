import { agentTable } from '@data/db/schemas/agent'
import { agentService } from '@data/services/AgentService'
import type { AgentConfiguration } from '@shared/data/api/schemas/agents'
import { eq } from 'drizzle-orm'
import { app } from 'electron'
import { v4 as uuidv4 } from 'uuid'

import type { DbType, ISeeder } from '../../types'

// A seeder is a versioned rollout snapshot, not a live view of the AI package.
// Runtime restoration reads the current package definition in the AI module;
// keeping this seed local avoids either direction crossing the Data/AI boundary.
const CHERRY_ASSISTANT_SEED = {
  name: {
    default: 'Cherry Assistant',
    zh: '工匠智能体'
  },
  configuration: {
    avatar: '🍒',
    permission_mode: 'acceptEdits',
    bootstrap_completed: true,
    builtin_role: 'assistant',
    env_vars: {}
  } satisfies AgentConfiguration
} as const

// Prior stock Chinese display names rolled forward to CHERRY_ASSISTANT_SEED.name.zh on re-run.
const LEGACY_ZH_NAMES: readonly string[] = ['默认小助手', 'Cherry 小助手']

export class CherryAssistantSeeder implements ISeeder {
  readonly name = 'cherryAssistant'
  readonly description = 'Insert the builtin Cherry Assistant in every agent library'
  readonly executionPolicy = 'run-on-change' as const
  // Version 1 journaled the old "empty library only" eligibility decision. Version 2
  // rolls the assistant out to existing libraries; the persisted builtin identity still
  // prevents recreating a user-deleted assistant or overwriting user choices.
  // Version 3 renames stock Chinese names to 工匠智能体.
  readonly version = '3'

  run(db: DbType): void {
    db.transaction((tx) => {
      this.renameStockNames(tx)

      const existing = agentService.findBuiltinAgentByRoleTx(tx, 'assistant', { includeDeleted: true })
      if (existing) return

      const agentId = uuidv4()
      const row = agentService.createAgentTx(tx, agentId, {
        id: agentId,
        type: 'claude-code',
        name: this.getNameForPreferredSystemLanguage(),
        description: '',
        instructions: '',
        // The managed CherryAI model cannot run the agent runtime. Onboarding
        // assigns the user's default model when they choose one.
        model: null,
        configuration: { ...CHERRY_ASSISTANT_SEED.configuration }
      })

      if (!row) {
        throw new Error('insert succeeded but select returned no builtin Cherry Assistant row')
      }
    })
  }

  /**
   * Roll prior stock Chinese names forward on the builtin-role agent. Exact-match
   * only: a user-renamed builtin or any ordinary agent keeps its name.
   */
  private renameStockNames(tx: DbType): void {
    const builtin = agentService.findBuiltinAgentByRoleTx(tx, 'assistant', { includeDeleted: true })
    if (!builtin || !LEGACY_ZH_NAMES.includes(builtin.name)) return

    tx.update(agentTable).set({ name: CHERRY_ASSISTANT_SEED.name.zh }).where(eq(agentTable.id, builtin.id)).run()
  }

  private getNameForPreferredSystemLanguage(): string {
    try {
      const language = app.getPreferredSystemLanguages()[0]
      return language?.toLowerCase().startsWith('zh')
        ? CHERRY_ASSISTANT_SEED.name.zh
        : CHERRY_ASSISTANT_SEED.name.default
    } catch {
      return CHERRY_ASSISTANT_SEED.name.default
    }
  }
}
