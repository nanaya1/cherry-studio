import * as z from 'zod'

/**
 * Per-provider gateway OAuth configuration. CherryIN and 雪浪工匠 ride the same
 * gateway stack, so every provider shares the PKCE contract (client_id /
 * redirect / scopes) and differs only in the allowed API hosts. Update the
 * xuelang hosts when the production auth server domain lands.
 */
export const GATEWAY_OAUTH_CONFIGS = {
  cherryin: {
    CLIENT_ID: '2a348c87-bae1-4756-a62f-b2e97200fd6d',
    ALLOWED_HOSTS: ['https://open.cherryin.ai', 'https://open.cherryin.dev'],
    REDIRECT_URI: 'meacowork://oauth/callback',
    SCOPES: 'openid profile email offline_access balance:read usage:read tokens:read tokens:write'
  },
  xuelang: {
    CLIENT_ID: '2a348c87-bae1-4756-a62f-b2e97200fd6d',
    ALLOWED_HOSTS: ['https://api.xuelanglm.com'],
    REDIRECT_URI: 'meacowork://oauth/callback',
    SCOPES: 'openid profile email offline_access balance:read usage:read tokens:read tokens:write'
  }
} as const

export type GatewayProviderId = keyof typeof GATEWAY_OAUTH_CONFIGS

export const isGatewayProviderId = (providerId: string): providerId is GatewayProviderId =>
  providerId in GATEWAY_OAUTH_CONFIGS

/** @deprecated Legacy CherryIN-only alias; prefer {@link GATEWAY_OAUTH_CONFIGS}. */
export const CHERRYIN_CONFIG = GATEWAY_OAUTH_CONFIGS.cherryin

export function validateGatewayApiHost(providerId: GatewayProviderId, apiHost: string): void {
  if (!(GATEWAY_OAUTH_CONFIGS[providerId].ALLOWED_HOSTS as readonly string[]).includes(apiHost)) {
    throw new CherryInOAuthServiceError(`Unauthorized API host: ${apiHost}`)
  }
}

/** @deprecated CherryIN-only host validation; prefer {@link validateGatewayApiHost}. */
export function validateCherryInApiHost(apiHost: string): void {
  validateGatewayApiHost('cherryin', apiHost)
}

export class CherryInOAuthServiceError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly code?: string
  ) {
    super(message)
    this.name = 'CherryInOAuthServiceError'
  }
}

const ApiKeyItemSchema = z
  .union([z.string(), z.object({ key: z.string() }), z.object({ token: z.string() })])
  .transform((item): string => {
    if (typeof item === 'string') return item
    if ('key' in item) return item.key
    return item.token
  })

export const ApiKeysResponseSchema = z
  .union([z.array(ApiKeyItemSchema), z.object({ data: z.array(ApiKeyItemSchema) })])
  .transform((data): string[] => (Array.isArray(data) ? data : data.data))
