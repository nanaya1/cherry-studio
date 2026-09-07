import { assistantTable } from '@data/db/schemas/assistant'
import { preferenceTable } from '@data/db/schemas/preference'
import { userModelTable } from '@data/db/schemas/userModel'
import { userProviderTable } from '@data/db/schemas/userProvider'
import {
  XUELANG_DEFAULT_MODEL_PREFERENCE_KEYS,
  XuelangDefaultModelSeeder
} from '@data/db/seeding/seeders/xuelangDefaultModelSeeder'
import { generateOrderKeyBetween } from '@data/services/utils/orderKey'
import {
  CHERRYAI_DEFAULT_MODEL_ID,
  CHERRYAI_DEFAULT_UNIQUE_MODEL_ID,
  CHERRYAI_PROVIDER_ID
} from '@shared/data/presets/cherryai'
import {
  XUELANG_DEFAULT_PRESET_MODEL_ID,
  XUELANG_DEFAULT_UNIQUE_MODEL_ID,
  XUELANG_PROVIDER_ID,
  XUELANG_PROVIDER_NAME
} from '@shared/data/presets/xuelang'
import { DEFAULT_ASSISTANT_SETTINGS } from '@shared/data/types/assistant'
import { setupTestDatabase } from '@test-helpers/db'
import { and, asc, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'

describe('XuelangDefaultModelSeeder', () => {
  const dbh = setupTestDatabase()

  function readPreference(key: string) {
    return dbh.db
      .select()
      .from(preferenceTable)
      .where(and(eq(preferenceTable.scope, 'default'), eq(preferenceTable.key, key)))
      .limit(1)
      .then((rows) => rows[0]?.value)
  }

  it('seeds the enabled provider, default model, and missing model preferences', async () => {
    new XuelangDefaultModelSeeder().run(dbh.db)

    const [provider] = await dbh.db
      .select()
      .from(userProviderTable)
      .where(eq(userProviderTable.providerId, XUELANG_PROVIDER_ID))
      .limit(1)
    const [model] = await dbh.db
      .select()
      .from(userModelTable)
      .where(eq(userModelTable.id, XUELANG_DEFAULT_UNIQUE_MODEL_ID))
      .limit(1)

    expect(provider).toMatchObject({
      providerId: XUELANG_PROVIDER_ID,
      presetProviderId: XUELANG_PROVIDER_ID,
      name: XUELANG_PROVIDER_NAME,
      isEnabled: true
    })
    expect(model).toMatchObject({
      id: XUELANG_DEFAULT_UNIQUE_MODEL_ID,
      providerId: XUELANG_PROVIDER_ID,
      modelId: 'Qwen3.8-27B',
      presetModelId: XUELANG_DEFAULT_PRESET_MODEL_ID,
      contextWindow: 32768,
      isEnabled: true,
      isHidden: false
    })

    for (const key of XUELANG_DEFAULT_MODEL_PREFERENCE_KEYS) {
      expect(await readPreference(key)).toBe(XUELANG_DEFAULT_UNIQUE_MODEL_ID)
    }
  })

  it('places the Xuelang provider first when adding it to an existing installation', async () => {
    await dbh.db.insert(userProviderTable).values({
      providerId: 'openai',
      name: 'OpenAI',
      orderKey: generateOrderKeyBetween(null, null)
    })

    new XuelangDefaultModelSeeder().run(dbh.db)

    const providers = await dbh.db.select().from(userProviderTable).orderBy(asc(userProviderTable.orderKey))

    expect(providers.map((provider) => provider.providerId)).toEqual([XUELANG_PROVIDER_ID, 'openai'])
  })

  it('is idempotent and preserves existing provider and preference choices', async () => {
    await dbh.db.insert(userProviderTable).values({
      providerId: XUELANG_PROVIDER_ID,
      presetProviderId: XUELANG_PROVIDER_ID,
      name: '用户命名的雪浪供应商',
      orderKey: generateOrderKeyBetween(null, null)
    })
    await dbh.db.insert(preferenceTable).values({
      scope: 'default',
      key: 'chat.default_model_id',
      value: 'openai::gpt-4o'
    })

    const seeder = new XuelangDefaultModelSeeder()
    seeder.run(dbh.db)
    seeder.run(dbh.db)

    const providers = await dbh.db
      .select()
      .from(userProviderTable)
      .where(eq(userProviderTable.providerId, XUELANG_PROVIDER_ID))
    const models = await dbh.db.select().from(userModelTable).where(eq(userModelTable.providerId, XUELANG_PROVIDER_ID))

    expect(providers).toHaveLength(1)
    expect(providers[0].name).toBe('用户命名的雪浪供应商')
    expect(models).toHaveLength(1)
    expect(await readPreference('chat.default_model_id')).toBe('openai::gpt-4o')
  })

  it('migrates CherryAI defaults and assistants while preserving custom choices', async () => {
    const xuelangOrderKey = generateOrderKeyBetween(null, null)
    const cherryOrderKey = generateOrderKeyBetween(xuelangOrderKey, null)
    await dbh.db.insert(userProviderTable).values({
      providerId: CHERRYAI_PROVIDER_ID,
      presetProviderId: CHERRYAI_PROVIDER_ID,
      name: 'CherryAI',
      orderKey: cherryOrderKey,
      isEnabled: true
    })
    await dbh.db.insert(userModelTable).values({
      id: CHERRYAI_DEFAULT_UNIQUE_MODEL_ID,
      providerId: CHERRYAI_PROVIDER_ID,
      modelId: CHERRYAI_DEFAULT_MODEL_ID,
      name: 'Qwen',
      capabilities: [],
      supportsStreaming: true,
      orderKey: generateOrderKeyBetween(null, null),
      isEnabled: true,
      isHidden: false
    })
    await dbh.db.insert(preferenceTable).values([
      {
        scope: 'default',
        key: 'chat.default_model_id',
        value: CHERRYAI_DEFAULT_UNIQUE_MODEL_ID
      },
      {
        scope: 'default',
        key: 'feature.quick_assistant.model_id',
        value: 'openai::gpt-4o'
      }
    ])
    await dbh.db.insert(assistantTable).values({
      name: 'CherryAI 助手',
      emoji: 'AI',
      modelId: CHERRYAI_DEFAULT_UNIQUE_MODEL_ID,
      settings: DEFAULT_ASSISTANT_SETTINGS,
      orderKey: generateOrderKeyBetween(null, null)
    })

    new XuelangDefaultModelSeeder().run(dbh.db)

    const [cherryProvider] = await dbh.db
      .select()
      .from(userProviderTable)
      .where(eq(userProviderTable.providerId, CHERRYAI_PROVIDER_ID))
    const [cherryModel] = await dbh.db
      .select()
      .from(userModelTable)
      .where(eq(userModelTable.id, CHERRYAI_DEFAULT_UNIQUE_MODEL_ID))
    const [assistant] = await dbh.db.select().from(assistantTable).limit(1)

    expect(cherryProvider.isEnabled).toBe(false)
    expect(cherryModel).toMatchObject({ isEnabled: false, isHidden: true })
    expect(assistant.modelId).toBe(XUELANG_DEFAULT_UNIQUE_MODEL_ID)
    expect(await readPreference('chat.default_model_id')).toBe(XUELANG_DEFAULT_UNIQUE_MODEL_ID)
    expect(await readPreference('feature.quick_assistant.model_id')).toBe('openai::gpt-4o')
    expect(await readPreference('feature.translate.model_id')).toBe(XUELANG_DEFAULT_UNIQUE_MODEL_ID)
  })

  it('restores the managed Xuelang provider and model state', async () => {
    await dbh.db.insert(userProviderTable).values({
      providerId: XUELANG_PROVIDER_ID,
      presetProviderId: XUELANG_PROVIDER_ID,
      name: XUELANG_PROVIDER_NAME,
      orderKey: generateOrderKeyBetween(null, null),
      isEnabled: false
    })
    await dbh.db.insert(userModelTable).values({
      id: XUELANG_DEFAULT_UNIQUE_MODEL_ID,
      providerId: XUELANG_PROVIDER_ID,
      modelId: 'Qwen3.8-27B',
      presetModelId: XUELANG_DEFAULT_PRESET_MODEL_ID,
      orderKey: generateOrderKeyBetween(null, null),
      isEnabled: false,
      isHidden: true,
      isDeprecated: true
    })

    new XuelangDefaultModelSeeder().run(dbh.db)

    const [provider] = await dbh.db
      .select()
      .from(userProviderTable)
      .where(eq(userProviderTable.providerId, XUELANG_PROVIDER_ID))
    const [model] = await dbh.db
      .select()
      .from(userModelTable)
      .where(eq(userModelTable.id, XUELANG_DEFAULT_UNIQUE_MODEL_ID))

    expect(provider.isEnabled).toBe(true)
    expect(model).toMatchObject({ isEnabled: true, isHidden: false, isDeprecated: false })
  })

  it('repairs the previously seeded normalized model ID', async () => {
    const legacyModelId = 'xuelang::qwen3-8-27b'
    await dbh.db.insert(userProviderTable).values({
      providerId: XUELANG_PROVIDER_ID,
      presetProviderId: XUELANG_PROVIDER_ID,
      name: XUELANG_PROVIDER_NAME,
      orderKey: generateOrderKeyBetween(null, null)
    })
    await dbh.db.insert(userModelTable).values({
      id: legacyModelId,
      providerId: XUELANG_PROVIDER_ID,
      modelId: 'qwen3-8-27b',
      presetModelId: 'qwen3-8-27b',
      orderKey: generateOrderKeyBetween(null, null)
    })
    await dbh.db.insert(preferenceTable).values({
      scope: 'default',
      key: 'chat.default_model_id',
      value: legacyModelId
    })
    await dbh.db.insert(assistantTable).values({
      name: '工匠助手',
      emoji: '😀',
      modelId: legacyModelId,
      settings: DEFAULT_ASSISTANT_SETTINGS,
      orderKey: generateOrderKeyBetween(null, null)
    })

    new XuelangDefaultModelSeeder().run(dbh.db)

    const [legacyModel] = await dbh.db.select().from(userModelTable).where(eq(userModelTable.id, legacyModelId))
    const [assistant] = await dbh.db.select().from(assistantTable).limit(1)

    expect(legacyModel).toMatchObject({ isEnabled: false, isHidden: true })
    expect(assistant.modelId).toBe(XUELANG_DEFAULT_UNIQUE_MODEL_ID)
    expect(await readPreference('chat.default_model_id')).toBe(XUELANG_DEFAULT_UNIQUE_MODEL_ID)
  })
})
