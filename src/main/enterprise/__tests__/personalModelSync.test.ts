import { resolve } from 'node:path'

import { setupTestDatabase } from '@test-helpers/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { application } from '@application'
import { userProviderTable } from '@data/db/schemas/userProvider'
import { modelService } from '@data/services/ModelService'
import { providerRegistryService } from '@data/services/ProviderRegistryService'
import { providerService } from '@data/services/ProviderService'
import { generateOrderKeyBetween } from '@data/services/utils/orderKey'

import { applyPersonalModelSnapshot } from '../personalModelSync'

vi.mock('@main/utils/appEdition', () => ({ getAppEdition: () => 'global' }))

const identity = { serverInstanceId: 'server', userId: '7' }
const assignment = {
  id: '42',
  name: 'Cowork',
  apiKey: 'test-assigned-key',
  defaultChatEndpoint: 'openai-responses',
  endpointConfigs: { 'openai-responses': { baseUrl: 'https://gateway.example/v1' } },
  models: [{ id: 'assigned-model', endpointTypes: ['openai-responses'] }]
}
const snapshot = { ...identity, tenantId: '9', providers: [assignment] }

describe('personal Xuelang model sync', () => {
  const db = setupTestDatabase()

  beforeEach(() => {
    providerRegistryService.clearCache()
    vi.mocked(application.getPath).mockImplementation((key: string, filename?: string) =>
      key === 'feature.provider_registry.data' && filename
        ? resolve('packages/provider-registry/data', filename)
        : `/mock/${key}`
    )
    db.db
      .insert(userProviderTable)
      .values({
        providerId: 'xuelang',
        name: '雪浪工匠',
        orderKey: generateOrderKeyBetween(null, null),
        endpointConfigs: { 'openai-responses': { baseUrl: 'https://api.xuelanglm.com/v1' } },
        apiKeys: [{ id: 'local', key: 'test-local-key', isEnabled: true }]
      })
      .run()
  })

  it('uses the existing provider, then removes revoked credentials and disables the model on an empty snapshot', () => {
    expect(applyPersonalModelSnapshot(snapshot, identity)).toBe(1)
    expect(providerService.getApiKeys('xuelang', { enabled: true }).map(({ id }) => id)).toEqual(['cowork:9:42'])
    expect(modelService.getByKey('xuelang', 'assigned-model').isEnabled).toBe(true)
    expect(providerService.getByProviderId('xuelang').endpointConfigs?.['openai-responses']?.baseUrl).toBe(
      'https://gateway.example/v1'
    )

    expect(applyPersonalModelSnapshot({ ...snapshot, providers: [] }, identity)).toBe(0)
    expect(providerService.getApiKeys('xuelang')).toEqual([{ id: 'local', key: 'test-local-key', isEnabled: false }])
    expect(modelService.getByKey('xuelang', 'assigned-model').isEnabled).toBe(false)
  })

  it('rejects different model permissions before updating the existing configuration', () => {
    const other = { ...assignment, id: '43', models: [] }
    expect(() => applyPersonalModelSnapshot({ ...snapshot, providers: [assignment, other] }, identity)).toThrow(
      'different model permissions'
    )
    expect(providerService.getApiKeys('xuelang', { enabled: true }).map(({ id }) => id)).toEqual(['local'])
  })
})
