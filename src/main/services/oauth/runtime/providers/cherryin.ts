import { type SystemProviderId,SystemProviderIds } from '@shared/utils/systemProviderId'
import { net } from 'electron'

import {
  ApiKeysResponseSchema,
  CHERRYIN_CONFIG,
  GATEWAY_OAUTH_CONFIGS,
  isGatewayProviderId,
  validateGatewayApiHost
} from '../../CherryInOAuthConfig'
import { OAuthServiceError } from '../../errors'
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
      throw new OAuthServiceError(`Failed to fetch API keys: ${response.status}`)
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
      const tokenHost = context?.oauthServer ?? apiHost
      return new PkceOAuthClient({
        clientId: gatewayConfig.CLIENT_ID,
        authorizeUrl: `${oauthServer}/oauth2/auth`,
        tokenUrl: `${tokenHost}/oauth2/token`,
        redirectUri: gatewayConfig.REDIRECT_URI,
        scope: gatewayConfig.SCOPES
      })
    },
    afterPersistTokens: async (tokenData, context) => {
      const { apiHost } = resolveContext(context)
      return { apiKeys: await fetchApiKeys(tokenData.access_token, apiHost) }
    }
  } satisfies OAuthRuntimeProviderDefinition
}

/** @deprecated Legacy CherryIN-only export; the registry now uses the factory. */
export const cherryInOAuthProvider = createGatewayOAuthProvider(SystemProviderIds.cherryin)

// Keep the legacy import surface honest — CHERRYIN_CONFIG is still read here.
void CHERRYIN_CONFIG
