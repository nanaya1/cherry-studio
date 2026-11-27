/**
 * Provider API Handlers
 *
 * Implements all provider-related API endpoints including:
 * - Provider CRUD operations
 * - Listing with filters
 */

import { notifyDataApiDataChange } from '@data/dataApiDataChange'
import { providerRegistryService } from '@data/services/ProviderRegistryService'
import { hasCurrentXuelangSnapshot, providerService } from '@data/services/ProviderService'
import { DataApiErrorFactory } from '@shared/data/api/errors'
import { OrderBatchRequestSchema, OrderRequestSchema } from '@shared/data/api/schemas/_endpointHelpers'
import {
  AddProviderApiKeySchema,
  CreateProviderSchema,
  ListProviderApiKeysQuerySchema,
  ListProvidersQuerySchema,
  ProviderPresetQuerySchema,
  type ProviderSchemas,
  ReplaceProviderApiKeysSchema,
  UpdateApiKeySchema,
  UpdateProviderSchema
} from '@shared/data/api/schemas/providers'
import type { HandlersFor } from '@shared/data/api/types'
import { XUELANG_PROVIDER_ID } from '@shared/data/presets/xuelang'
import { RuntimeApiKeySchema } from '@shared/data/types/provider'

function assertProviderWritable(providerId: string, operation: string): void {
  if (providerId === XUELANG_PROVIDER_ID) {
    throw DataApiErrorFactory.invalidOperation(operation, 'managed provider configuration is read-only')
  }
}

function assertProviderToggleOnly(providerId: string, patch: { isEnabled?: boolean }, operation: string): void {
  if (typeof patch.isEnabled !== 'boolean' || Object.keys(patch).length !== 1) {
    assertProviderWritable(providerId, operation)
  }
}

export const providerHandlers: HandlersFor<ProviderSchemas> = {
  '/providers': {
    GET: async ({ query }) => {
      const parsed = ListProvidersQuerySchema.parse(query ?? {})
      return providerService.list(parsed)
    },

    POST: async ({ body }) => {
      const parsed = CreateProviderSchema.parse(body)
      assertProviderWritable(parsed.providerId, 'create provider')
      return providerService.create(parsed)
    }
  },

  '/providers/:providerId': {
    GET: async ({ params }) => {
      return providerService.getByProviderId(params.providerId)
    },

    PATCH: async ({ params, body }) => {
      const parsed = UpdateProviderSchema.parse(body)
      assertProviderToggleOnly(params.providerId, parsed, 'update provider')
      if (params.providerId === XUELANG_PROVIDER_ID && !hasCurrentXuelangSnapshot()) {
        throw DataApiErrorFactory.invalidOperation('update provider', 'No account configuration has been synchronized')
      }
      return providerService.update(params.providerId, parsed)
    },

    DELETE: async ({ params }) => {
      assertProviderWritable(params.providerId, 'delete provider')
      providerService.delete(params.providerId)
      return undefined
    }
  },

  '/providers/:providerId/api-keys': {
    GET: async ({ params, query }) => {
      const parsed = ListProviderApiKeysQuerySchema.parse(query ?? {})
      const keys = providerService.getApiKeys(params.providerId, parsed)
      if (params.providerId !== XUELANG_PROVIDER_ID) return { keys }

      // 领域服务只返回当前快照中的 Key；短密钥必须完全遮盖。
      return {
        keys: keys.map((entry) => ({
          ...RuntimeApiKeySchema.parse(entry),
          key: entry.key.length > 8 ? `${entry.key.slice(0, 2)}****${entry.key.slice(-4)}` : '****'
        }))
      }
    },

    POST: async ({ params, body }) => {
      assertProviderWritable(params.providerId, 'add API key')
      const parsed = AddProviderApiKeySchema.parse(body)
      return providerService.addApiKey(params.providerId, parsed.key, parsed.label)
    },

    PUT: async ({ params, body }) => {
      assertProviderWritable(params.providerId, 'replace API keys')
      const parsed = ReplaceProviderApiKeysSchema.parse(body)
      return providerService.replaceApiKeys(params.providerId, parsed.keys)
    }
  },

  '/providers/:providerId/auth-config': {
    GET: async ({ params }) => {
      const authConfig = providerService.getAuthConfig(params.providerId)
      // OAuth secrets never need to leave the main process — the renderer uses
      // `oauth.has_token` for the signed-in boolean. Whitelist only the
      // non-secret metadata (deny-by-default, so a future field can't leak a
      // secret by accident), while other auth kinds (iam-gcp/aws) still return
      // their config for the settings UI that edits them.
      if (authConfig?.type === 'oauth') {
        const { type, clientId, accountId, expiresAt } = authConfig
        return { type, clientId, accountId, expiresAt }
      }
      return authConfig
    }
  },

  '/providers/:providerId/preset': {
    GET: async ({ params, query }) => {
      const parsed = ProviderPresetQuerySchema.parse(query ?? {})
      const provider = providerService.getByProviderId(params.providerId)
      const fields = Array.isArray(parsed.fields) ? parsed.fields : [parsed.fields]
      return providerRegistryService.getProviderPreset(provider.id, fields, provider.presetProviderId ?? null)
    }
  },

  '/providers/:providerId/api-keys/:keyId': {
    PATCH: async ({ params, body }) => {
      const parsed = UpdateApiKeySchema.parse(body)
      assertProviderToggleOnly(params.providerId, parsed, 'update API key')
      const provider = providerService.updateApiKey(params.providerId, params.keyId, parsed)
      if (params.providerId === XUELANG_PROVIDER_ID) {
        notifyDataApiDataChange([{ endpoint: '/models', kind: 'membership' }])
      }
      return provider
    },

    DELETE: async ({ params }) => {
      assertProviderWritable(params.providerId, 'delete API key')
      return providerService.deleteApiKey(params.providerId, params.keyId)
    }
  },

  '/providers/:id/order': {
    PATCH: async ({ params, body }) => {
      const parsed = OrderRequestSchema.parse(body)
      assertProviderWritable(params.id, 'move provider')
      providerService.move(params.id, parsed)
      return undefined
    }
  },

  '/providers/order:batch': {
    PATCH: async ({ body }) => {
      const parsed = OrderBatchRequestSchema.parse(body)
      for (const { id } of parsed.moves) {
        assertProviderWritable(id, 'move provider')
      }
      providerService.reorder(parsed.moves)
      return undefined
    }
  }
}
