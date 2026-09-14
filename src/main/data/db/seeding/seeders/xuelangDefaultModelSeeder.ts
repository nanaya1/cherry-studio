import { agentTable } from '@data/db/schemas/agent'
import { assistantTable } from '@data/db/schemas/assistant'
import { preferenceTable } from '@data/db/schemas/preference'
import { userModelTable } from '@data/db/schemas/userModel'
import { userProviderTable } from '@data/db/schemas/userProvider'
import { providerService } from '@data/services/ProviderService'
import { applyMoves } from '@data/services/utils/orderKey'
import { CHERRYAI_DEFAULT_UNIQUE_MODEL_ID, CHERRYAI_PROVIDER_ID } from '@shared/data/presets/cherryai'
import { XUELANG_DEFAULT_UNIQUE_MODEL_ID, XUELANG_PROVIDER_ID, XUELANG_PROVIDER_NAME } from '@shared/data/presets/xuelang'
import { and, eq } from 'drizzle-orm'

import type { DbType, ISeeder } from '../../types'
import { hashObject } from '../hashObject'

const LEGACY_XUELANG_DEFAULT_UNIQUE_MODEL_ID = 'xuelang::qwen3-8-27b'
const RETIRED_DEFAULT_MODEL_IDS = [
  LEGACY_XUELANG_DEFAULT_UNIQUE_MODEL_ID,
  XUELANG_DEFAULT_UNIQUE_MODEL_ID,
  CHERRYAI_DEFAULT_UNIQUE_MODEL_ID
] as const
const providerPosition = 'first' as const

export const XUELANG_DEFAULT_MODEL_PREFERENCE_KEYS = [
  'chat.default_model_id',
  'feature.quick_assistant.model_id',
  'feature.translate.model_id'
] as const

const providerSeed = {
  providerId: XUELANG_PROVIDER_ID,
  presetProviderId: XUELANG_PROVIDER_ID,
  name: XUELANG_PROVIDER_NAME,
  authConfig: null,
  isEnabled: true
} as const

export class XuelangDefaultModelSeeder implements ISeeder {
  readonly name = 'xuelangDefaultModel'
  readonly description = 'Ensure the Xuelang provider and retire provisional model bindings'
  readonly version: string

  constructor() {
    this.version = hashObject({
      providerSeed,
      providerPosition,
      provisionalModel: null,
      preferences: XUELANG_DEFAULT_MODEL_PREFERENCE_KEYS,
      retiredDefaultModelIds: RETIRED_DEFAULT_MODEL_IDS
    })
  }

  run(db: DbType): void {
    db.transaction((tx) => {
      const insertedProviderCount = providerService.batchUpsertTx(tx, [providerSeed])
      if (insertedProviderCount > 0) {
        applyMoves(tx, userProviderTable, [{ id: XUELANG_PROVIDER_ID, anchor: { position: providerPosition } }], {
          pkColumn: userProviderTable.providerId
        })
      }

      for (const retiredModelId of RETIRED_DEFAULT_MODEL_IDS) {
        tx.update(assistantTable).set({ modelId: null }).where(eq(assistantTable.modelId, retiredModelId)).run()
        tx.update(agentTable).set({ model: null }).where(eq(agentTable.model, retiredModelId)).run()
        tx.update(agentTable).set({ planModel: null }).where(eq(agentTable.planModel, retiredModelId)).run()
        tx.update(agentTable).set({ smallModel: null }).where(eq(agentTable.smallModel, retiredModelId)).run()
      }

      for (const retiredModelId of [LEGACY_XUELANG_DEFAULT_UNIQUE_MODEL_ID, XUELANG_DEFAULT_UNIQUE_MODEL_ID]) {
        tx.update(userModelTable)
          .set({ isEnabled: false, isHidden: true, isDeprecated: true })
          .where(eq(userModelTable.id, retiredModelId))
          .run()
      }

      tx.update(userProviderTable)
        .set({ isEnabled: false })
        .where(eq(userProviderTable.providerId, CHERRYAI_PROVIDER_ID))
        .run()
      tx.update(userModelTable)
        .set({ isEnabled: false, isHidden: true })
        .where(eq(userModelTable.id, CHERRYAI_DEFAULT_UNIQUE_MODEL_ID))
        .run()

      for (const key of XUELANG_DEFAULT_MODEL_PREFERENCE_KEYS) {
        const [existingPreference] = tx
          .select({ value: preferenceTable.value })
          .from(preferenceTable)
          .where(and(eq(preferenceTable.scope, 'default'), eq(preferenceTable.key, key)))
          .limit(1)
          .all()

        if (RETIRED_DEFAULT_MODEL_IDS.some((modelId) => existingPreference?.value === modelId)) {
          tx.update(preferenceTable)
            .set({ value: null })
            .where(and(eq(preferenceTable.scope, 'default'), eq(preferenceTable.key, key)))
            .run()
        }
      }
    })
  }
}
