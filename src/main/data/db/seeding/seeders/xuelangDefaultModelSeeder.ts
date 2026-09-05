import { assistantTable } from '@data/db/schemas/assistant'
import { preferenceTable } from '@data/db/schemas/preference'
import { userModelTable } from '@data/db/schemas/userModel'
import { userProviderTable } from '@data/db/schemas/userProvider'
import { providerService } from '@data/services/ProviderService'
import { applyMoves, insertManyWithOrderKey } from '@data/services/utils/orderKey'
import {
  XUELANG_DEFAULT_MODEL_ID,
  XUELANG_DEFAULT_PRESET_MODEL_ID,
  XUELANG_DEFAULT_UNIQUE_MODEL_ID,
  XUELANG_PROVIDER_ID,
  XUELANG_PROVIDER_NAME
} from '@shared/data/presets/xuelang'
import { and, eq } from 'drizzle-orm'

import type { DbType, ISeeder } from '../../types'
import { hashObject } from '../hashObject'

const LEGACY_XUELANG_DEFAULT_UNIQUE_MODEL_ID = 'xuelang::qwen3-8-27b'
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

const modelSeed = {
  id: XUELANG_DEFAULT_UNIQUE_MODEL_ID,
  providerId: XUELANG_PROVIDER_ID,
  modelId: XUELANG_DEFAULT_MODEL_ID,
  presetModelId: XUELANG_DEFAULT_PRESET_MODEL_ID,
  contextWindow: 32768,
  isEnabled: true,
  isHidden: false,
  isDeprecated: false
} as const

export class XuelangDefaultModelSeeder implements ISeeder {
  readonly name = 'xuelangDefaultModel'
  readonly description = 'Ensure the Xuelang provider, default model, and default model preferences'
  readonly version: string

  constructor() {
    this.version = hashObject({
      providerSeed,
      providerPosition,
      modelSeed,
      preferences: XUELANG_DEFAULT_MODEL_PREFERENCE_KEYS
    })
  }

  run(db: DbType): void {
    db.transaction((tx) => {
      providerService.batchUpsertTx(tx, [providerSeed])
      applyMoves(tx, userProviderTable, [{ id: XUELANG_PROVIDER_ID, anchor: { position: providerPosition } }], {
        pkColumn: userProviderTable.providerId
      })

      const [existingModel] = tx
        .select({ id: userModelTable.id })
        .from(userModelTable)
        .where(eq(userModelTable.id, XUELANG_DEFAULT_UNIQUE_MODEL_ID))
        .limit(1)
        .all()

      if (!existingModel) {
        insertManyWithOrderKey(tx, userModelTable, [modelSeed], {
          pkColumn: userModelTable.id,
          scope: eq(userModelTable.providerId, XUELANG_PROVIDER_ID)
        })
      }

      tx.update(assistantTable)
        .set({ modelId: XUELANG_DEFAULT_UNIQUE_MODEL_ID })
        .where(eq(assistantTable.modelId, LEGACY_XUELANG_DEFAULT_UNIQUE_MODEL_ID))
        .run()

      tx.update(userModelTable)
        .set({ isEnabled: false, isHidden: true })
        .where(eq(userModelTable.id, LEGACY_XUELANG_DEFAULT_UNIQUE_MODEL_ID))
        .run()

      for (const key of XUELANG_DEFAULT_MODEL_PREFERENCE_KEYS) {
        const [existingPreference] = tx
          .select({ value: preferenceTable.value })
          .from(preferenceTable)
          .where(and(eq(preferenceTable.scope, 'default'), eq(preferenceTable.key, key)))
          .limit(1)
          .all()

        if (existingPreference?.value === LEGACY_XUELANG_DEFAULT_UNIQUE_MODEL_ID) {
          tx.update(preferenceTable)
            .set({ value: XUELANG_DEFAULT_UNIQUE_MODEL_ID })
            .where(and(eq(preferenceTable.scope, 'default'), eq(preferenceTable.key, key)))
            .run()
        } else if (!existingPreference) {
          tx.insert(preferenceTable).values({ scope: 'default', key, value: XUELANG_DEFAULT_UNIQUE_MODEL_ID }).run()
        }
      }
    })
  }
}
