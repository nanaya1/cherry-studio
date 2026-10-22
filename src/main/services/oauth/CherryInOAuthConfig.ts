import * as z from 'zod'

import { XUELANG_API_HOST } from '@shared/utils/constants'

const CHERRYIN_CONFIG = {
  CLIENT_ID: '2a348c87-bae1-4756-a62f-b2e97200fd6d',
  ALLOWED_HOSTS: ['https://open.cherryin.ai', 'https://open.cherryin.dev'],
  REDIRECT_URI: 'http://127.0.0.1:29873/oauth/callback',
  CALLBACK_PORT: 29873,
  CALLBACK_PATH: '/oauth/callback',
  SCOPES: 'openid profile email offline_access balance:read usage:read tokens:read tokens:write'
} as const

const XUELANG_CONFIG = {
  CLIENT_ID: CHERRYIN_CONFIG.CLIENT_ID,
  ALLOWED_HOSTS: [XUELANG_API_HOST],
  // REDIRECT_URI: 'meacowork://oauth/callback',
  REDIRECT_URI: 'meacowork-enterprise://oauth/callback',
  SCOPES: 'profile email offline_access balance:read usage:read tokens:read tokens:write'
} as const

export const GATEWAY_OAUTH_CONFIGS = {
  cherryin: CHERRYIN_CONFIG,
  xuelang: XUELANG_CONFIG
} as const

export type GatewayProviderId = keyof typeof GATEWAY_OAUTH_CONFIGS

export const isGatewayProviderId = (providerId: string): providerId is GatewayProviderId =>
  providerId in GATEWAY_OAUTH_CONFIGS

export { CHERRYIN_CONFIG }

export function validateGatewayApiHost(providerId: GatewayProviderId, apiHost: string): void {
  if (!(GATEWAY_OAUTH_CONFIGS[providerId].ALLOWED_HOSTS as readonly string[]).includes(apiHost)) {
    throw new CherryInOAuthServiceError(`Unauthorized API host: ${apiHost}`)
  }
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

export function validateCherryInApiHost(apiHost: string): void {
  if (!(CHERRYIN_CONFIG.ALLOWED_HOSTS as readonly string[]).includes(apiHost)) {
    throw new CherryInOAuthServiceError(`Unauthorized API host: ${apiHost}`)
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
