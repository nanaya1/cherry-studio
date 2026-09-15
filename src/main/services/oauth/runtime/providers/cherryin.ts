import { type SystemProviderId, SystemProviderIds } from '@shared/utils/systemProviderId'
import { net } from 'electron'

import {
  ApiKeysResponseSchema,
  CHERRYIN_CONFIG,
  GATEWAY_OAUTH_CONFIGS,
  isGatewayProviderId,
  validateGatewayApiHost
} from '../../CherryInOAuthConfig'
import { OAuthServiceError, OAuthTransientError } from '../../errors'
import { PkceOAuthClient } from '../PkceOAuthClient'
import type { OAuthRuntimeProviderContext, OAuthRuntimeProviderDefinition } from '../types'

/**
 * One gateway OAuth implementation shared by every gateway provider (CherryIN,
 * 雪浪工匠, …): identical PKCE contract, per-provider allowed hosts. The
 * renderer picks the flow with `providerId` + `oauthServer`/`apiHost`.
 */
export function createGatewayOAuthProvider(providerId: SystemProviderId | string): OAuthRuntimeProviderDefinition {
  if (!isGatewayProviderId(providerId)) {
    throw new OAuthServiceError(`No gateway OAuth config for provider: ${providerId}`)
  }
  const gatewayConfig = GATEWAY_OAUTH_CONFIGS[providerId]

  const resolveContext = (context?: OAuthRuntimeProviderContext): { oauthServer: string; apiHost: string } => {
    // Snowwave uses one fixed service origin until sub2api publishes its final
    // client registration. Do not let renderer input redirect this identity.
    if (providerId === SystemProviderIds.xuelang) {
      const [oauthServer] = gatewayConfig.ALLOWED_HOSTS
      return { oauthServer, apiHost: oauthServer }
    }

    const oauthServer = context?.oauthServer ?? gatewayConfig.ALLOWED_HOSTS[0]
    validateGatewayApiHost(providerId, oauthServer)

    const apiHost = context?.apiHost ?? oauthServer
    validateGatewayApiHost(providerId, apiHost)
    return { oauthServer, apiHost }
  }

  const fetchApiKeys = async (accessToken: string, apiHost: string): Promise<string> => {
    const response = await net.fetch(`${apiHost}/api/v1/oauth/tokens`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` }
    })

    if (!response.ok) {
      if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
        throw new OAuthTransientError(`Failed to fetch API keys temporarily: ${response.status}`)
      }

      let code: string | undefined
      try {
        const body = (await response.clone().json()) as { code?: unknown; error?: { code?: unknown } }
        const candidate = body.code ?? body.error?.code
        if (typeof candidate === 'string') code = candidate
      } catch {
        // Keep the HTTP error when the provider returns a non-JSON body.
      }

      throw new OAuthServiceError(`Failed to fetch API keys: ${response.status}`, undefined, code)
    }

    const keysArray = ApiKeysResponseSchema.parse(await response.json())
    const apiKeys = keysArray.filter(Boolean).join(',')
    if (!apiKeys) {
      throw new OAuthServiceError('No API keys received')
    }
    return apiKeys
  }

  return {
    providerId,
    clientId: gatewayConfig.CLIENT_ID,
    transport: { type: 'deep-link', config: { redirectUri: gatewayConfig.REDIRECT_URI } },
    createClient: (context?: OAuthRuntimeProviderContext) => {
      const { oauthServer, apiHost } = resolveContext(context)
      const tokenHost = providerId === SystemProviderIds.xuelang ? oauthServer : (context?.oauthServer ?? apiHost)
      return new PkceOAuthClient({
        clientId: gatewayConfig.CLIENT_ID,
        authorizeUrl: `${oauthServer}/oauth2/auth`,
        tokenUrl: `${tokenHost}/oauth2/token`,
        redirectUri: gatewayConfig.REDIRECT_URI,
        scope: gatewayConfig.SCOPES,
        requireGatewayTokenResponse: providerId === SystemProviderIds.xuelang
      })
    },
    afterPersistTokens: async (tokenData, context) => {
      const { apiHost } = resolveContext(context)
      return { apiKeys: await fetchApiKeys(tokenData.access_token, apiHost) }
    },
    provisionApiKeys: async (accessToken, context) => {
      const { apiHost } = resolveContext(context)
      return fetchApiKeys(accessToken, apiHost)
    }
  } satisfies OAuthRuntimeProviderDefinition
}

/** @deprecated Legacy CherryIN-only export; the registry now uses the factory. */
export const cherryInOAuthProvider = createGatewayOAuthProvider(SystemProviderIds.cherryin)

// Keep the legacy import surface honest — CHERRYIN_CONFIG is still read here.
void CHERRYIN_CONFIG
