import { and, eq, isNull, sql } from 'drizzle-orm'
import * as z from 'zod'

import { application } from '@application'
import { notifyDataApiDataChange } from '@data/dataApiDataChange'
import { userModelTable } from '@data/db/schemas/userModel'
import { modelService } from '@data/services/ModelService'
import { providerRegistryService } from '@data/services/ProviderRegistryService'
import { providerService } from '@data/services/ProviderService'
import { XUELANG_PROVIDER_ID } from '@shared/data/presets/xuelang'
import { parseUniqueModelId } from '@shared/data/types/model'

const endpointSchema = z.enum(['openai-responses', 'anthropic-messages', 'google-generate-content'])
const snapshotSchema = z.object({
  serverInstanceId: z.string().min(1),
  userId: z.string().min(1),
  tenantId: z.string().regex(/^[1-9][0-9]*$/),
  providers: z
    .array(
      z.object({
        id: z.string().regex(/^[1-9][0-9]*$/),
        name: z.string().min(1),
        apiKey: z.string().trim().min(1),
        defaultChatEndpoint: endpointSchema,
        endpointConfigs: z.record(z.string(), z.object({ baseUrl: z.string() })),
        models: z.array(z.object({ id: z.string().min(1), endpointTypes: z.array(endpointSchema) })).max(4000)
      })
    )
    .max(100)
})

function modelBaseUrl(raw: string | undefined): string {
  const url = URL.parse(raw ?? '')
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Cowork returned an invalid model API address')
  }
  return url.href.replace(/\/+$/, '')
}

export function applyPersonalModelSnapshot(
  value: unknown,
  identity: { serverInstanceId: string; userId: string }
): number {
  const parsed = snapshotSchema.safeParse(value)
  if (!parsed.success) throw new Error('Invalid Cowork model configuration')
  const snapshot = parsed.data
  if (snapshot.serverInstanceId !== identity.serverInstanceId || snapshot.userId !== identity.userId) {
    throw new Error('Cowork model configuration belongs to another account')
  }

  const providerId = XUELANG_PROVIDER_ID
  const provider = providerService.getByProviderId(providerId)
  const first = snapshot.providers[0]
  const endpoint = first?.defaultChatEndpoint
  const baseUrl = endpoint ? modelBaseUrl(first.endpointConfigs[endpoint]?.baseUrl) : undefined
  const modelIds = new Set(first?.models.map(({ id }) => id))
  if (endpoint && baseUrl) {
    if (new Set(snapshot.providers.map(({ id }) => id)).size !== snapshot.providers.length) {
      throw new Error('Cowork returned duplicate key assignments')
    }
    if (snapshot.providers.some((entry) => entry.defaultChatEndpoint !== endpoint)) {
      throw new Error('Cowork key assignments use different model protocols')
    }
    if (snapshot.providers.some((entry) => modelBaseUrl(entry.endpointConfigs[endpoint]?.baseUrl) !== baseUrl)) {
      throw new Error('Cowork key assignments use different API addresses')
    }
    if (
      snapshot.providers.some(
        (entry) =>
          entry.models.length !== modelIds.size ||
          new Set(entry.models.map(({ id }) => id)).size !== modelIds.size ||
          entry.models.some(({ id, endpointTypes }) => !modelIds.has(id) || !endpointTypes.includes(endpoint))
      )
    ) {
      throw new Error('Cowork key assignments have different model permissions')
    }
  }

  const existingIds = new Set(modelService.list({ providerId }).map(({ id }) => parseUniqueModelId(id).modelId))
  const syncedModels = endpoint
    ? [...modelIds].map((modelId) => ({
        dto: { providerId, modelId, endpointTypes: [endpoint] },
        registryData: providerRegistryService.lookupModel(providerId, modelId)
      }))
    : []

  application.get('DbService').withWriteTx((tx) => {
    // MEA:personal-profile-startup Legacy sync stored empty capabilities without a preset.
    for (const { dto, registryData } of syncedModels) {
      if (!existingIds.has(dto.modelId) || !registryData.presetModel) continue
      tx.update(userModelTable)
        .set({ presetModelId: registryData.presetModel.id, capabilities: null })
        .where(
          and(
            eq(userModelTable.providerId, providerId),
            eq(userModelTable.modelId, dto.modelId),
            isNull(userModelTable.presetModelId),
            eq(userModelTable.inputModalitiesExplicit, false),
            sql`json_array_length(${userModelTable.capabilities}) = 0`
          )
        )
        .run()
    }
    modelService.create(syncedModels.filter(({ dto }) => !existingIds.has(dto.modelId)))
    for (const modelId of new Set([...existingIds, ...modelIds])) {
      const enabled = modelIds.has(modelId)
      modelService.update(providerId, modelId, {
        isEnabled: enabled,
        ...(enabled && endpoint ? { endpointTypes: [endpoint] } : {})
      })
    }
    const syncedKeys = new Set(snapshot.providers.map(({ apiKey }) => apiKey))
    const localKeys = providerService
      .getApiKeys(providerId)
      .filter(({ id, key }) => !id.startsWith('cowork:') && !syncedKeys.has(key))
    providerService.replaceApiKeys(providerId, [
      ...localKeys.map((key) => ({ ...key, isEnabled: false })),
      ...snapshot.providers.map((entry) => ({
        id: `cowork:${snapshot.tenantId}:${entry.id}`,
        key: entry.apiKey,
        label: entry.name,
        isEnabled: true
      }))
    ])
    providerService.update(providerId, {
      isEnabled: modelIds.size > 0,
      ...(endpoint && baseUrl
        ? {
            defaultChatEndpoint: endpoint,
            endpointConfigs: {
              ...provider.endpointConfigs,
              [endpoint]: { ...provider.endpointConfigs?.[endpoint], baseUrl }
            }
          }
        : {})
    })
  })
  notifyDataApiDataChange([
    { endpoint: '/providers', kind: 'projection' },
    { endpoint: '/providers/:providerId', routeParams: { providerId } },
    { endpoint: '/providers/:providerId/api-keys', routeParams: { providerId } },
    { endpoint: '/models', kind: 'membership' }
  ])
  return modelIds.size
}
