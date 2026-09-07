import { ENDPOINT_TYPE } from '@cherrystudio/provider-registry'
import type { InsertUserModelRow } from '@data/db/schemas/userModel'
import { userModelTable } from '@data/db/schemas/userModel'
import type { InsertUserProviderRow } from '@data/db/schemas/userProvider'
import { userProviderTable } from '@data/db/schemas/userProvider'
import { providerService } from '@data/services/ProviderService'
import { insertManyWithOrderKey } from '@data/services/utils/orderKey'
import { loggerService } from '@logger'
import {
  CHERRY_CLOUD_PROVIDER_ID,
  CHERRYAI_API_BASE_URL,
  CHERRYAI_DEFAULT_MODEL_GROUP,
  CHERRYAI_DEFAULT_MODEL_ID,
  CHERRYAI_DEFAULT_MODEL_NAME,
  CHERRYAI_DEFAULT_UNIQUE_MODEL_ID,
  CHERRYAI_PROVIDER_ID,
  CHERRYAI_PROVIDER_NAME
} from '@shared/data/presets/cherryai'
import type { ModelCapability } from '@shared/data/types/model'
import { eq } from 'drizzle-orm'

import type { DbType, ISeeder } from '../../types'
import { hashObject } from '../hashObject'

const logger = loggerService.withContext('CherryAiDefaultModelSeeder')

type TxLike = Pick<DbType, 'select' | 'insert' | 'update'>
type ManagedCherryProviderRow = Omit<InsertUserProviderRow, 'orderKey'>
type CherryAiDefaultModelRow = Omit<InsertUserModelRow, 'orderKey'>

function createCherryAiProviderRow(): ManagedCherryProviderRow {
  return {
    providerId: CHERRYAI_PROVIDER_ID,
    presetProviderId: CHERRYAI_PROVIDER_ID,
    name: CHERRYAI_PROVIDER_NAME,
    endpointConfigs: {
      [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: {
        baseUrl: CHERRYAI_API_BASE_URL
      }
    },
    defaultChatEndpoint: ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS,
    authConfig: null,
    providerSettings: null,
    isEnabled: false
  }
}

function createCherryCloudProviderRow(): ManagedCherryProviderRow {
  return {
    providerId: CHERRY_CLOUD_PROVIDER_ID,
    presetProviderId: CHERRYAI_PROVIDER_ID,
    name: CHERRYAI_PROVIDER_NAME,
    endpointConfigs: null,
    defaultChatEndpoint: ENDPOINT_TYPE.ANTHROPIC_MESSAGES,
    authConfig: null,
    providerSettings: null,
    isEnabled: true
  }
}

function createCherryAiDefaultModelRow(): CherryAiDefaultModelRow {
  return {
    id: CHERRYAI_DEFAULT_UNIQUE_MODEL_ID,
    providerId: CHERRYAI_PROVIDER_ID,
    modelId: CHERRYAI_DEFAULT_MODEL_ID,
    presetModelId: null,
    name: CHERRYAI_DEFAULT_MODEL_NAME,
    description: null,
    group: CHERRYAI_DEFAULT_MODEL_GROUP,
    capabilities: [] as ModelCapability[],
    inputModalities: null,
    outputModalities: null,
    endpointTypes: null,
    contextWindow: null,
    maxInputTokens: null,
    maxOutputTokens: null,
    supportsStreaming: true,
    reasoning: null,
    parameters: null,
    pricing: null,
    isEnabled: false,
    isHidden: true,
    isDeprecated: false,
    notes: null
  }
}

// Exported solely for v1->v2 migration reuse; make private when migration support is dropped.
export function ensureCherryAiDefaultProviderAndModelTx(tx: TxLike): void {
  const insertedProviderCount = providerService.batchUpsertTx(tx, [createCherryAiProviderRow()])
  if (insertedProviderCount > 0) {
    logger.warn('Self-healed missing CherryAI default provider', { providerId: CHERRYAI_PROVIDER_ID })
  }
  tx.update(userProviderTable)
    .set({ isEnabled: false })
    .where(eq(userProviderTable.providerId, CHERRYAI_PROVIDER_ID))
    .run()

  const insertedCloudProviderCount = providerService.batchUpsertTx(tx, [createCherryCloudProviderRow()])
  if (insertedCloudProviderCount > 0) {
    logger.warn('Self-healed missing Cherry Cloud provider', { providerId: CHERRY_CLOUD_PROVIDER_ID })
  }

  const [existing] = tx
    .select({ id: userModelTable.id })
    .from(userModelTable)
    .where(eq(userModelTable.id, CHERRYAI_DEFAULT_UNIQUE_MODEL_ID))
    .limit(1)
    .all()

  if (existing) {
    tx.update(userModelTable)
      .set({ isEnabled: false, isHidden: true })
      .where(eq(userModelTable.id, CHERRYAI_DEFAULT_UNIQUE_MODEL_ID))
      .run()
    return
  }

  logger.warn('Self-healed missing CherryAI default model', { modelId: CHERRYAI_DEFAULT_UNIQUE_MODEL_ID })
  insertManyWithOrderKey(tx, userModelTable, [createCherryAiDefaultModelRow()], {
    pkColumn: userModelTable.id,
    scope: eq(userModelTable.providerId, CHERRYAI_PROVIDER_ID)
  })
}

export class CherryAiDefaultModelSeeder implements ISeeder {
  readonly name = 'cherryaiDefaultModel'
  readonly description = 'Ensure hidden legacy CherryAI providers and default model'
  readonly version: string

  constructor() {
    this.version = hashObject({
      provider: createCherryAiProviderRow(),
      cloudProvider: createCherryCloudProviderRow(),
      model: createCherryAiDefaultModelRow()
    })
  }

  run(db: DbType): void {
    db.transaction((tx) => ensureCherryAiDefaultProviderAndModelTx(tx))
  }
}
