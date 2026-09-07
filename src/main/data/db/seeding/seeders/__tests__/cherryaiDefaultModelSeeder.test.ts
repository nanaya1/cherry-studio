import { preferenceTable } from '@data/db/schemas/preference'
import { userModelTable } from '@data/db/schemas/userModel'
import { userProviderTable } from '@data/db/schemas/userProvider'
import { CherryAiDefaultModelSeeder } from '@data/db/seeding/seeders/cherryaiDefaultModelSeeder'
import { generateOrderKeyBetween } from '@data/services/utils/orderKey'
import {
  CHERRY_CLOUD_PROVIDER_ID,
  CHERRYAI_API_BASE_URL,
  CHERRYAI_DEFAULT_MODEL_GROUP,
  CHERRYAI_DEFAULT_MODEL_ID,
  CHERRYAI_DEFAULT_MODEL_NAME,
  CHERRYAI_DEFAULT_UNIQUE_MODEL_ID,
  CHERRYAI_PROVIDER_ID
} from '@shared/data/presets/cherryai'
import { ENDPOINT_TYPE } from '@shared/data/types/model'
import { setupTestDatabase } from '@test-helpers/db'
import { mockMainLoggerService } from '@test-mocks/MainLoggerService'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

describe('CherryAiDefaultModelSeeder', () => {
  const dbh = setupTestDatabase()

  beforeEach(() => {
    mockMainLoggerService.warn.mockClear()
  })

  it('seeds hidden disabled legacy CherryAI while preserving Cherry Cloud', async () => {
    new CherryAiDefaultModelSeeder().run(dbh.db)

    const [provider] = await dbh.db
      .select()
      .from(userProviderTable)
      .where(eq(userProviderTable.providerId, CHERRYAI_PROVIDER_ID))
      .limit(1)
    const [model] = await dbh.db
      .select()
      .from(userModelTable)
      .where(eq(userModelTable.id, CHERRYAI_DEFAULT_UNIQUE_MODEL_ID))
      .limit(1)
    const [cloudProvider] = await dbh.db
      .select()
      .from(userProviderTable)
      .where(eq(userProviderTable.providerId, CHERRY_CLOUD_PROVIDER_ID))
      .limit(1)

    expect(provider).toMatchObject({
      providerId: CHERRYAI_PROVIDER_ID,
      presetProviderId: CHERRYAI_PROVIDER_ID,
      name: 'CherryAI',
      defaultChatEndpoint: ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS,
      isEnabled: false
    })
    expect(provider?.endpointConfigs?.[ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]?.baseUrl).toBe(CHERRYAI_API_BASE_URL)
    expect(cloudProvider).toMatchObject({
      providerId: CHERRY_CLOUD_PROVIDER_ID,
      presetProviderId: CHERRYAI_PROVIDER_ID,
      name: 'CherryAI',
      defaultChatEndpoint: ENDPOINT_TYPE.ANTHROPIC_MESSAGES,
      isEnabled: true
    })
    expect(model).toMatchObject({
      id: CHERRYAI_DEFAULT_UNIQUE_MODEL_ID,
      providerId: CHERRYAI_PROVIDER_ID,
      modelId: CHERRYAI_DEFAULT_MODEL_ID,
      name: CHERRYAI_DEFAULT_MODEL_NAME,
      group: CHERRYAI_DEFAULT_MODEL_GROUP,
      isEnabled: false,
      isHidden: true
    })
    expect(await dbh.db.select().from(preferenceTable)).toEqual([])
    expect(mockMainLoggerService.warn).toHaveBeenCalledWith('Self-healed missing CherryAI default provider', {
      providerId: CHERRYAI_PROVIDER_ID
    })
    expect(mockMainLoggerService.warn).toHaveBeenCalledWith('Self-healed missing CherryAI default model', {
      modelId: CHERRYAI_DEFAULT_UNIQUE_MODEL_ID
    })
  })

  it('disables and hides existing CherryAI rows without changing their identity', async () => {
    await dbh.db.insert(userProviderTable).values({
      providerId: CHERRYAI_PROVIDER_ID,
      presetProviderId: CHERRYAI_PROVIDER_ID,
      name: 'Renamed CherryAI',
      orderKey: generateOrderKeyBetween(null, null),
      isEnabled: true
    })
    await dbh.db.insert(userModelTable).values({
      id: CHERRYAI_DEFAULT_UNIQUE_MODEL_ID,
      providerId: CHERRYAI_PROVIDER_ID,
      modelId: CHERRYAI_DEFAULT_MODEL_ID,
      name: 'Renamed Qwen',
      capabilities: [],
      supportsStreaming: true,
      orderKey: generateOrderKeyBetween(null, null),
      isEnabled: true,
      isHidden: false
    })

    new CherryAiDefaultModelSeeder().run(dbh.db)

    const [provider] = await dbh.db
      .select()
      .from(userProviderTable)
      .where(eq(userProviderTable.providerId, CHERRYAI_PROVIDER_ID))
    const [model] = await dbh.db
      .select()
      .from(userModelTable)
      .where(eq(userModelTable.id, CHERRYAI_DEFAULT_UNIQUE_MODEL_ID))

    expect(provider).toMatchObject({ name: 'Renamed CherryAI', isEnabled: false })
    expect(model).toMatchObject({ name: 'Renamed Qwen', isEnabled: false, isHidden: true })
  })
})
