import { net } from 'electron'

import { type SystemProviderId, SystemProviderIds } from '@shared/utils/systemProviderId'

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

const API_KEYS_HTTP_TIMEOUT_MS = 30_000

export interface CherryInOAuthContext extends OAuthRuntimeProviderContext {
  oauthServer?: string
  apiHost?: string
}

export interface CherryInSignInResult {
  accountId: string | null
  apiKeys: string
}

function resolveGatewayContext(
  providerId: keyof typeof GATEWAY_OAUTH_CONFIGS,
  context?: OAuthRuntimeProviderContext
): { oauthServer: string; apiHost: string } {
  const config = GATEWAY_OAUTH_CONFIGS[providerId]
  if (providerId === SystemProviderIds.xuelang) {
    const [oauthServer] = config.ALLOWED_HOSTS
    return { oauthServer, apiHost: oauthServer }
  }

  const oauthServer = context?.oauthServer ?? config.ALLOWED_HOSTS[0]
  validateGatewayApiHost(providerId, oauthServer)
  const apiHost = context?.apiHost ?? oauthServer
  validateGatewayApiHost(providerId, apiHost)
  return { oauthServer, apiHost }
}

async function fetchCherryInApiKeys(accessToken: string, apiHost: string): Promise<string> {
  const response = await net.fetch(`${apiHost}/api/v1/oauth/tokens`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(API_KEYS_HTTP_TIMEOUT_MS)
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

export function createGatewayOAuthProvider(providerId: SystemProviderId | string): OAuthRuntimeProviderDefinition {
  if (!isGatewayProviderId(providerId)) {
    throw new OAuthServiceError(`No gateway OAuth config for provider: ${providerId}`)
  }
  const config = GATEWAY_OAUTH_CONFIGS[providerId]
  const isXuelang = providerId === SystemProviderIds.xuelang
  const transport = isXuelang
    ? { type: 'deep-link' as const, config: { redirectUri: config.REDIRECT_URI } }
    : {
        type: 'loopback' as const,
        config: {
          hosts: ['127.0.0.1'],
          port: CHERRYIN_CONFIG.CALLBACK_PORT,
          path: CHERRYIN_CONFIG.CALLBACK_PATH,
          redirectUri: CHERRYIN_CONFIG.REDIRECT_URI
        }
      }

  return {
    providerId,
    clientId: config.CLIENT_ID,
    transport,
    createClient: (context?: OAuthRuntimeProviderContext) => {
      const { oauthServer, apiHost } = resolveGatewayContext(providerId, context)
      const tokenHost = isXuelang ? oauthServer : (context?.oauthServer ?? apiHost)
      return new PkceOAuthClient({
        clientId: config.CLIENT_ID,
        authorizeUrl: `${oauthServer}/oauth2/auth`,
        tokenUrl: `${tokenHost}/oauth2/token`,
        redirectUri: config.REDIRECT_URI,
        scope: config.SCOPES,
        requireGatewayTokenResponse: isXuelang
      })
    },
    afterPersistTokens: async (tokenData, context) => {
      const { apiHost } = resolveGatewayContext(providerId, context)
      return { apiKeys: await fetchCherryInApiKeys(tokenData.access_token, apiHost) }
    },
    provisionApiKeys: async (accessToken, context) => {
      const { apiHost } = resolveGatewayContext(providerId, context)
      return fetchCherryInApiKeys(accessToken, apiHost)
    }
  } satisfies OAuthRuntimeProviderDefinition
}

export const cherryInOAuthProvider = createGatewayOAuthProvider(SystemProviderIds.cherryin)
export const xuelangOAuthProvider = createGatewayOAuthProvider(SystemProviderIds.xuelang)
